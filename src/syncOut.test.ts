import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { assert, describe, expect, it } from "vitest";
import { makeSandboxFromHandle } from "./SandboxFactory.js";
import { testIsolated } from "./sandboxes/test-isolated.js";
import { syncIn } from "./syncIn.js";
import { countCommitsToSync, syncOut } from "./syncOut.js";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const commitFile = async (
  dir: string,
  name: string,
  content: string,
  message: string,
) => {
  await writeFile(join(dir, name), content);
  await execAsync(`git add "${name}"`, { cwd: dir });
  await execAsync(`git commit -m "${message}"`, { cwd: dir });
};

const getLog = async (dir: string) => {
  const { stdout } = await execAsync("git log --oneline", { cwd: dir });
  return stdout.trim().split("\n");
};

describe("syncOut", () => {
  it("extracts a single commit from sandbox back to host", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "initial.txt", "initial", "initial commit");

    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      await Effect.runPromise(syncIn(hostDir, handle));

      // Make a commit inside the sandbox
      const wp = handle.worktreePath;
      await handle.exec('echo "new file" > new.txt', { cwd: wp });
      await handle.exec("git add new.txt", { cwd: wp });
      await handle.exec('git commit -m "add new file"', { cwd: wp });

      await Effect.runPromise(syncOut(hostDir, handle));

      // Verify the commit appears on host
      const log = await getLog(hostDir);
      expect(log).toHaveLength(2);
      expect(log[0]).toContain("add new file");

      // Verify file content
      const content = await readFile(join(hostDir, "new.txt"), "utf8");
      expect(content.trim()).toBe("new file");
    } finally {
      await handle.close();
    }
  });

  it("extracts multiple commits preserving order", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "initial.txt", "initial", "initial commit");

    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      await Effect.runPromise(syncIn(hostDir, handle));

      const wp = handle.worktreePath;
      await handle.exec('echo "a" > a.txt', { cwd: wp });
      await handle.exec("git add a.txt", { cwd: wp });
      await handle.exec('git commit -m "add a"', { cwd: wp });

      await handle.exec('echo "b" > b.txt', { cwd: wp });
      await handle.exec("git add b.txt", { cwd: wp });
      await handle.exec('git commit -m "add b"', { cwd: wp });

      await handle.exec('echo "c" > c.txt', { cwd: wp });
      await handle.exec("git add c.txt", { cwd: wp });
      await handle.exec('git commit -m "add c"', { cwd: wp });

      await Effect.runPromise(syncOut(hostDir, handle));

      const log = await getLog(hostDir);
      expect(log).toHaveLength(4); // initial + 3 new
      expect(log[0]).toContain("add c");
      expect(log[1]).toContain("add b");
      expect(log[2]).toContain("add a");
    } finally {
      await handle.close();
    }
  });

  it("is a no-op when sandbox has no new commits", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "initial.txt", "initial", "initial commit");

    const { stdout: hostHeadBefore } = await execAsync("git rev-parse HEAD", {
      cwd: hostDir,
    });

    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      await Effect.runPromise(syncIn(hostDir, handle));

      // No commits made — syncOut should be a no-op
      await Effect.runPromise(syncOut(hostDir, handle));

      const { stdout: hostHeadAfter } = await execAsync("git rev-parse HEAD", {
        cwd: hostDir,
      });
      expect(hostHeadAfter.trim()).toBe(hostHeadBefore.trim());
    } finally {
      await handle.close();
    }
  });

  it("handles empty/header-only patches from merge commits gracefully", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "initial.txt", "initial", "initial commit");

    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      await Effect.runPromise(syncIn(hostDir, handle));

      const wp = handle.worktreePath;

      // Create a branch, commit on it, switch back, commit on main, then merge
      await handle.exec("git checkout -b feature", { cwd: wp });
      await handle.exec('echo "feature" > feature.txt', { cwd: wp });
      await handle.exec("git add feature.txt", { cwd: wp });
      await handle.exec('git commit -m "feature commit"', { cwd: wp });

      await handle.exec("git checkout main", { cwd: wp });
      await handle.exec('echo "main-work" > main-work.txt', { cwd: wp });
      await handle.exec("git add main-work.txt", { cwd: wp });
      await handle.exec('git commit -m "main commit"', { cwd: wp });

      // Merge (creates a merge commit)
      await handle.exec("git merge feature --no-ff -m 'merge feature'", {
        cwd: wp,
      });

      // syncOut should handle the merge commit's empty patch
      await Effect.runPromise(syncOut(hostDir, handle));

      // All files should be present on host
      const mainWork = await readFile(join(hostDir, "main-work.txt"), "utf8");
      expect(mainWork.trim()).toBe("main-work");
      const feature = await readFile(join(hostDir, "feature.txt"), "utf8");
      expect(feature.trim()).toBe("feature");
    } finally {
      await handle.close();
    }
  });

  it("extracts uncommitted staged and unstaged changes to host", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "initial.txt", "initial", "initial commit");

    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      await Effect.runPromise(syncIn(hostDir, handle));

      const wp = handle.worktreePath;
      // Modify tracked file (unstaged change)
      await handle.exec('echo "modified content" > initial.txt', { cwd: wp });
      // Create and stage a new file
      await handle.exec('echo "staged file" > staged.txt', { cwd: wp });
      await handle.exec("git add staged.txt", { cwd: wp });

      await Effect.runPromise(syncOut(hostDir, handle));

      // Verify uncommitted changes appear on host
      const initialContent = await readFile(
        join(hostDir, "initial.txt"),
        "utf8",
      );
      expect(initialContent.trim()).toBe("modified content");

      const stagedContent = await readFile(join(hostDir, "staged.txt"), "utf8");
      expect(stagedContent.trim()).toBe("staged file");
    } finally {
      await handle.close();
    }
  });

  it("extracts untracked files from sandbox to host", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "initial.txt", "initial", "initial commit");

    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      await Effect.runPromise(syncIn(hostDir, handle));

      const wp = handle.worktreePath;
      // Create untracked files (not git-added)
      await handle.exec('echo "untracked1" > untracked1.txt', { cwd: wp });
      await handle.exec("mkdir -p subdir", { cwd: wp });
      await handle.exec('echo "untracked2" > subdir/untracked2.txt', {
        cwd: wp,
      });

      await Effect.runPromise(syncOut(hostDir, handle));

      // Verify untracked files appear on host
      const u1 = await readFile(join(hostDir, "untracked1.txt"), "utf8");
      expect(u1.trim()).toBe("untracked1");

      const u2 = await readFile(join(hostDir, "subdir/untracked2.txt"), "utf8");
      expect(u2.trim()).toBe("untracked2");
    } finally {
      await handle.close();
    }
  });

  it("extracts commits + uncommitted changes + untracked files together", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "initial.txt", "initial", "initial commit");

    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      await Effect.runPromise(syncIn(hostDir, handle));

      const wp = handle.worktreePath;

      // 1. Make a commit
      await handle.exec('echo "committed" > committed.txt', { cwd: wp });
      await handle.exec("git add committed.txt", { cwd: wp });
      await handle.exec('git commit -m "add committed file"', { cwd: wp });

      // 2. Leave uncommitted changes
      await handle.exec('echo "modified" > initial.txt', { cwd: wp });

      // 3. Leave untracked file
      await handle.exec('echo "brand new" > untracked.txt', { cwd: wp });

      await Effect.runPromise(syncOut(hostDir, handle));

      // Verify committed changes
      const log = await getLog(hostDir);
      expect(log).toHaveLength(2);
      expect(log[0]).toContain("add committed file");
      const committed = await readFile(join(hostDir, "committed.txt"), "utf8");
      expect(committed.trim()).toBe("committed");

      // Verify uncommitted changes
      const modified = await readFile(join(hostDir, "initial.txt"), "utf8");
      expect(modified.trim()).toBe("modified");

      // Verify untracked files
      const untracked = await readFile(join(hostDir, "untracked.txt"), "utf8");
      expect(untracked.trim()).toBe("brand new");
    } finally {
      await handle.close();
    }
  });

  it("aborts stale git am session before applying patches", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "initial.txt", "initial", "initial commit");

    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      await Effect.runPromise(syncIn(hostDir, handle));

      const wp = handle.worktreePath;
      await handle.exec('echo "new" > new.txt', { cwd: wp });
      await handle.exec("git add new.txt", { cwd: wp });
      await handle.exec('git commit -m "add new"', { cwd: wp });

      // Simulate a stale git am session on the host by creating rebase-apply dir
      await execAsync("mkdir -p .git/rebase-apply", { cwd: hostDir });
      await writeFile(join(hostDir, ".git/rebase-apply/applying"), "");

      // syncOut should succeed despite the stale session
      await Effect.runPromise(syncOut(hostDir, handle));

      const log = await getLog(hostDir);
      expect(log).toHaveLength(2);
      expect(log[0]).toContain("add new");
    } finally {
      await handle.close();
    }
  });

  it("successful sync-out leaves no patch artifacts in .sandcastle/patches", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "initial.txt", "initial", "initial commit");

    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      await Effect.runPromise(syncIn(hostDir, handle));

      const wp = handle.worktreePath;
      await handle.exec('echo "new file" > new.txt', { cwd: wp });
      await handle.exec("git add new.txt", { cwd: wp });
      await handle.exec('git commit -m "add new file"', { cwd: wp });

      // Also add uncommitted + untracked changes
      await handle.exec('echo "modified" > initial.txt', { cwd: wp });
      await handle.exec('echo "untracked" > untracked.txt', { cwd: wp });

      await Effect.runPromise(syncOut(hostDir, handle));

      // Verify sync worked
      const log = await getLog(hostDir);
      expect(log).toHaveLength(2);
      expect(log[0]).toContain("add new file");

      // Verify no patch artifacts remain
      const patchesDir = join(hostDir, ".sandcastle", "patches");
      expect(existsSync(patchesDir)).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it("successful sync-out preserves tracked .sandcastle files", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "initial.txt", "initial", "initial commit");

    // Commit tracked files inside .sandcastle, as a real repo would have
    await mkdir(join(hostDir, ".sandcastle"), { recursive: true });
    await commitFile(
      hostDir,
      join(".sandcastle", "prompt.md"),
      "prompt",
      "add .sandcastle config",
    );
    await commitFile(
      hostDir,
      join(".sandcastle", "Dockerfile"),
      "FROM node",
      "add Dockerfile",
    );

    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      await Effect.runPromise(syncIn(hostDir, handle));

      const wp = handle.worktreePath;
      await handle.exec('echo "new file" > new.txt', { cwd: wp });
      await handle.exec("git add new.txt", { cwd: wp });
      await handle.exec('git commit -m "add new file"', { cwd: wp });

      await Effect.runPromise(syncOut(hostDir, handle));

      // The whole .sandcastle dir must not be deleted by cleanup
      expect(existsSync(join(hostDir, ".sandcastle", "prompt.md"))).toBe(true);
      expect(existsSync(join(hostDir, ".sandcastle", "Dockerfile"))).toBe(true);
      // But the temporary patches dir should still be cleaned up
      expect(existsSync(join(hostDir, ".sandcastle", "patches"))).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it("failed git am preserves artifacts and prints recovery message", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "initial.txt", "initial", "initial commit");

    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      await Effect.runPromise(syncIn(hostDir, handle));

      const wp = handle.worktreePath;
      // Create a commit in the sandbox that modifies initial.txt
      await handle.exec('echo "sandbox change" > initial.txt', { cwd: wp });
      await handle.exec("git add initial.txt", { cwd: wp });
      await handle.exec('git commit -m "sandbox edit"', { cwd: wp });

      // Create dirty working tree on host that conflicts with the patch
      // (git am refuses to apply when working tree has conflicting changes)
      await writeFile(join(hostDir, "initial.txt"), "host dirty change\n");

      // Capture stderr
      const stderrChunks: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        stderrChunks.push(args.map(String).join(" "));
      };

      try {
        await Effect.runPromise(syncOut(hostDir, handle));
      } finally {
        console.error = originalError;
      }

      // Verify patch artifacts are preserved
      const patchesDir = join(hostDir, ".sandcastle", "patches");
      expect(existsSync(patchesDir)).toBe(true);

      const timestampDirs = await readdir(patchesDir);
      expect(timestampDirs).toHaveLength(1);
      expect(timestampDirs[0]).toMatch(/^\d{8}-\d{6}/);

      const [timestampDir] = timestampDirs;

      assert.isDefined(timestampDir);

      const artifactDir = join(patchesDir, timestampDir);
      const files = await readdir(artifactDir);
      // Should have at least one .patch file
      expect(files.some((f) => f.endsWith(".patch"))).toBe(true);

      // Verify recovery message was printed
      const stderrOutput = stderrChunks.join("\n");
      expect(stderrOutput).toContain("Patch application failed");
      expect(stderrOutput).toContain("git am --continue");
    } finally {
      await handle.close();
    }
  });

  it("failed git apply preserves diff artifact with recovery message", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "initial.txt", "initial", "initial commit");

    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      await Effect.runPromise(syncIn(hostDir, handle));

      const wp = handle.worktreePath;
      // Make uncommitted changes in sandbox
      await handle.exec('echo "sandbox uncommitted" > initial.txt', {
        cwd: wp,
      });

      // Make conflicting uncommitted changes on host
      await writeFile(join(hostDir, "initial.txt"), "host conflicting\n");

      const stderrChunks: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        stderrChunks.push(args.map(String).join(" "));
      };

      try {
        await Effect.runPromise(syncOut(hostDir, handle));
      } finally {
        console.error = originalError;
      }

      // Verify patch artifacts are preserved
      const patchesDir = join(hostDir, ".sandcastle", "patches");
      expect(existsSync(patchesDir)).toBe(true);

      const timestampDirs = await readdir(patchesDir);
      expect(timestampDirs).toHaveLength(1);

      const [timestampDir] = timestampDirs;

      assert.isDefined(timestampDir);

      const artifactDir = join(patchesDir, timestampDir);
      const files = await readdir(artifactDir);
      expect(files).toContain("changes.patch");

      // Verify recovery message mentions git apply
      const stderrOutput = stderrChunks.join("\n");
      expect(stderrOutput).toContain("Patch application failed");
      expect(stderrOutput).toContain("git apply");
    } finally {
      await handle.close();
    }
  });

  it("preserves commit author and message metadata", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "initial.txt", "initial", "initial commit");

    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      await Effect.runPromise(syncIn(hostDir, handle));

      const wp = handle.worktreePath;
      await handle.exec('git config user.email "agent@sandbox.com"', {
        cwd: wp,
      });
      await handle.exec('git config user.name "Agent"', { cwd: wp });
      await handle.exec('echo "authored" > authored.txt', { cwd: wp });
      await handle.exec("git add authored.txt", { cwd: wp });
      await handle.exec('git commit -m "commit from agent"', { cwd: wp });

      await Effect.runPromise(syncOut(hostDir, handle));

      const { stdout: author } = await execAsync(
        'git log -1 --format="%an <%ae>"',
        { cwd: hostDir },
      );
      expect(author.trim()).toBe("Agent <agent@sandbox.com>");

      const { stdout: msg } = await execAsync('git log -1 --format="%s"', {
        cwd: hostDir,
      });
      expect(msg.trim()).toBe("commit from agent");
    } finally {
      await handle.close();
    }
  });

  it("extracts commits across two consecutive syncOut runs on the same sandbox", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "initial.txt", "initial", "initial commit");

    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      await Effect.runPromise(syncIn(hostDir, handle));

      const wp = handle.worktreePath;

      // Pin sandbox commit dates to the past so `git am` on the host (which
      // uses "now" as the committer date) always produces a new SHA. Without
      // this, the same-second `am` may reproduce the original SHA and the
      // bug-under-test hides itself.
      const dateEnv =
        "GIT_AUTHOR_DATE='2024-01-01T00:00:00' " +
        "GIT_COMMITTER_DATE='2024-01-01T00:00:00'";

      // Run 1: commit + sync
      await handle.exec('echo "first" > first.txt', { cwd: wp });
      await handle.exec("git add first.txt", { cwd: wp });
      await handle.exec(`${dateEnv} git commit -m "add first"`, { cwd: wp });
      await Effect.runPromise(syncOut(hostDir, handle));

      // Run 2: another commit + sync — host HEAD is now an am-rewritten SHA
      // unknown to the sandbox, so the old code's `format-patch hostHead..HEAD`
      // would fail with `Invalid revision range`. The fix tracks the base via
      // a sandbox-owned ref so this run succeeds.
      await handle.exec('echo "second" > second.txt', { cwd: wp });
      await handle.exec("git add second.txt", { cwd: wp });
      await handle.exec(`${dateEnv} git commit -m "add second"`, { cwd: wp });
      await Effect.runPromise(syncOut(hostDir, handle));

      const log = await getLog(hostDir);
      expect(log).toHaveLength(3);
      expect(log[0]).toContain("add second");
      expect(log[1]).toContain("add first");

      const first = await readFile(join(hostDir, "first.txt"), "utf8");
      expect(first.trim()).toBe("first");
      const second = await readFile(join(hostDir, "second.txt"), "utf8");
      expect(second.trim()).toBe("second");
    } finally {
      await handle.close();
    }
  });

  it("second syncOut with no new commits is a no-op", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "initial.txt", "initial", "initial commit");

    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      await Effect.runPromise(syncIn(hostDir, handle));

      const wp = handle.worktreePath;
      const dateEnv =
        "GIT_AUTHOR_DATE='2024-01-01T00:00:00' " +
        "GIT_COMMITTER_DATE='2024-01-01T00:00:00'";
      await handle.exec('echo "new" > new.txt', { cwd: wp });
      await handle.exec("git add new.txt", { cwd: wp });
      await handle.exec(`${dateEnv} git commit -m "add new"`, { cwd: wp });
      await Effect.runPromise(syncOut(hostDir, handle));

      const { stdout: hostHeadAfterRun1 } = await execAsync(
        "git rev-parse HEAD",
        { cwd: hostDir },
      );

      // Run 2: no new sandbox commits. Must be a no-op for the commits path —
      // detection compares the sandbox-owned base against sandbox HEAD, so
      // a hostHead-vs-sandboxHead comparison (which always differs after
      // run 1's `git am` rewrite) does not retrigger format-patch.
      await Effect.runPromise(syncOut(hostDir, handle));

      const { stdout: hostHeadAfterRun2 } = await execAsync(
        "git rev-parse HEAD",
        { cwd: hostDir },
      );
      expect(hostHeadAfterRun2.trim()).toBe(hostHeadAfterRun1.trim());

      const patchesDir = join(hostDir, ".sandcastle", "patches");
      expect(existsSync(patchesDir)).toBe(false);
    } finally {
      await handle.close();
    }
  });
});

describe("countCommitsToSync", () => {
  it("returns 0 after a successful syncOut when no new commits exist (run-2 case)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "initial.txt", "initial", "initial commit");

    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      await Effect.runPromise(syncIn(hostDir, handle));

      const wp = handle.worktreePath;
      const dateEnv =
        "GIT_AUTHOR_DATE='2024-01-01T00:00:00' " +
        "GIT_COMMITTER_DATE='2024-01-01T00:00:00'";
      await handle.exec('echo "new" > new.txt', { cwd: wp });
      await handle.exec("git add new.txt", { cwd: wp });
      await handle.exec(`${dateEnv} git commit -m "add new"`, { cwd: wp });
      await Effect.runPromise(syncOut(hostDir, handle));

      // Host HEAD is now an am-rewritten SHA. With the fix, the helper reads
      // the sandbox-owned base ref instead of falling back to this poisoned
      // host SHA, so the count comes out as 0 rather than the silent-degrade
      // fallback the old inline code produced.
      const { stdout: hostHead } = await execAsync("git rev-parse HEAD", {
        cwd: hostDir,
      });

      const sandbox = makeSandboxFromHandle(handle);
      const count = await Effect.runPromise(
        countCommitsToSync(sandbox, wp, hostHead.trim()),
      );
      expect(count).toBe(0);
    } finally {
      await handle.close();
    }
  });

  it("returns the number of new sandbox commits since the last sync", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "initial.txt", "initial", "initial commit");

    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      await Effect.runPromise(syncIn(hostDir, handle));

      const wp = handle.worktreePath;
      const dateEnv =
        "GIT_AUTHOR_DATE='2024-01-01T00:00:00' " +
        "GIT_COMMITTER_DATE='2024-01-01T00:00:00'";
      await handle.exec('echo "a" > a.txt', { cwd: wp });
      await handle.exec("git add a.txt", { cwd: wp });
      await handle.exec(`${dateEnv} git commit -m "add a"`, { cwd: wp });
      await Effect.runPromise(syncOut(hostDir, handle));

      // Two new sandbox commits since the last sync.
      await handle.exec('echo "b" > b.txt', { cwd: wp });
      await handle.exec("git add b.txt", { cwd: wp });
      await handle.exec(`${dateEnv} git commit -m "add b"`, { cwd: wp });
      await handle.exec('echo "c" > c.txt', { cwd: wp });
      await handle.exec("git add c.txt", { cwd: wp });
      await handle.exec(`${dateEnv} git commit -m "add c"`, { cwd: wp });

      const { stdout: hostHead } = await execAsync("git rev-parse HEAD", {
        cwd: hostDir,
      });

      const sandbox = makeSandboxFromHandle(handle);
      const count = await Effect.runPromise(
        countCommitsToSync(sandbox, wp, hostHead.trim()),
      );
      expect(count).toBe(2);
    } finally {
      await handle.close();
    }
  });

  it("falls back to host HEAD when no sync-base ref is set yet", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "initial.txt", "initial", "initial commit");

    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      await Effect.runPromise(syncIn(hostDir, handle));

      const wp = handle.worktreePath;
      await handle.exec('echo "new" > new.txt', { cwd: wp });
      await handle.exec("git add new.txt", { cwd: wp });
      await handle.exec('git commit -m "add new"', { cwd: wp });

      const { stdout: hostHead } = await execAsync("git rev-parse HEAD", {
        cwd: hostDir,
      });

      // Before any syncOut runs the ref is absent; hostHead is the correct
      // fallback because it still exists in the sandbox (sync-in copied it).
      const sandbox = makeSandboxFromHandle(handle);
      const count = await Effect.runPromise(
        countCommitsToSync(sandbox, wp, hostHead.trim()),
      );
      expect(count).toBe(1);
    } finally {
      await handle.close();
    }
  });
});
