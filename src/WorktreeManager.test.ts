import { Effect } from "effect";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { exec } from "node:child_process";
import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  create,
  generateTempBranchName,
  hasUncommittedChanges,
  pruneStale,
  remove,
  sanitizeName,
} from "./WorktreeManager.js";

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

const getBranch = async (dir: string) => {
  const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", {
    cwd: dir,
  });
  return stdout.trim();
};

const setupRepo = async () => {
  const repoDir = await mkdtemp(join(tmpdir(), "wt-repo-"));
  await initRepo(repoDir);
  await commitFile(repoDir, "hello.txt", "hello", "initial commit");
  return repoDir;
};

/** Run an Effect and return its success value, throwing on failure. */
const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(NodeFileSystem.layer)) as Effect.Effect<
      A,
      never
    >,
  );

/** Run an Effect and return the error, throwing if it succeeds. */
const runFail = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(
    Effect.flip(effect).pipe(
      Effect.provide(NodeFileSystem.layer),
    ) as Effect.Effect<E, never>,
  );

describe("sanitizeName", () => {
  it("lowercases the name", () => {
    expect(sanitizeName("Claude-Code")).toBe("claude-code");
  });

  it("replaces non-alphanumeric characters with hyphens", () => {
    expect(sanitizeName("my agent!")).toBe("my-agent-");
  });

  it("passes through a typical name unchanged", () => {
    expect(sanitizeName("claude-code")).toBe("claude-code");
  });

  it("handles names with dots and slashes", () => {
    expect(sanitizeName("my/agent.v2")).toBe("my-agent-v2");
  });
});

describe("generateTempBranchName", () => {
  it("returns a string in sandcastle/<YYYYMMDD-HHMMSS> format", () => {
    const name = generateTempBranchName();
    expect(name).toMatch(/^sandcastle\/\d{8}-\d{6}$/);
  });

  it("returns different names when called at different times", async () => {
    const a = generateTempBranchName();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const b = generateTempBranchName();
    expect(a).not.toBe(b);
  });

  it("includes sanitized name when provided", () => {
    const name = generateTempBranchName("my-run");
    expect(name).toMatch(/^sandcastle\/my-run\/\d{8}-\d{6}$/);
  });

  it("sanitizes the name in the branch", () => {
    const name = generateTempBranchName("My Run!");
    expect(name).toMatch(/^sandcastle\/my-run-\/\d{8}-\d{6}$/);
  });
});

describe("WorktreeManager.create", () => {
  it("creates a worktree at .sandcastle/worktrees/<name>/", async () => {
    const repoDir = await setupRepo();
    const { path } = await run(create(repoDir));
    expect(path).toContain(join(repoDir, ".sandcastle", "worktrees"));
    const s = await stat(path);
    expect(s.isDirectory()).toBe(true);
  });

  it("returns the branch name", async () => {
    const repoDir = await setupRepo();
    const { branch } = await run(create(repoDir));
    expect(typeof branch).toBe("string");
    expect(branch.length).toBeGreaterThan(0);
  });

  it("creates a sandcastle/<timestamp> branch when no branch is specified", async () => {
    const repoDir = await setupRepo();
    const { branch } = await run(create(repoDir));
    expect(branch).toMatch(/^sandcastle\/\d{8}-\d{6}$/);
  });

  it("includes name in branch when name is specified", async () => {
    const repoDir = await setupRepo();
    const { branch } = await run(create(repoDir, { name: "my-run" }));
    expect(branch).toMatch(/^sandcastle\/my-run\/\d{8}-\d{6}$/);
  });

  it("includes name in worktree directory when name is specified", async () => {
    const repoDir = await setupRepo();
    const { path } = await run(create(repoDir, { name: "my-run" }));
    expect(path).toMatch(/sandcastle-my-run-\d{8}-\d{6}$/);
  });

  it("checks out the specified branch when branch is given", async () => {
    const repoDir = await setupRepo();
    // Create a branch first
    await execAsync("git checkout -b feature/my-feature", { cwd: repoDir });
    await commitFile(repoDir, "feature.txt", "x", "feature commit");
    await execAsync("git checkout main", { cwd: repoDir });

    const { path, branch } = await run(
      create(repoDir, { branch: "feature/my-feature" }),
    );
    expect(branch).toBe("feature/my-feature");
    expect(await getBranch(path)).toBe("feature/my-feature");
  });

  it("the worktree directory is on the correct branch", async () => {
    const repoDir = await setupRepo();
    const { path } = await run(create(repoDir));
    // The worktree should have a valid git repo
    const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", {
      cwd: path,
    });
    expect(stdout.trim()).toMatch(/^sandcastle\//);
  });

  it("fails with a clear error when branch is already checked out", async () => {
    const repoDir = await setupRepo();
    // Create a branch
    await execAsync("git checkout -b my-branch", { cwd: repoDir });
    await commitFile(repoDir, "x.txt", "x", "branch commit");
    await execAsync("git checkout main", { cwd: repoDir });

    // Create first worktree on that branch
    await run(create(repoDir, { branch: "my-branch" }));

    // Try to create a second worktree on the same branch — should fail clearly
    const err = await runFail(create(repoDir, { branch: "my-branch" }));
    expect(err.message).toMatch(/already checked out/i);
  });

  it("error message includes the path of the existing worktree", async () => {
    const repoDir = await setupRepo();
    await execAsync("git checkout -b my-branch", { cwd: repoDir });
    await commitFile(repoDir, "x.txt", "x", "branch commit");
    await execAsync("git checkout main", { cwd: repoDir });

    const { path: existingPath } = await run(
      create(repoDir, { branch: "my-branch" }),
    );

    const err = await runFail(create(repoDir, { branch: "my-branch" }));
    expect(err.message).toContain(existingPath);
  });

  it("error message suggests what to do", async () => {
    const repoDir = await setupRepo();
    await execAsync("git checkout -b my-branch", { cwd: repoDir });
    await commitFile(repoDir, "x.txt", "x", "branch commit");
    await execAsync("git checkout main", { cwd: repoDir });

    await run(create(repoDir, { branch: "my-branch" }));

    const err = await runFail(create(repoDir, { branch: "my-branch" }));
    expect(err.message).toMatch(/different branch|wait/i);
  });

  it("parallel runs on different branches work without interference", async () => {
    const repoDir = await setupRepo();
    await execAsync("git checkout -b branch-a", { cwd: repoDir });
    await commitFile(repoDir, "a.txt", "a", "branch-a commit");
    await execAsync("git checkout main", { cwd: repoDir });
    await execAsync("git checkout -b branch-b", { cwd: repoDir });
    await commitFile(repoDir, "b.txt", "b", "branch-b commit");
    await execAsync("git checkout main", { cwd: repoDir });

    const [wtA, wtB] = await Promise.all([
      run(create(repoDir, { branch: "branch-a" })),
      run(create(repoDir, { branch: "branch-b" })),
    ]);

    expect(wtA.branch).toBe("branch-a");
    expect(wtB.branch).toBe("branch-b");
    expect(wtA.path).not.toBe(wtB.path);

    await run(remove(wtA.path));
    await run(remove(wtB.path));
  });

  it("creates a new branch from HEAD when specified branch does not exist", async () => {
    const repoDir = await setupRepo();
    const { path, branch } = await run(
      create(repoDir, { branch: "sandcastle/issue-42-new-feature" }),
    );

    expect(branch).toBe("sandcastle/issue-42-new-feature");
    expect(await getBranch(path)).toBe("sandcastle/issue-42-new-feature");

    // The worktree should have the same HEAD as the main repo
    const { stdout: mainHead } = await execAsync("git rev-parse HEAD", {
      cwd: repoDir,
    });
    const { stdout: worktreeHead } = await execAsync("git rev-parse HEAD", {
      cwd: path,
    });
    expect(worktreeHead.trim()).toBe(mainHead.trim());

    await run(remove(path));
  });

  it("detects collision when branch is checked out in the main working tree", async () => {
    const repoDir = await setupRepo();
    // "main" is the currently checked-out branch in the main working tree
    const err = await runFail(create(repoDir, { branch: "main" }));
    expect(err.message).toMatch(/already checked out/i);
  });

  it("removes an orphaned target directory before creating the worktree", async () => {
    const repoDir = await setupRepo();
    const orphanPath = join(
      repoDir,
      ".sandcastle",
      "worktrees",
      "sandcastle-issue-17-report-export-history",
    );

    await mkdir(orphanPath, { recursive: true });
    await writeFile(join(orphanPath, "junk.txt"), "orphan");

    const { path, branch } = await run(
      create(repoDir, {
        branch: "sandcastle/issue-17-report-export-history",
      }),
    );

    expect(branch).toBe("sandcastle/issue-17-report-export-history");
    expect(path).toBe(orphanPath);
    await expect(stat(join(path, "junk.txt"))).rejects.toThrow();

    await run(remove(path));
  });
});

describe("WorktreeManager.remove", () => {
  it("removes the worktree directory", async () => {
    const repoDir = await setupRepo();
    const { path } = await run(create(repoDir));

    await run(remove(path));

    await expect(stat(path)).rejects.toThrow();
  });

  it("removes git worktree metadata", async () => {
    const repoDir = await setupRepo();
    const { path } = await run(create(repoDir));

    await run(remove(path));

    // After removal, the worktree should not appear in git worktree list
    const { stdout } = await execAsync("git worktree list --porcelain", {
      cwd: repoDir,
    });
    expect(stdout).not.toContain(path);
  });

  it("cleans ignored files before removing the worktree", async () => {
    const repoDir = await setupRepo();
    await writeFile(join(repoDir, ".gitignore"), "node_modules/\n");
    await execAsync('git add .gitignore && git commit -m "add gitignore"', {
      cwd: repoDir,
    });

    const { path } = await run(create(repoDir));
    await mkdir(join(path, "node_modules"), { recursive: true });
    await writeFile(join(path, "node_modules", "junk.txt"), "junk");

    await run(remove(path));

    await expect(stat(path)).rejects.toThrow();
    const { stdout } = await execAsync("git worktree list --porcelain", {
      cwd: repoDir,
    });
    expect(stdout).not.toContain(path);
  });
});

describe("WorktreeManager.pruneStale", () => {
  it("runs git worktree prune to clean up stale metadata", async () => {
    const repoDir = await setupRepo();
    const { path } = await run(create(repoDir));

    // Manually delete the worktree directory (simulating a crash)
    const { execSync } = await import("node:child_process");
    execSync(`rm -rf "${path}"`);

    // pruneStale should not throw
    await run(pruneStale(repoDir));

    // Git metadata should be cleaned up
    const { stdout } = await execAsync("git worktree list --porcelain", {
      cwd: repoDir,
    });
    expect(stdout).not.toContain(path);
  });

  it("removes orphaned directories under .sandcastle/worktrees/", async () => {
    const repoDir = await setupRepo();
    const worktreesDir = join(repoDir, ".sandcastle", "worktrees");
    await mkdir(worktreesDir, { recursive: true });

    // Create an orphaned directory (not backed by a git worktree)
    const orphanDir = join(worktreesDir, "orphan-dir");
    await mkdir(orphanDir);

    await run(pruneStale(repoDir));

    const entries = await readdir(worktreesDir).catch(() => []);
    expect(entries).not.toContain("orphan-dir");
  });

  it("does not remove active worktrees", async () => {
    const repoDir = await setupRepo();
    const { path } = await run(create(repoDir));
    const name = path.split("/").pop()!;

    await run(pruneStale(repoDir));

    const s = await stat(path);
    expect(s.isDirectory()).toBe(true);
    // cleanup
    await run(remove(path));
    // suppress unused var warning
    void name;
  });
});

describe("WorktreeManager.hasUncommittedChanges", () => {
  it("returns false for a clean worktree", async () => {
    const repoDir = await setupRepo();
    const { path } = await run(create(repoDir));

    const result = await run(hasUncommittedChanges(path));
    expect(result).toBe(false);

    await run(remove(path));
  });

  it("returns true when there are unstaged modifications", async () => {
    const repoDir = await setupRepo();
    const { path } = await run(create(repoDir));

    // Modify a tracked file without staging
    await writeFile(join(path, "hello.txt"), "modified content");

    const result = await run(hasUncommittedChanges(path));
    expect(result).toBe(true);

    await run(remove(path));
  });

  it("returns true when there are staged changes", async () => {
    const repoDir = await setupRepo();
    const { path } = await run(create(repoDir));

    // Stage a new file
    await writeFile(join(path, "new-file.txt"), "new content");
    await execAsync("git add new-file.txt", { cwd: path });

    const result = await run(hasUncommittedChanges(path));
    expect(result).toBe(true);

    await run(remove(path));
  });

  it("returns true when there are untracked files", async () => {
    const repoDir = await setupRepo();
    const { path } = await run(create(repoDir));

    // Add an untracked file
    await writeFile(join(path, "untracked.txt"), "untracked");

    const result = await run(hasUncommittedChanges(path));
    expect(result).toBe(true);

    await run(remove(path));
  });
});
