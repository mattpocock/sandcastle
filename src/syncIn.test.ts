import { exec } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { testIsolated } from "./sandboxes/test-isolated.js";
import type { IsolatedSandboxHandle } from "./SandboxProvider.js";
import { syncIn } from "./syncIn.js";

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

const getHead = async (dir: string) => {
  const { stdout } = await execAsync("git rev-parse HEAD", { cwd: dir });
  return stdout.trim();
};

// The sandbox is the system boundary: wrap a real handle so it reports a
// different HEAD than the host's.
const reportingSandboxHead = (
  handle: IsolatedSandboxHandle,
  head: string,
): IsolatedSandboxHandle => ({
  ...handle,
  exec: async (command, options) =>
    command === "git rev-parse HEAD"
      ? { stdout: `${head}\n`, stderr: "", exitCode: 0 }
      : handle.exec(command, options),
});

describe("syncIn", () => {
  it("bundles a repo and clones it into the sandbox — files present", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello world", "initial commit");

    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      await Effect.runPromise(syncIn(hostDir, handle));

      const result = await handle.exec("cat hello.txt");
      expect(result.stdout.trim()).toBe("hello world");
    } finally {
      await handle.close();
    }
  });

  it("preserves git history after clone from bundle", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "a.txt", "a", "first commit");
    await commitFile(hostDir, "b.txt", "b", "second commit");
    await commitFile(hostDir, "c.txt", "c", "third commit");

    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      await Effect.runPromise(syncIn(hostDir, handle));

      // Verify HEAD matches
      const sandboxHead = (
        await handle.exec("git rev-parse HEAD")
      ).stdout.trim();
      expect(sandboxHead).toBe(await getHead(hostDir));

      // Verify all 3 commits are present
      const log = (await handle.exec("git log --oneline")).stdout.trim();
      expect(log.split("\n")).toHaveLength(3);

      // Verify all files present
      expect((await handle.exec("cat a.txt")).stdout.trim()).toBe("a");
      expect((await handle.exec("cat b.txt")).stdout.trim()).toBe("b");
      expect((await handle.exec("cat c.txt")).stdout.trim()).toBe("c");
    } finally {
      await handle.close();
    }
  });

  it("works with repos that have unpushed commits (no remote)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "local-only.txt", "no remote", "local commit");

    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      await Effect.runPromise(syncIn(hostDir, handle));

      const sandboxHead = (
        await handle.exec("git rev-parse HEAD")
      ).stdout.trim();
      expect(sandboxHead).toBe(await getHead(hostDir));

      const content = (await handle.exec("cat local-only.txt")).stdout.trim();
      expect(content).toBe("no remote");
    } finally {
      await handle.close();
    }
  });

  it("returns the current branch name", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "file.txt", "content", "initial");

    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      const result = await Effect.runPromise(syncIn(hostDir, handle));
      expect(result.branch).toBe("main");
    } finally {
      await handle.close();
    }
  });

  it("works with a non-main branch", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "file.txt", "on main", "initial");
    await execAsync("git checkout -b feature-branch", { cwd: hostDir });
    await commitFile(hostDir, "feature.txt", "feature work", "feature commit");

    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      const result = await Effect.runPromise(syncIn(hostDir, handle));
      expect(result.branch).toBe("feature-branch");

      // Feature file should exist
      expect((await handle.exec("cat feature.txt")).stdout.trim()).toBe(
        "feature work",
      );

      // Sandbox should be on the same branch
      const sandboxBranch = (
        await handle.exec("git rev-parse --abbrev-ref HEAD")
      ).stdout.trim();
      expect(sandboxBranch).toBe("feature-branch");
    } finally {
      await handle.close();
    }
  });

  it("only syncs committed state — uncommitted changes are excluded", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "committed.txt", "committed", "initial");

    // Add uncommitted changes
    await writeFile(join(hostDir, "committed.txt"), "modified uncommitted");
    await writeFile(join(hostDir, "untracked.txt"), "untracked file");

    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      await Effect.runPromise(syncIn(hostDir, handle));

      // Committed content should be the original
      const content = (await handle.exec("cat committed.txt")).stdout.trim();
      expect(content).toBe("committed");

      // Untracked file should not exist
      const ls = (await handle.exec("ls")).stdout;
      expect(ls).not.toContain("untracked.txt");
    } finally {
      await handle.close();
    }
  });

  it("fails with a SyncError when the sandbox HEAD doesn't match the host after sync", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    const divergedHandle = reportingSandboxHead(handle, "0000000");
    try {
      const error = await Effect.runPromise(
        Effect.flip(syncIn(hostDir, divergedHandle)),
      );
      expect(error).toMatchObject({
        _tag: "SyncError",
        message: `HEAD mismatch after sync-in: host=${await getHead(hostDir)} sandbox=0000000`,
      });
    } finally {
      await handle.close();
    }
  });
});
