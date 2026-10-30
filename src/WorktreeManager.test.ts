import { Effect } from "effect";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { exec } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  create,
  generateTempBranchName,
  getCurrentBranch,
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

/**
 * Set up a main repo with an `origin` remote backed by a bare repo. Returns
 * both the repo dir (with `origin` configured) and a `pushOrigin` helper that
 * makes a fresh commit on `branch` in a separate clone and pushes it — used to
 * simulate someone else moving origin forward between sandcastle runs.
 */
const setupRepoWithOrigin = async () => {
  const remoteDir = await mkdtemp(join(tmpdir(), "wt-remote-"));
  await execAsync("git init --bare -b main", { cwd: remoteDir });

  const repoDir = await mkdtemp(join(tmpdir(), "wt-repo-"));
  await initRepo(repoDir);
  await commitFile(repoDir, "hello.txt", "hello", "initial commit");
  await execAsync(`git remote add origin "${remoteDir}"`, { cwd: repoDir });
  await execAsync("git push -u origin main", { cwd: repoDir });

  const pushOrigin = async (
    branch: string,
    fileName: string,
    content: string,
    message: string,
  ) => {
    const cloneDir = await mkdtemp(join(tmpdir(), "wt-clone-"));
    await execAsync(`git clone "${remoteDir}" .`, { cwd: cloneDir });
    await execAsync('git config user.email "test@test.com"', {
      cwd: cloneDir,
    });
    await execAsync('git config user.name "Test"', { cwd: cloneDir });
    await execAsync(`git checkout ${branch}`, { cwd: cloneDir });
    await commitFile(cloneDir, fileName, content, message);
    await execAsync(`git push origin ${branch}`, { cwd: cloneDir });
  };

  return { repoDir, remoteDir, pushOrigin };
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
  it("returns a string in sandcastle/<YYYYMMDD-HHMMSS>-<random> format", () => {
    const name = generateTempBranchName();
    expect(name).toMatch(/^sandcastle\/\d{8}-\d{6}-[0-9a-f]{6}$/);
  });

  it("returns different names when called at different times", async () => {
    const a = generateTempBranchName();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const b = generateTempBranchName();
    expect(a).not.toBe(b);
  });

  it("returns different names when called within the same second (random suffix)", () => {
    const names = new Set<string>();
    for (let i = 0; i < 16; i++) names.add(generateTempBranchName());
    expect(names.size).toBe(16);
  });

  it("includes sanitized name when provided", () => {
    const name = generateTempBranchName("my-run");
    expect(name).toMatch(/^sandcastle\/my-run\/\d{8}-\d{6}-[0-9a-f]{6}$/);
  });

  it("sanitizes the name in the branch", () => {
    const name = generateTempBranchName("My Run!");
    expect(name).toMatch(/^sandcastle\/my-run-\/\d{8}-\d{6}-[0-9a-f]{6}$/);
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

  it("creates a sandcastle/<timestamp>-<random> branch when no branch is specified", async () => {
    const repoDir = await setupRepo();
    const { branch } = await run(create(repoDir));
    expect(branch).toMatch(/^sandcastle\/\d{8}-\d{6}-[0-9a-f]{6}$/);
  });

  it("includes name in branch when name is specified", async () => {
    const repoDir = await setupRepo();
    const { branch } = await run(create(repoDir, { name: "my-run" }));
    expect(branch).toMatch(/^sandcastle\/my-run\/\d{8}-\d{6}-[0-9a-f]{6}$/);
  });

  it("includes name in worktree directory when name is specified", async () => {
    const repoDir = await setupRepo();
    const { path } = await run(create(repoDir, { name: "my-run" }));
    expect(path).toMatch(/sandcastle-my-run-\d{8}-\d{6}-[0-9a-f]{6}$/);
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

  it("reuses existing clean worktree for the same branch", async () => {
    const repoDir = await setupRepo();
    await execAsync("git checkout -b my-branch", { cwd: repoDir });
    await commitFile(repoDir, "x.txt", "x", "branch commit");
    await execAsync("git checkout main", { cwd: repoDir });

    const first = await run(create(repoDir, { branch: "my-branch" }));
    const second = await run(create(repoDir, { branch: "my-branch" }));

    expect(second.path).toBe(first.path);
    expect(second.branch).toBe("my-branch");

    await run(remove(first.path));
  });

  it("reuses dirty worktree with a warning", async () => {
    const repoDir = await setupRepo();
    await execAsync("git checkout -b my-branch", { cwd: repoDir });
    await commitFile(repoDir, "x.txt", "x", "branch commit");
    await execAsync("git checkout main", { cwd: repoDir });

    const first = await run(create(repoDir, { branch: "my-branch" }));

    // Make the worktree dirty
    await writeFile(join(first.path, "dirty.txt"), "uncommitted");

    const second = await run(create(repoDir, { branch: "my-branch" }));

    expect(second.path).toBe(first.path);
    expect(second.branch).toBe("my-branch");

    await run(remove(first.path));
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

  it("concurrent prune+create on different branches do not destroy each other (#849)", async () => {
    const repoDir = await setupRepo();

    // Mirror the parallel-planner template: N concurrent in-process runs, each
    // on its own branch, each running `pruneStale` then `create` (as
    // SandboxFactory.pruneAndCreate does). Without serialising the destructive
    // prune sweep against in-flight creates, a sibling's `pruneStale` deletes a
    // worktree directory that is mid-`git worktree add`, leaving a dangling
    // `.git` link.
    const branches = Array.from({ length: 6 }, (_, i) => `issue-${i + 1}`);
    for (const branch of branches) {
      await execAsync(`git branch ${branch}`, { cwd: repoDir });
    }

    const results = await Promise.all(
      branches.map((branch) =>
        run(
          pruneStale(repoDir).pipe(Effect.andThen(create(repoDir, { branch }))),
        ),
      ),
    );

    // Every worktree must survive on disk with an intact `.git` link, and git
    // must still recognise it as a valid repository.
    for (const { path, branch } of results) {
      expect(await getBranch(path)).toBe(branch);
      expect((await stat(join(path, ".git"))).isFile()).toBe(true);
    }

    // git itself agrees all worktrees are still registered (none were swept).
    const { stdout } = await execAsync("git worktree list --porcelain", {
      cwd: repoDir,
    });
    for (const { path } of results) {
      expect(stdout).toContain(path);
    }

    for (const { path } of results) {
      await run(remove(path));
    }
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

  it("creates a new branch from baseBranch when specified", async () => {
    const repoDir = await setupRepo();

    // Create a second commit on main so HEAD differs from the base
    await commitFile(repoDir, "second.txt", "second", "second commit");

    // Record the first commit's SHA (the one before "second commit")
    const { stdout: baseSha } = await execAsync("git rev-parse HEAD~1", {
      cwd: repoDir,
    });

    const { path, branch } = await run(
      create(repoDir, {
        branch: "feature/from-base",
        baseBranch: baseSha.trim(),
      }),
    );

    expect(branch).toBe("feature/from-base");
    expect(await getBranch(path)).toBe("feature/from-base");

    // The worktree should be at the base commit, not HEAD
    const { stdout: worktreeHead } = await execAsync("git rev-parse HEAD", {
      cwd: path,
    });
    expect(worktreeHead.trim()).toBe(baseSha.trim());

    await run(remove(path));
  });

  it("ignores baseBranch when the branch already exists", async () => {
    const repoDir = await setupRepo();

    // Create a branch with a known commit
    await execAsync("git checkout -b existing-branch", { cwd: repoDir });
    await commitFile(repoDir, "on-branch.txt", "x", "branch commit");
    const { stdout: branchHead } = await execAsync("git rev-parse HEAD", {
      cwd: repoDir,
    });
    await execAsync("git checkout main", { cwd: repoDir });

    // Add another commit on main to use as baseBranch
    await commitFile(repoDir, "main2.txt", "y", "main commit 2");
    const { stdout: mainHead } = await execAsync("git rev-parse HEAD", {
      cwd: repoDir,
    });

    // baseBranch should be ignored since existing-branch already exists
    const { path } = await run(
      create(repoDir, {
        branch: "existing-branch",
        baseBranch: mainHead.trim(),
      }),
    );

    const { stdout: worktreeHead } = await execAsync("git rev-parse HEAD", {
      cwd: path,
    });
    expect(worktreeHead.trim()).toBe(branchHead.trim());

    await run(remove(path));
  });

  it("fast-forwards a clean reused worktree when origin has moved ahead", async () => {
    const { repoDir, pushOrigin } = await setupRepoWithOrigin();

    await execAsync("git checkout -b my-branch", { cwd: repoDir });
    await commitFile(repoDir, "x.txt", "x", "branch commit");
    await execAsync("git push -u origin my-branch", { cwd: repoDir });
    await execAsync("git checkout main", { cwd: repoDir });

    const first = await run(create(repoDir, { branch: "my-branch" }));
    const { stdout: initialSha } = await execAsync("git rev-parse HEAD", {
      cwd: first.path,
    });

    // Someone else pushes a new commit to origin/my-branch
    await pushOrigin("my-branch", "new.txt", "new", "new origin commit");

    const second = await run(create(repoDir, { branch: "my-branch" }));

    expect(second.path).toBe(first.path);
    expect(second.branch).toBe("my-branch");

    const { stdout: afterSha } = await execAsync("git rev-parse HEAD", {
      cwd: second.path,
    });
    expect(afterSha.trim()).not.toBe(initialSha.trim());
    // The pushed file should now exist in the worktree
    const newFile = await readFile(join(second.path, "new.txt"), "utf-8");
    expect(newFile).toBe("new");

    await run(remove(first.path));
  });

  it("preserves unpushed commits when the reused branch has diverged from origin", async () => {
    const { repoDir, pushOrigin } = await setupRepoWithOrigin();

    await execAsync("git checkout -b my-branch", { cwd: repoDir });
    await commitFile(repoDir, "x.txt", "x", "branch commit");
    await execAsync("git push -u origin my-branch", { cwd: repoDir });
    await execAsync("git checkout main", { cwd: repoDir });

    const first = await run(create(repoDir, { branch: "my-branch" }));

    // Add an unpushed commit in the worktree
    await commitFile(first.path, "local.txt", "local", "local-only commit");
    const { stdout: localSha } = await execAsync("git rev-parse HEAD", {
      cwd: first.path,
    });

    // Also push a different new commit to origin → true divergence
    await pushOrigin("my-branch", "remote.txt", "remote", "remote-only commit");

    const second = await run(create(repoDir, { branch: "my-branch" }));

    expect(second.path).toBe(first.path);

    // The local commit must survive — no clobber by reset --hard or similar.
    const { stdout: afterSha } = await execAsync("git rev-parse HEAD", {
      cwd: second.path,
    });
    expect(afterSha.trim()).toBe(localSha.trim());
    const localFile = await readFile(join(second.path, "local.txt"), "utf-8");
    expect(localFile).toBe("local");

    await run(remove(first.path));
  });

  it("does not refresh a dirty reused worktree", async () => {
    const { repoDir, pushOrigin } = await setupRepoWithOrigin();

    await execAsync("git checkout -b my-branch", { cwd: repoDir });
    await commitFile(repoDir, "x.txt", "x", "branch commit");
    await execAsync("git push -u origin my-branch", { cwd: repoDir });
    await execAsync("git checkout main", { cwd: repoDir });

    const first = await run(create(repoDir, { branch: "my-branch" }));
    const { stdout: initialSha } = await execAsync("git rev-parse HEAD", {
      cwd: first.path,
    });

    // Dirty the worktree with an uncommitted change
    await writeFile(join(first.path, "dirty.txt"), "uncommitted");

    // Origin moves forward — but because the worktree is dirty, refresh
    // should be skipped so the uncommitted change isn't disturbed.
    await pushOrigin("my-branch", "new.txt", "new", "new origin commit");

    const second = await run(create(repoDir, { branch: "my-branch" }));

    expect(second.path).toBe(first.path);
    const { stdout: afterSha } = await execAsync("git rev-parse HEAD", {
      cwd: second.path,
    });
    expect(afterSha.trim()).toBe(initialSha.trim());
    // The uncommitted file is still there
    const dirty = await readFile(join(second.path, "dirty.txt"), "utf-8");
    expect(dirty).toBe("uncommitted");

    await run(remove(first.path));
  });

  it("treats fetch failure as non-fatal and reuses the worktree as-is", async () => {
    // No origin remote at all — `git fetch origin <branch>` will fail.
    const repoDir = await setupRepo();
    await execAsync("git checkout -b my-branch", { cwd: repoDir });
    await commitFile(repoDir, "x.txt", "x", "branch commit");
    await execAsync("git checkout main", { cwd: repoDir });

    const first = await run(create(repoDir, { branch: "my-branch" }));
    const { stdout: initialSha } = await execAsync("git rev-parse HEAD", {
      cwd: first.path,
    });

    // Reuse must not throw — the fetch failure is swallowed.
    const second = await run(create(repoDir, { branch: "my-branch" }));

    expect(second.path).toBe(first.path);
    const { stdout: afterSha } = await execAsync("git rev-parse HEAD", {
      cwd: second.path,
    });
    expect(afterSha.trim()).toBe(initialSha.trim());

    await run(remove(first.path));
  });

  it("preserves unpushed local commits when origin has not moved (ff-only no-op)", async () => {
    // Strictly-ahead case: origin/<branch> is an ancestor of HEAD. `git merge
    // --ff-only` must succeed as a no-op and leave the unpushed commit intact.
    // Distinct from the no-origin path: here fetch *succeeds* and the merge
    // call actually runs.
    const { repoDir } = await setupRepoWithOrigin();

    await execAsync("git checkout -b my-branch", { cwd: repoDir });
    await commitFile(repoDir, "x.txt", "x", "branch commit");
    await execAsync("git push -u origin my-branch", { cwd: repoDir });
    await execAsync("git checkout main", { cwd: repoDir });

    const first = await run(create(repoDir, { branch: "my-branch" }));

    // Local commit; origin/my-branch stays put.
    await commitFile(first.path, "local.txt", "local", "local-only commit");
    const { stdout: localSha } = await execAsync("git rev-parse HEAD", {
      cwd: first.path,
    });

    const second = await run(create(repoDir, { branch: "my-branch" }));

    expect(second.path).toBe(first.path);
    const { stdout: afterSha } = await execAsync("git rev-parse HEAD", {
      cwd: second.path,
    });
    expect(afterSha.trim()).toBe(localSha.trim());
    const localFile = await readFile(join(second.path, "local.txt"), "utf-8");
    expect(localFile).toBe("local");

    await run(remove(first.path));
  });

  it("does not advance HEAD past a mid-rebase pause (detached HEAD, clean tree)", async () => {
    // A `git rebase` paused at an `edit`/`break`/`exec` instruction leaves
    // HEAD detached at the pause point with a clean working tree — porcelain
    // status is empty, so the dirty guard does not catch it. Without an
    // explicit HEAD-attached check, `git merge --ff-only origin/<branch>`
    // would silently advance HEAD past the pause point and `git rebase
    // --continue` would then produce confused "empty cherry-pick" output.
    const { repoDir, pushOrigin } = await setupRepoWithOrigin();

    await execAsync("git checkout -b my-branch", { cwd: repoDir });
    await commitFile(repoDir, "a.txt", "a", "branch commit 1");
    await commitFile(repoDir, "b.txt", "b", "branch commit 2");
    await execAsync("git push -u origin my-branch", { cwd: repoDir });
    await execAsync("git checkout main", { cwd: repoDir });

    const first = await run(create(repoDir, { branch: "my-branch" }));

    // Pause the rebase mid-way: `--exec false` runs `false` after each
    // cherry-pick, fails on the first one, and leaves HEAD detached with a
    // clean working tree and a populated `rebase-merge` state directory.
    await execAsync("git rebase --exec false HEAD~2", {
      cwd: first.path,
    }).catch(() => {});

    const { stdout: pausedSha } = await execAsync("git rev-parse HEAD", {
      cwd: first.path,
    });

    // Sanity: HEAD must actually be detached and the tree clean — the
    // preconditions for the bug.
    await expect(
      execAsync("git symbolic-ref --quiet HEAD", { cwd: first.path }),
    ).rejects.toThrow();
    const { stdout: status } = await execAsync("git status --porcelain", {
      cwd: first.path,
    });
    expect(status.trim()).toBe("");

    // Move origin forward so the buggy code would have something to ff to.
    await pushOrigin("my-branch", "new.txt", "new", "new origin commit");

    const second = await run(create(repoDir, { branch: "my-branch" }));
    expect(second.path).toBe(first.path);

    const { stdout: afterSha } = await execAsync("git rev-parse HEAD", {
      cwd: second.path,
    });
    expect(afterSha.trim()).toBe(pausedSha.trim());

    // Rebase state must survive — `--continue` would otherwise be impossible.
    const { stdout: rebaseMergePath } = await execAsync(
      "git rev-parse --git-path rebase-merge",
      { cwd: second.path },
    );
    const resolvedRebaseDir = rebaseMergePath.trim().startsWith("/")
      ? rebaseMergePath.trim()
      : join(second.path, rebaseMergePath.trim());
    expect((await stat(resolvedRebaseDir)).isDirectory()).toBe(true);

    await execAsync("git rebase --abort", { cwd: first.path }).catch(() => {});
    await run(remove(first.path));
  });

  it("reuses worktree with unpushed commits (not considered dirty)", async () => {
    const repoDir = await setupRepo();
    await execAsync("git checkout -b my-branch", { cwd: repoDir });
    await commitFile(repoDir, "x.txt", "x", "branch commit");
    await execAsync("git checkout main", { cwd: repoDir });

    const first = await run(create(repoDir, { branch: "my-branch" }));

    // Add a committed (but unpushed) change — should NOT count as dirty
    await commitFile(first.path, "extra.txt", "extra", "extra commit");

    const second = await run(create(repoDir, { branch: "my-branch" }));

    expect(second.path).toBe(first.path);
    expect(second.branch).toBe("my-branch");

    await run(remove(first.path));
  });

  it("reuses preserved worktree when branch is mid-rebase (detached HEAD)", async () => {
    const repoDir = await setupRepo();

    // Create a branch with a commit that will conflict during rebase
    await execAsync("git checkout -b feat/rebase-test", { cwd: repoDir });
    await commitFile(
      repoDir,
      "conflict.txt",
      "branch-content",
      "branch commit",
    );
    await execAsync("git checkout main", { cwd: repoDir });

    // Create a conflicting commit on main so rebase will pause
    await commitFile(
      repoDir,
      "conflict.txt",
      "main-content",
      "main conflicting commit",
    );

    // Create the worktree for feat/rebase-test
    const first = await run(create(repoDir, { branch: "feat/rebase-test" }));
    expect(first.branch).toBe("feat/rebase-test");

    // Start a rebase inside the worktree that will conflict (detaches HEAD)
    await execAsync("git rebase main", { cwd: first.path }).catch(() => {
      // Expected to fail due to conflict — HEAD is now detached mid-rebase
    });

    // Verify HEAD is detached (mid-rebase state)
    const { stdout: headRef } = await execAsync(
      "git rev-parse --abbrev-ref HEAD",
      { cwd: first.path },
    );
    expect(headRef.trim()).toBe("HEAD"); // detached

    // Now try to create the worktree again — should reuse the existing one
    const second = await run(create(repoDir, { branch: "feat/rebase-test" }));

    expect(second.path).toBe(first.path);
    expect(second.branch).toBe("feat/rebase-test");

    // Cleanup: abort the rebase so git worktree remove works
    await execAsync("git rebase --abort", { cwd: first.path });
    await run(remove(first.path));
  });

  it("detects collision when branch is checked out in the main working tree", async () => {
    const repoDir = await setupRepo();
    // "main" is the currently checked-out branch in the main working tree
    const err = await runFail(create(repoDir, { branch: "main" }));
    expect(err.message).toMatch(/already checked out/i);
    // The error should explain why this happens (sandcastle uses worktrees,
    // git forbids the same branch in two worktrees) and what to do about it,
    // not propose smart recovery.
    expect(err.message).toMatch(/worktree/i);
    expect(err.message).toMatch(/branch.*merge-to-head/i);
    expect(err.message).toMatch(/different branch/i);
  });

  it("does not write upstream tracking config even when autoSetupMerge is enabled", async () => {
    const repoDir = await setupRepo();

    // Enable the config that triggers .git/config writes during branch creation
    await execAsync("git config branch.autoSetupMerge always", {
      cwd: repoDir,
    });

    const { path, branch } = await run(
      create(repoDir, { branch: "sandcastle/no-tracking-test" }),
    );

    // If -c branch.autoSetupMerge=false is working, the new branch should
    // have no upstream tracking config (no branch.<name>.remote or .merge)
    const { stdout: trackingConfig } = await execAsync(
      `git config --get-regexp "branch\\.sandcastle/no-tracking-test\\." || true`,
      { cwd: repoDir },
    );
    expect(trackingConfig.trim()).toBe("");

    await run(remove(path));
  });

  it("does not write upstream tracking config for temp branches when autoSetupMerge is enabled", async () => {
    const repoDir = await setupRepo();

    // Enable the config that triggers .git/config writes during branch creation
    await execAsync("git config branch.autoSetupMerge always", {
      cwd: repoDir,
    });

    const { path, branch } = await run(create(repoDir));

    // The temp branch should also have no upstream tracking config
    const escapedBranch = branch.replace(/\//g, "\\/").replace(/\./g, "\\.");
    const { stdout: trackingConfig } = await execAsync(
      `git config --get-regexp "branch\\.${escapedBranch}\\." || true`,
      { cwd: repoDir },
    );
    expect(trackingConfig.trim()).toBe("");

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

  it("does not remove active worktrees when .sandcastle is a symlink", async () => {
    // Regression test for #470: git canonicalizes worktree paths, so when
    // .sandcastle is a symlink the un-canonicalized entryPath never matched
    // the active-set and active worktrees got wiped out from under their
    // running sandboxes.
    const repoDir = await setupRepo();
    const externalDir = await mkdtemp(join(tmpdir(), "wt-external-"));
    await symlink(externalDir, join(repoDir, ".sandcastle"));

    const { path } = await run(create(repoDir));

    await run(pruneStale(repoDir));

    const s = await stat(path);
    expect(s.isDirectory()).toBe(true);

    await run(remove(path));
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

describe("WorktreeManager git locale", () => {
  // Regression for #595: this module matches git's stderr (e.g. "invalid
  // reference") to decide control flow. git localizes those strings via
  // gettext, so in a non-English locale the matches silently fail and worktree
  // creation breaks. execGit must force LC_ALL=C so git always emits English.
  //
  // No non-English locale is installed on CI, so git would emit English
  // regardless and a plain behavioral test could not fail. Instead we shadow
  // the real `git` binary with a shim that records the LC_ALL it received,
  // asserting the module invokes git in the C locale even when the parent
  // process is set to a different one.
  it("invokes git with LC_ALL=C even when the process locale is non-English", async () => {
    if (process.platform === "win32") return; // POSIX shell shim
    const repoDir = await setupRepo();
    const shimDir = await mkdtemp(join(tmpdir(), "wt-git-shim-"));
    const logPath = join(shimDir, "lc_all.log");
    const gitShim = join(shimDir, "git");
    await writeFile(
      gitShim,
      `#!/bin/sh\nprintf '%s' "\${LC_ALL-}" > "${logPath}"\necho main\n`,
    );
    await chmod(gitShim, 0o755);

    const originalPath = process.env.PATH;
    const originalLcAll = process.env.LC_ALL;
    process.env.PATH = `${shimDir}:${originalPath ?? ""}`;
    process.env.LC_ALL = "en_US.UTF-8";
    try {
      const branch = await run(getCurrentBranch(repoDir));
      expect(branch).toBe("main");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalLcAll === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = originalLcAll;
    }

    expect(await readFile(logPath, "utf8")).toBe("C");
  });
});
