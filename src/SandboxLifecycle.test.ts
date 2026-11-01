import { Effect, Layer, Ref } from "effect";
import { exec } from "node:child_process";
import { constants, existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { assert, describe, expect, it } from "vitest";
import { SilentDisplay } from "./Display.js";
import type { DisplayEntry } from "./Display.js";
import type { ExecResult, SandboxService } from "./SandboxFactory.js";
import { makeLocalSandbox } from "./testSandbox.js";
import { ExecError, SyncError } from "./errors.js";
import { withSandboxLifecycle, runHostHooks } from "./SandboxLifecycle.js";

/**
 * Creates a sandbox that translates container paths to host paths,
 * simulating a bind-mount sandbox provider. When a command uses
 * `containerPath` as cwd, it's translated to `hostPath`.
 */
const makePathTranslatingSandbox = (
  hostPath: string,
  containerPath: string,
): SandboxService => {
  const translateCwd = (cwd?: string) =>
    cwd === containerPath ? hostPath : cwd;

  const baseSandbox = makeLocalSandbox(hostPath);

  return {
    exec: (command, options) =>
      baseSandbox.exec(command, {
        ...options,
        cwd: translateCwd(options?.cwd),
      }),
    copyIn: (hp, sp) => baseSandbox.copyIn(hp, sp),
    copyFileOut: (sp, hp) => baseSandbox.copyFileOut(sp, hp),
  };
};

const execAsync = promisify(exec);

const EXEC_OK: ExecResult = { stdout: "", stderr: "", exitCode: 0 };

/**
 * A fake sandbox whose exec hands the commands `matches` picks to `onMatch`,
 * and succeeds with no output for every other command.
 */
const sandboxRouting = (
  matches: (command: string) => boolean,
  onMatch: SandboxService["exec"],
): SandboxService => ({
  exec: (command, options) =>
    matches(command) ? onMatch(command, options) : Effect.succeed(EXEC_OK),
  copyIn: () => Effect.void,
  copyFileOut: () => Effect.void,
});

/** The result for the 1-based `attempt`; the last one repeats from then on. */
const resultForAttempt = (
  results: readonly ExecResult[],
  attempt: number,
): ExecResult => {
  const result = results[Math.min(attempt, results.length) - 1];
  assert.isDefined(result, `no result for attempt ${attempt}`);
  return result;
};

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

/**
 * A FIFO that blocks whoever opens it for reading until `release()` is called.
 * Point a host git step at it and that step hangs until released — so a
 * timeout override is guaranteed to fire however loaded the machine is,
 * rather than racing a real child process against a real 1ms timer.
 */
const makeFifoGate = async (dir: string) => {
  const path = join(dir, "gate.fifo");
  await execAsync(`mkfifo "${path}"`);
  return {
    path,
    release: async () => {
      // Swap a regular empty file in first: git may re-open the path, and
      // later opens must not block.
      const parked = `${path}.released`;
      await rename(path, parked);
      await writeFile(path, "");
      // Opening for read+write never blocks, and it wakes any reader stuck
      // opening the FIFO; closing it then gives that reader EOF.
      await (await open(parked, constants.O_RDWR)).close();
    },
  };
};

const testDisplayLayer = SilentDisplay.layer(
  Ref.unsafeMake<readonly DisplayEntry[]>([]),
);

const setup = async () => {
  const hostDir = await mkdtemp(join(tmpdir(), "host-"));
  const sandboxDir = await mkdtemp(join(tmpdir(), "sandbox-"));
  const sandboxRepoDir = join(sandboxDir, "repo");
  const sandbox = makeLocalSandbox(sandboxDir);
  return { hostDir, sandboxDir, sandboxRepoDir, sandbox };
};

describe("withSandboxLifecycle (worktree mode)", () => {
  const setupWorktree = async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await execAsync("git init -b main", { cwd: hostDir });
    await execAsync('git config user.email "test@test.com"', { cwd: hostDir });
    await execAsync('git config user.name "Test"', { cwd: hostDir });
    await writeFile(join(hostDir, "file.txt"), "original");
    await execAsync("git add file.txt", { cwd: hostDir });
    await execAsync('git commit -m "initial commit"', { cwd: hostDir });

    // Create a real git worktree from the host repo
    const worktreesDir = join(hostDir, ".sandcastle", "worktrees");
    await mkdir(worktreesDir, { recursive: true });
    const worktreeDir = join(worktreesDir, "test-worktree");
    await execAsync(
      `git worktree add -b "sandcastle/test" "${worktreeDir}" HEAD`,
      { cwd: hostDir },
    );

    const sandbox = makeLocalSandbox(worktreeDir);
    return { hostDir, worktreeDir, sandbox };
  };

  it("skips sync-in — worktree files are already accessible", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();

    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
        },
        sandbox,
        (ctx) =>
          Effect.gen(function* () {
            // Files from the host repo are already visible — no sync-in needed
            const result = yield* ctx.sandbox.exec("cat file.txt", {
              cwd: ctx.sandboxRepoDir,
            });
            expect(result.stdout.trim()).toBe("original");
          }),
      ).pipe(Effect.provide(testDisplayLayer)),
    );
  });

  it("commits in worktree are cherry-picked onto host's current branch", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();

    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
        },
        sandbox,
        (ctx) =>
          Effect.gen(function* () {
            yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec('git config user.name "Test"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec(
              String.raw`sh -c "echo worktree-content > worktree-file.txt && git add worktree-file.txt && git commit -m \"worktree commit\""`,
              { cwd: ctx.sandboxRepoDir },
            );
          }),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    // Commit is cherry-picked onto host's current branch (main)
    const { stdout: log } = await execAsync("git log --oneline main", {
      cwd: hostDir,
    });
    expect(log).toContain("worktree commit");

    // File is readable from the host's main branch
    const content = await readFile(join(hostDir, "worktree-file.txt"), "utf8");
    expect(content.trim()).toBe("worktree-content");
  });

  it("onSandboxReady hooks still run in worktree mode", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();

    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,

          hooks: {
            sandbox: {
              onSandboxReady: [{ command: "echo ready > ready-marker.txt" }],
            },
          },
        },
        sandbox,
        (ctx) =>
          Effect.gen(function* () {
            const result = yield* ctx.sandbox.exec("cat ready-marker.txt", {
              cwd: ctx.sandboxRepoDir,
            });
            expect(result.stdout.trim()).toBe("ready");
          }),
      ).pipe(Effect.provide(testDisplayLayer)),
    );
  });

  it("onSandboxReady hooks pass sudo option through to exec", async () => {
    const { hostDir, worktreeDir } = await setupWorktree();

    const execCalls: {
      command: string;
      options?: { sudo?: boolean; cwd?: string };
    }[] = [];

    // Custom sandbox layer that records exec calls
    const sandbox: SandboxService = {
      exec: (command, options) => {
        execCalls.push({ command, options });
        return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
      },
      copyIn: () => Effect.void,
      copyFileOut: () => Effect.void,
    };

    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          branch: "sandcastle/test",
          hooks: {
            sandbox: {
              onSandboxReady: [
                { command: "npm install" },
                { command: "apt-get install -y ffmpeg", sudo: true },
              ],
            },
          },
        },
        sandbox,
        () => Effect.succeed("ok"),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    // Find the hook exec calls (after git config calls)
    const hookCommands = new Set(["npm install", "apt-get install -y ffmpeg"]);
    const hookCalls = execCalls.filter((c) => hookCommands.has(c.command));
    expect(hookCalls).toHaveLength(2);
    const [npmCall, aptCall] = hookCalls;
    assert.isDefined(npmCall);
    assert.isDefined(aptCall);
    expect(npmCall).toStrictEqual(
      expect.objectContaining({ command: "npm install" }),
    );
    expect(npmCall.options?.sudo).toBeUndefined();
    expect(aptCall).toStrictEqual(
      expect.objectContaining({ command: "apt-get install -y ffmpeg" }),
    );
    expect(aptCall.options?.sudo).toBe(true);
  });

  it("onSandboxReady hooks run in parallel", async () => {
    const { hostDir, worktreeDir } = await setupWorktree();

    // Track the order of start/end events to verify parallel execution
    const events: string[] = [];

    const sandbox = sandboxRouting(
      (command) => ["slow-hook-a", "slow-hook-b"].includes(command),
      (command) => {
        events.push(`start:${command}`);
        return Effect.gen(function* () {
          // Yield to allow the other hook to start
          yield* Effect.yieldNow();
          events.push(`end:${command}`);
          return EXEC_OK;
        });
      },
    );

    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          branch: "sandcastle/test",
          hooks: {
            sandbox: {
              onSandboxReady: [
                { command: "slow-hook-a" },
                { command: "slow-hook-b" },
              ],
            },
          },
        },
        sandbox,
        () => Effect.succeed("ok"),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    // With parallel execution, both hooks should start before either ends
    expect(events).toStrictEqual([
      "start:slow-hook-a",
      "start:slow-hook-b",
      "end:slow-hook-a",
      "end:slow-hook-b",
    ]);
  });

  it("returns commits made in the worktree", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();

    const result = await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
        },
        sandbox,
        (ctx) =>
          Effect.gen(function* () {
            yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec('git config user.name "Test"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec(
              String.raw`sh -c "echo new > new-file.txt && git add new-file.txt && git commit -m \"new commit\""`,
              { cwd: ctx.sandboxRepoDir },
            );
          }),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    expect(result.commits).toHaveLength(1);
    // Commits are cherry-picked onto host's current branch (main)
    expect(result.branch).toBe("main");
  });

  it("returns empty commits when no work is done in worktree mode", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();

    const result = await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
        },
        sandbox,
        () => Effect.succeed("no-op"),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    expect(result.commits).toHaveLength(0);
    expect(result.result).toBe("no-op");
  });

  it("temp branch is deleted after cherry-pick", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();

    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
        },
        sandbox,
        (ctx) =>
          Effect.gen(function* () {
            yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec('git config user.name "Test"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec(
              String.raw`sh -c "echo content > new-file.txt && git add new-file.txt && git commit -m \"temp commit\""`,
              { cwd: ctx.sandboxRepoDir },
            );
          }),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    // The temp branch should no longer exist
    const { stdout } = await execAsync('git branch --list "sandcastle/test"', {
      cwd: hostDir,
    });
    expect(stdout.trim()).toBe("");
  });

  it("temp branch is deleted even when no commits were made", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();

    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
        },
        sandbox,
        () => Effect.succeed("no-op"),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    // Temp branch deleted even with no commits
    const { stdout } = await execAsync('git branch --list "sandcastle/test"', {
      cwd: hostDir,
    });
    expect(stdout.trim()).toBe("");
  });

  it("preserves temp branch and throws on merge conflict", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();

    await expect(
      Effect.runPromise(
        withSandboxLifecycle(
          {
            hostRepoDir: hostDir,
            sandboxRepoDir: worktreeDir,
          },
          sandbox,
          (ctx) =>
            Effect.gen(function* () {
              // Commit a change to file.txt in the worktree
              yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
                cwd: ctx.sandboxRepoDir,
              });
              yield* ctx.sandbox.exec('git config user.name "Test"', {
                cwd: ctx.sandboxRepoDir,
              });
              yield* ctx.sandbox.exec(
                String.raw`sh -c "echo worktree-version > file.txt && git add file.txt && git commit -m \"worktree change\""`,
                { cwd: ctx.sandboxRepoDir },
              );
              // Also commit a conflicting change to file.txt on main directly
              yield* Effect.promise(async () => {
                await execAsync(
                  String.raw`sh -c "echo main-version > file.txt && git add file.txt && git commit -m \"main conflict\""`,
                  { cwd: hostDir },
                );
              });
            }),
        ).pipe(Effect.provide(testDisplayLayer)),
      ),
    ).rejects.toThrow(/merge.*failed/i);

    // Temp branch should still exist for recovery
    const { stdout } = await execAsync('git branch --list "sandcastle/test"', {
      cwd: hostDir,
    });
    expect(stdout.trim()).not.toBe("");
  });

  it("aborts a conflicting merge so the host is clean, and the suggested retry works", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();

    const error = await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
        },
        sandbox,
        (ctx) =>
          Effect.gen(function* () {
            yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec('git config user.name "Test"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec(
              String.raw`sh -c "echo worktree-version > file.txt && git add file.txt && git commit -m \"worktree change\""`,
              { cwd: ctx.sandboxRepoDir },
            );
            yield* Effect.promise(async () => {
              await execAsync(
                String.raw`sh -c "echo main-version > file.txt && git add file.txt && git commit -m \"main conflict\""`,
                { cwd: hostDir },
              );
            });
          }),
      ).pipe(Effect.flip, Effect.provide(testDisplayLayer)),
    );

    // The host is not left mid-merge: no MERGE_HEAD, no conflict markers
    expect(existsSync(join(hostDir, ".git", "MERGE_HEAD"))).toBe(false);
    const { stdout: status } = await execAsync(
      "git status --porcelain --untracked-files=no",
      {
        cwd: hostDir,
      },
    );
    expect(status.trim()).toBe("");
    await expect(readFile(join(hostDir, "file.txt"), "utf8")).resolves.toBe(
      "main-version\n",
    );

    // The message says the merge was aborted and names a retry that works
    const { message } = error as { message: string };
    expect(message).toMatch(/aborted/i);
    expect(message).toContain("git merge sandcastle/test");
    // git's own output is included, not swallowed
    expect(message).toMatch(/CONFLICT/);

    // The suggested retry reaches the conflict itself, rather than failing
    // with "Merging is not possible because you have unmerged files".
    const retry = await execAsync("git merge sandcastle/test", {
      cwd: hostDir,
    }).then(
      () => "",
      // join() renders a missing stdout or stderr as "".
      (e: { stdout?: string; stderr?: string }) =>
        [e.stdout, e.stderr].join(""),
    );
    expect(retry).not.toMatch(/unmerged files/);
    expect(retry).toMatch(/CONFLICT/);
  });

  it("a merge git refuses (local changes) keeps those changes and includes git's reason", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();

    const error = await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
        },
        sandbox,
        (ctx) =>
          Effect.gen(function* () {
            yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec('git config user.name "Test"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec(
              String.raw`sh -c "echo worktree-version > file.txt && git add file.txt && git commit -m \"worktree change\""`,
              { cwd: ctx.sandboxRepoDir },
            );
            // An uncommitted edit on the host to the same file
            yield* Effect.promise(async () =>
              writeFile(join(hostDir, "file.txt"), "uncommitted host edit"),
            );
          }),
      ).pipe(Effect.flip, Effect.provide(testDisplayLayer)),
    );

    const { message } = error as { message: string };
    expect(message).toMatch(/would be overwritten/);
    expect(message).not.toMatch(/aborted/);
    await expect(readFile(join(hostDir, "file.txt"), "utf8")).resolves.toBe(
      "uncommitted host edit",
    );
  });

  it("succeeds with merge commit when host branch has diverged (non-conflicting)", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();

    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
        },
        sandbox,
        (ctx) =>
          Effect.gen(function* () {
            yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec('git config user.name "Test"', {
              cwd: ctx.sandboxRepoDir,
            });
            // Commit a change to a new file in the worktree
            yield* ctx.sandbox.exec(
              String.raw`sh -c "echo worktree-content > worktree-file.txt && git add worktree-file.txt && git commit -m \"worktree change\""`,
              { cwd: ctx.sandboxRepoDir },
            );
            // Commit a non-conflicting change to a different file on main directly
            yield* Effect.promise(async () => {
              await execAsync(
                String.raw`sh -c "echo main-content > main-file.txt && git add main-file.txt && git commit -m \"main change\""`,
                { cwd: hostDir },
              );
            });
          }),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    // Both files should exist on main after the merge
    const worktreeFile = await readFile(
      join(hostDir, "worktree-file.txt"),
      "utf8",
    );
    const mainFile = await readFile(join(hostDir, "main-file.txt"), "utf8");
    expect(worktreeFile.trim()).toBe("worktree-content");
    expect(mainFile.trim()).toBe("main-content");

    // Temp branch should be deleted
    const { stdout } = await execAsync('git branch --list "sandcastle/test"', {
      cwd: hostDir,
    });
    expect(stdout.trim()).toBe("");
  });

  it("cherry-pick works when sandboxRepoDir differs from host worktree path", async () => {
    const { hostDir, worktreeDir } = await setupWorktree();

    const containerPath = "/home/agent/workspace";
    const sandbox = makePathTranslatingSandbox(worktreeDir, containerPath);

    const result = await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: containerPath,

          hostWorktreePath: worktreeDir,
        },
        sandbox,
        (ctx) =>
          Effect.gen(function* () {
            yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec('git config user.name "Test"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec(
              String.raw`sh -c "echo docker-content > docker-file.txt && git add docker-file.txt && git commit -m \"docker worktree commit\""`,
              { cwd: ctx.sandboxRepoDir },
            );
          }),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    // Commit should be cherry-picked onto host's current branch (main)
    const { stdout: log } = await execAsync("git log --oneline main", {
      cwd: hostDir,
    });
    expect(log).toContain("docker worktree commit");
    expect(result.commits).toHaveLength(1);
    expect(result.branch).toBe("main");

    // Temp branch should be deleted
    const { stdout: branches } = await execAsync(
      'git branch --list "sandcastle/test"',
      { cwd: hostDir },
    );
    expect(branches.trim()).toBe("");
  });

  it("cherry-pick succeeds when worktree commits include a merge commit", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();

    const result = await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
        },
        sandbox,
        (ctx) =>
          Effect.gen(function* () {
            yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec('git config user.name "Test"', {
              cwd: ctx.sandboxRepoDir,
            });

            // Create a feature branch off the worktree, make a commit, then merge it back
            // This produces a merge commit — exactly what caused the production failure
            yield* ctx.sandbox.exec(
              String.raw`sh -c "git checkout -b feature/merge-test && echo feat > feat.txt && git add feat.txt && git commit -m \"feature commit\""`,
              { cwd: ctx.sandboxRepoDir },
            );
            yield* ctx.sandbox.exec(
              String.raw`sh -c "git checkout sandcastle/test && git merge --no-ff feature/merge-test -m \"Merge feature/merge-test\""`,
              { cwd: ctx.sandboxRepoDir },
            );
          }),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    // The feature commit should be cherry-picked onto main
    const { stdout: log } = await execAsync("git log --oneline main", {
      cwd: hostDir,
    });
    expect(log).toContain("feature commit");

    // Should report the cherry-picked (non-merge) commit
    expect(result.commits.length).toBeGreaterThanOrEqual(1);
    expect(result.branch).toBe("main");
  });

  it("merging multiple independent branches on temp branch lands all changes on host", async () => {
    // Reproduces the parallel planner bug: the merge agent works on a temp branch,
    // merges N branches that each independently modified files from the same main base.
    // git rev-list --no-merges walks into the merged branches and collects all original
    // commits, then cherry-picking them sequentially onto main fails because they
    // touch overlapping files from the same base.
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();

    const result = await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
        },
        sandbox,
        (ctx) =>
          Effect.gen(function* () {
            yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec('git config user.name "Test"', {
              cwd: ctx.sandboxRepoDir,
            });

            // Create two independent branches from main, each modifying the shared file
            yield* ctx.sandbox.exec(
              String.raw`sh -c "git checkout -b branch-a main && echo line-a >> file.txt && git add file.txt && git commit -m \"branch-a change\""`,
              { cwd: ctx.sandboxRepoDir },
            );
            yield* ctx.sandbox.exec(
              String.raw`sh -c "git checkout -b branch-b main && echo line-b >> file.txt && git add file.txt && git commit -m \"branch-b change\""`,
              { cwd: ctx.sandboxRepoDir },
            );

            // Back to temp branch — merge both (resolving the conflict on file.txt)
            yield* ctx.sandbox.exec(
              String.raw`sh -c "git checkout sandcastle/test && git merge --no-ff branch-a -m \"Merge branch-a\""`,
              { cwd: ctx.sandboxRepoDir },
            );
            // branch-b will conflict on file.txt — resolve it manually
            yield* ctx.sandbox.exec(
              `sh -c "git merge --no-ff branch-b -m \\"Merge branch-b\\" || (printf 'original\\nline-a\\nline-b\\n' > file.txt && git add file.txt && git commit --no-edit -m \\"Merge branch-b\\")"`,
              { cwd: ctx.sandboxRepoDir },
            );
          }),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    // Both changes should be on the host's main branch
    const content = await readFile(join(hostDir, "file.txt"), "utf8");
    expect(content).toContain("line-a");
    expect(content).toContain("line-b");

    expect(result.commits.length).toBeGreaterThanOrEqual(1);
    expect(result.branch).toBe("main");
  });

  it("sets host git user.name and user.email as global config in the sandbox", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();

    // setupWorktree sets user.email "test@test.com" and user.name "Test" locally in hostDir.
    // Verify these are propagated as --global config inside the sandbox.

    const result = await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          branch: "sandcastle/test",
        },
        sandbox,
        (ctx) =>
          Effect.gen(function* () {
            // Read the globally-set git config (--global) to confirm auto-propagation
            const emailResult = yield* ctx.sandbox.exec(
              "git config --global user.email",
            );
            const nameResult = yield* ctx.sandbox.exec(
              "git config --global user.name",
            );
            return {
              email: emailResult.stdout.trim(),
              name: nameResult.stdout.trim(),
            };
          }),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    expect(result.result.email).toBe("test@test.com");
    expect(result.result.name).toBe("Test");
  });

  it("gracefully skips git identity propagation when host has no git config", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();

    // Unset local user config so git config user.name/email returns nothing
    await execAsync("git config --unset user.email", { cwd: hostDir }).catch(
      () => {},
    );
    await execAsync("git config --unset user.name", { cwd: hostDir }).catch(
      () => {},
    );

    // Should not throw even when host has no git identity configured
    await expect(
      Effect.runPromise(
        withSandboxLifecycle(
          {
            hostRepoDir: hostDir,
            sandboxRepoDir: worktreeDir,
          },
          sandbox,
          () => Effect.succeed("ok"),
        ).pipe(Effect.provide(testDisplayLayer)),
      ),
    ).resolves.toBeDefined();
  });

  it("no cherry-pick when explicit branch is given", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();

    const result = await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          // explicit branch — commits stay on that branch, no cherry-pick
          branch: "sandcastle/test",
        },
        sandbox,
        (ctx) =>
          Effect.gen(function* () {
            yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec('git config user.name "Test"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec(
              String.raw`sh -c "echo explicit > explicit-file.txt && git add explicit-file.txt && git commit -m \"explicit branch commit\""`,
              { cwd: ctx.sandboxRepoDir },
            );
          }),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    // Branch stays as the explicit branch
    expect(result.branch).toBe("sandcastle/test");
    expect(result.commits).toHaveLength(1);

    // Commit is on sandcastle/test, NOT cherry-picked to main
    const { stdout: mainLog } = await execAsync("git log --oneline main", {
      cwd: hostDir,
    });
    expect(mainLog).not.toContain("explicit branch commit");

    const { stdout: branchLog } = await execAsync(
      'git log --oneline "sandcastle/test"',
      { cwd: hostDir },
    );
    expect(branchLog).toContain("explicit branch commit");
  });

  it("calls applyToHost after work completes but before merge operations", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();

    const callOrder: string[] = [];

    const result = await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          applyToHost: () =>
            Effect.sync(() => {
              callOrder.push("applyToHost");
            }) as Effect.Effect<void, SyncError>,
        },
        sandbox,
        (ctx) =>
          Effect.gen(function* () {
            callOrder.push("work");
            yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec('git config user.name "Test"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec(
              String.raw`sh -c "echo content > new.txt && git add new.txt && git commit -m \"test commit\""`,
              { cwd: ctx.sandboxRepoDir },
            );
          }),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    // applyToHost should be called after work but before the merge
    expect(callOrder).toStrictEqual(["work", "applyToHost"]);
    // Commits should still be collected properly
    expect(result.commits).toHaveLength(1);
  });

  it("records baseHead from the host worktree, not from inside the sandbox", async () => {
    const { hostDir, worktreeDir } = await setupWorktree();

    // Use a container path that differs from the host worktree path
    const containerPath = "/home/agent/workspace";
    const sandbox = makePathTranslatingSandbox(worktreeDir, containerPath);

    let capturedBaseHead = "";
    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: containerPath,
          hostWorktreePath: worktreeDir,
        },
        sandbox,
        (ctx) =>
          Effect.gen(function* () {
            capturedBaseHead = ctx.baseHead;
          }),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    // baseHead should match the host worktree HEAD, not some sandbox-internal value
    const hostHead = await getHead(worktreeDir);
    expect(capturedBaseHead).toBe(hostHead);
  });

  it("applyToHost error propagates as SyncError", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();

    await expect(
      Effect.runPromise(
        withSandboxLifecycle(
          {
            hostRepoDir: hostDir,
            sandboxRepoDir: worktreeDir,
            applyToHost: () =>
              Effect.fail(new SyncError({ message: "sync failed" })),
          },
          sandbox,
          () => Effect.succeed("ok"),
        ).pipe(Effect.provide(testDisplayLayer)),
      ),
    ).rejects.toThrow("sync failed");
  });

  it("logs 'No commits to sync out' when applyToHost is provided but no commits", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();
    const displayRef = Ref.unsafeMake<readonly DisplayEntry[]>([]);
    const displayLayer = SilentDisplay.layer(displayRef);

    const entries = await Effect.runPromise(
      Effect.gen(function* () {
        yield* withSandboxLifecycle(
          {
            hostRepoDir: hostDir,
            sandboxRepoDir: worktreeDir,
            branch: "sandcastle/test",
            applyToHost: () => Effect.void,
          },
          sandbox,
          () => Effect.succeed("ok"),
        );
        return yield* Ref.get(displayRef);
      }).pipe(Effect.provide(displayLayer)),
    );

    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "taskLog",
        title: "No commits to sync out",
      }),
    );
  });

  it("logs 'Syncing N commits to host' when applyToHost is provided with commits", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();
    const displayRef = Ref.unsafeMake<readonly DisplayEntry[]>([]);
    const displayLayer = SilentDisplay.layer(displayRef);

    const entries = await Effect.runPromise(
      Effect.gen(function* () {
        yield* withSandboxLifecycle(
          {
            hostRepoDir: hostDir,
            sandboxRepoDir: worktreeDir,
            branch: "sandcastle/test",
            applyToHost: () => Effect.void,
          },
          sandbox,
          (ctx) =>
            ctx.sandbox
              .exec(
                String.raw`sh -c "echo new > sync-file.txt && git add sync-file.txt && git commit -m \"sync commit\""`,
                { cwd: ctx.sandboxRepoDir },
              )
              .pipe(Effect.asVoid),
        );
        return yield* Ref.get(displayRef);
      }).pipe(Effect.provide(displayLayer)),
    );

    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "taskLog",
        title: "Syncing 1 commit to host",
      }),
    );
  });

  it("does not log sync taskLog when applyToHost is not provided", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();
    const displayRef = Ref.unsafeMake<readonly DisplayEntry[]>([]);
    const displayLayer = SilentDisplay.layer(displayRef);

    const entries = await Effect.runPromise(
      Effect.gen(function* () {
        yield* withSandboxLifecycle(
          {
            hostRepoDir: hostDir,
            sandboxRepoDir: worktreeDir,
            branch: "sandcastle/test",
          },
          sandbox,
          () => Effect.succeed("ok"),
        );
        return yield* Ref.get(displayRef);
      }).pipe(Effect.provide(displayLayer)),
    );

    const syncLog = entries
      .filter((e) => e._tag === "taskLog")
      .find((e) => /^(?:No commits to sync out$|Syncing)/u.test(e.title));
    expect(syncLog).toBeUndefined();
  });

  it("logs 'Merging to {branch}' taskLog in temp branch mode with commits", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();
    const displayRef = Ref.unsafeMake<readonly DisplayEntry[]>([]);
    const displayLayer = SilentDisplay.layer(displayRef);

    const entries = await Effect.runPromise(
      Effect.gen(function* () {
        yield* withSandboxLifecycle(
          {
            hostRepoDir: hostDir,
            sandboxRepoDir: worktreeDir,
          },
          sandbox,
          (ctx) =>
            Effect.gen(function* () {
              yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
                cwd: ctx.sandboxRepoDir,
              });
              yield* ctx.sandbox.exec('git config user.name "Test"', {
                cwd: ctx.sandboxRepoDir,
              });
              yield* ctx.sandbox.exec(
                String.raw`sh -c "echo content > merge-file.txt && git add merge-file.txt && git commit -m \"merge test\""`,
                { cwd: ctx.sandboxRepoDir },
              );
            }),
        );
        return yield* Ref.get(displayRef);
      }).pipe(Effect.provide(displayLayer)),
    );

    expect(entries).toContainEqual(
      expect.objectContaining({ _tag: "taskLog", title: "Merging to main" }),
    );
  });

  it("logs 'Collecting commits' taskLog after agent work", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();
    const displayRef = Ref.unsafeMake<readonly DisplayEntry[]>([]);
    const displayLayer = SilentDisplay.layer(displayRef);

    const entries = await Effect.runPromise(
      Effect.gen(function* () {
        yield* withSandboxLifecycle(
          {
            hostRepoDir: hostDir,
            sandboxRepoDir: worktreeDir,
            branch: "sandcastle/test",
          },
          sandbox,
          () => Effect.succeed("ok"),
        );
        return yield* Ref.get(displayRef);
      }).pipe(Effect.provide(displayLayer)),
    );

    expect(entries).toContainEqual(
      expect.objectContaining({ _tag: "taskLog", title: "Collecting commits" }),
    );
  });

  it("host.onSandboxReady hooks run on the host with worktree cwd", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();

    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          branch: "sandcastle/test",
          hooks: {
            host: {
              onSandboxReady: [
                { command: "echo host-hook-ran > host-marker.txt" },
              ],
            },
          },
        },
        sandbox,
        () => Effect.succeed("ok"),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    // The marker should exist on the host worktree (cwd = worktreeDir)
    const content = await readFile(
      join(worktreeDir, "host-marker.txt"),
      "utf8",
    );
    expect(content.trim()).toBe("host-hook-ran");
  });

  it("host.onSandboxReady and sandbox.onSandboxReady run in parallel", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();

    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          branch: "sandcastle/test",
          hooks: {
            host: {
              onSandboxReady: [{ command: "echo host-ready > host-ready.txt" }],
            },
            sandbox: {
              onSandboxReady: [
                { command: "echo sandbox-ready > sandbox-ready.txt" },
              ],
            },
          },
        },
        sandbox,
        () => Effect.succeed("ok"),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    // Both markers should exist
    const hostContent = await readFile(
      join(worktreeDir, "host-ready.txt"),
      "utf8",
    );
    expect(hostContent.trim()).toBe("host-ready");

    const sandboxContent = await readFile(
      join(worktreeDir, "sandbox-ready.txt"),
      "utf8",
    );
    expect(sandboxContent.trim()).toBe("sandbox-ready");
  });

  it("host.onSandboxReady hook is killed when signal fires", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();
    const ac = new AbortController();

    const promise = Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          branch: "sandcastle/test",
          signal: ac.signal,
          hooks: {
            host: {
              onSandboxReady: [{ command: "sleep 60" }],
            },
          },
        },
        sandbox,
        () => Effect.succeed("ok"),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    setTimeout(() => ac.abort("cancelled"), 50);
    await expect(promise).rejects.toThrow(
      "Command aborted: sleep 60 (cancelled)",
    );
  });

  it("sandbox.onSandboxReady hook is killed when signal fires", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();
    const ac = new AbortController();

    const promise = Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          branch: "sandcastle/test",
          signal: ac.signal,
          hooks: {
            sandbox: {
              onSandboxReady: [{ command: "sleep 60" }],
            },
          },
        },
        sandbox,
        () => Effect.succeed("ok"),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    setTimeout(() => ac.abort("cancelled"), 50);
    await expect(promise).rejects.toThrow("Aborted: cancelled");
  });

  it("hooks receive never-aborted signal when no signal is provided", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();

    // Should work normally — hooks complete without issues
    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          branch: "sandcastle/test",
          hooks: {
            host: {
              onSandboxReady: [{ command: "echo ok > host-signal-test.txt" }],
            },
            sandbox: {
              onSandboxReady: [
                { command: "echo ok > sandbox-signal-test.txt" },
              ],
            },
          },
        },
        sandbox,
        () => Effect.succeed("ok"),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    const content = await readFile(
      join(worktreeDir, "host-signal-test.txt"),
      "utf8",
    );
    expect(content.trim()).toBe("ok");
  });

  it("host.onSandboxReady hook failure propagates error", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();

    await expect(
      Effect.runPromise(
        withSandboxLifecycle(
          {
            hostRepoDir: hostDir,
            sandboxRepoDir: worktreeDir,
            branch: "sandcastle/test",
            hooks: {
              host: {
                onSandboxReady: [{ command: "exit 1" }],
              },
            },
          },
          sandbox,
          () => Effect.succeed("ok"),
        ).pipe(Effect.provide(testDisplayLayer)),
      ),
    ).rejects.toThrow(/Host hook failed/);
  });

  it("sandbox.onSandboxReady respects per-hook timeoutMs", async () => {
    const { hostDir, worktreeDir } = await setupWorktree();

    const sandbox = sandboxRouting(
      (command) => command === "slow-install",
      // Simulate a command that takes longer than the short timeout
      () => Effect.as(Effect.sleep("2 seconds"), EXEC_OK),
    );

    const result = Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          branch: "sandcastle/test",
          hooks: {
            sandbox: {
              onSandboxReady: [{ command: "slow-install", timeoutMs: 500 }],
            },
          },
        },
        sandbox,
        () => Effect.succeed("ok"),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    await expect(result).rejects.toThrow(/timed out/);
  });

  it("host.onSandboxReady respects per-hook timeoutMs", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();

    const result = Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          branch: "sandcastle/test",
          hooks: {
            host: {
              onSandboxReady: [{ command: "sleep 2", timeoutMs: 500 }],
            },
          },
        },
        sandbox,
        () => Effect.succeed("ok"),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    await expect(result).rejects.toThrow(/timed out/);
  });

  it("host.onSandboxReady kills the hook's whole process tree on timeout", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();

    const result = Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          branch: "sandcastle/test",
          hooks: {
            host: {
              onSandboxReady: [{ command: ORPHAN_HOOK, timeoutMs: 500 }],
            },
          },
        },
        sandbox,
        () => Effect.succeed("ok"),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    await expect(result).rejects.toThrow(/timed out after 500ms/);
    await waitForProcessGone(await readPid(worktreeDir));
  });

  it("sandbox.onSandboxReady uses default timeout when timeoutMs omitted", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();

    // A fast hook with no timeoutMs should succeed with the default 60s timeout
    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          branch: "sandcastle/test",
          hooks: {
            sandbox: {
              onSandboxReady: [{ command: "echo default-timeout > dt.txt" }],
            },
          },
        },
        sandbox,
        (ctx) =>
          Effect.gen(function* () {
            const result = yield* ctx.sandbox.exec("cat dt.txt", {
              cwd: ctx.sandboxRepoDir,
            });
            expect(result.stdout.trim()).toBe("default-timeout");
          }),
      ).pipe(Effect.provide(testDisplayLayer)),
    );
  });

  it("retries a transient exit-126 git setup failure, then succeeds", async () => {
    const { hostDir, worktreeDir } = await setupWorktree();

    let safeDirAttempts = 0;
    // Sandbox where the first `safe.directory` config attempt exits 126
    // (overlayfs/exec race seen under heavy parallelism), then succeeds.
    // Effect.sync defers per-run so retries re-evaluate, matching how the
    // real exec (Effect.tryPromise) re-invokes the SDK on each attempt.
    const sandbox = sandboxRouting(
      (command) => command.includes("safe.directory"),
      () =>
        Effect.sync(() => {
          safeDirAttempts++;
          return resultForAttempt(
            [{ stdout: "", stderr: "cannot exec", exitCode: 126 }, EXEC_OK],
            safeDirAttempts,
          );
        }),
    );

    const result = await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          branch: "sandcastle/test",
        },
        sandbox,
        () => Effect.succeed("ok"),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    expect(safeDirAttempts).toBe(2);
    expect(result.result).toBe("ok");
  });

  it("does not retry a non-transient git setup failure", async () => {
    const { hostDir, worktreeDir } = await setupWorktree();

    let safeDirAttempts = 0;
    const sandbox = sandboxRouting(
      (command) => command.includes("safe.directory"),
      () =>
        Effect.sync(() => {
          safeDirAttempts++;
          return { stdout: "", stderr: "fatal: bad config", exitCode: 1 };
        }),
    );

    await expect(
      Effect.runPromise(
        withSandboxLifecycle(
          {
            hostRepoDir: hostDir,
            sandboxRepoDir: worktreeDir,
            branch: "sandcastle/test",
          },
          sandbox,
          () => Effect.succeed("ok"),
        ).pipe(Effect.provide(testDisplayLayer)),
      ),
    ).rejects.toThrow(/exit 1/);

    expect(safeDirAttempts).toBe(1);
  });

  it("respects a gitSetupMs timeout override", async () => {
    const { hostDir, worktreeDir } = await setupWorktree();

    // The git safe.directory setup command takes longer than the short
    // gitSetupMs override, so it should time out rather than succeed under
    // the default 10s timeout.
    const sandbox = sandboxRouting(
      (command) => command.includes("safe.directory"),
      () => Effect.as(Effect.sleep("2 seconds"), EXEC_OK),
    );

    const result = Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          branch: "sandcastle/test",
          timeouts: { gitSetupMs: 300 },
        },
        sandbox,
        () => Effect.succeed("ok"),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    await expect(result).rejects.toThrow(/Git command timed out after 300ms/);
  });

  it("respects a commitCollectionMs timeout override", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();
    const gate = await makeFifoGate(hostDir);

    // Once the work is done, gate the host repo's config on the FIFO: the
    // commit-collection `git rev-list` then blocks reading its config until
    // released, so only the 1ms override (not the 30s default) can end it.
    const result = Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          branch: "sandcastle/test",
          timeouts: { commitCollectionMs: 1 },
        },
        sandbox,
        () =>
          Effect.promise(async () =>
            execAsync(`git config include.path "${gate.path}"`, {
              cwd: hostDir,
            }),
          ),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    try {
      await expect(result).rejects.toThrow(
        /Commit collection timed out after 1ms/,
      );
    } finally {
      await gate.release();
    }
  });

  it("respects a mergeToHostMs timeout override", async () => {
    const { hostDir, worktreeDir, sandbox } = await setupWorktree();

    // Host-side git runs hooks from nowhere, so gate the merge on config
    // instead: once the work has committed, the host checkout (on `main`)
    // includes the FIFO, so the host-side `git merge` blocks reading its
    // config until released, and only the 1ms override (not the 30s default)
    // can end it. The worktree is on its own branch, so the commit count read
    // there before the merge is not gated.
    const gate = await makeFifoGate(hostDir);

    // Merge-to-head path (no explicit branch) with a real commit, so the
    // host-side merge runs and hits the gate.
    const result = Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          timeouts: { mergeToHostMs: 1 },
        },
        sandbox,
        (ctx) =>
          Effect.gen(function* () {
            yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec('git config user.name "Test"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec(
              String.raw`sh -c "echo wt > wt.txt && git add wt.txt && git commit -m \"wt commit\""`,
              { cwd: ctx.sandboxRepoDir },
            );
            yield* Effect.promise(async () =>
              execAsync(
                `git config "includeIf.onbranch:main.path" "${gate.path}"`,
                { cwd: hostDir },
              ),
            );
          }),
      ).pipe(Effect.provide(testDisplayLayer)),
    );

    try {
      await expect(result).rejects.toThrow(/timed out after 1ms/);
    } finally {
      await gate.release();
    }
  });

  it("fails after exhausting retries on a persistent transient failure", async () => {
    const { hostDir, worktreeDir } = await setupWorktree();

    let safeDirAttempts = 0;
    const sandbox = sandboxRouting(
      (command) => command.includes("safe.directory"),
      () =>
        Effect.sync(() => {
          safeDirAttempts++;
          return { stdout: "", stderr: "cannot exec", exitCode: 126 };
        }),
    );

    await expect(
      Effect.runPromise(
        withSandboxLifecycle(
          {
            hostRepoDir: hostDir,
            sandboxRepoDir: worktreeDir,
            branch: "sandcastle/test",
          },
          sandbox,
          () => Effect.succeed("ok"),
        ).pipe(Effect.provide(testDisplayLayer)),
      ),
    ).rejects.toThrow(/exit 126/);

    // Initial attempt + bounded retries (does not loop forever)
    expect(safeDirAttempts).toBeGreaterThan(1);
    expect(safeDirAttempts).toBeLessThanOrEqual(4);
  });
});

/**
 * Resolves once no process with this pid exists (polls `kill(pid, 0)`),
 * or rejects with the pid still alive after `withinMs`.
 */
const waitForProcessGone = async (pid: number, withinMs = 3000) => {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  process.kill(pid, "SIGKILL");
  throw new Error(
    `process ${pid} still alive ${withinMs}ms after the hook ended`,
  );
};

/** A hook that backgrounds a grandchild `sleep`, records its pid, and waits. */
const ORPHAN_HOOK = "sleep 30 & echo $! > sleep.pid; wait";

const readPid = async (dir: string) =>
  Number((await readFile(join(dir, "sleep.pid"), "utf8")).trim());

describe("runHostHooks", () => {
  it("runs hooks sequentially in declared order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-hooks-"));

    await Effect.runPromise(
      runHostHooks(
        [
          { command: "echo first > order.txt" },
          { command: "echo second >> order.txt" },
        ],
        dir,
      ),
    );

    const content = await readFile(join(dir, "order.txt"), "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toStrictEqual(["first", "second"]);
  });

  it("fails fast on non-zero exit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-hooks-"));

    await expect(
      Effect.runPromise(
        runHostHooks(
          [
            { command: "exit 1" },
            { command: "echo should-not-run > unreachable.txt" },
          ],
          dir,
        ),
      ),
    ).rejects.toThrow(/Host hook failed/);
  });

  it("uses the provided cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-hooks-"));

    await Effect.runPromise(runHostHooks([{ command: "pwd > cwd.txt" }], dir));

    const content = await readFile(join(dir, "cwd.txt"), "utf8");
    expect(content.trim()).toBe(dir);
  });

  it("aborts a running hook when signal fires", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-hooks-"));
    const ac = new AbortController();

    // Start a long-running hook then abort after a short delay
    const promise = Effect.runPromise(
      runHostHooks([{ command: "sleep 60" }], dir, ac.signal),
    );

    // Give the process time to start, then abort
    setTimeout(() => {
      ac.abort("cancelled");
    }, 50);

    await expect(promise).rejects.toThrow(
      "Command aborted: sleep 60 (cancelled)",
    );
  });

  it("works normally when signal is not provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-hooks-"));

    // No signal arg — should work as before
    await Effect.runPromise(
      runHostHooks([{ command: "echo ok > result.txt" }], dir),
    );

    const content = await readFile(join(dir, "result.txt"), "utf8");
    expect(content.trim()).toBe("ok");
  });

  it("respects per-hook timeoutMs override", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-hooks-"));

    // sleep 2 with a 500ms timeout should fail
    await expect(
      Effect.runPromise(
        runHostHooks([{ command: "sleep 2", timeoutMs: 500 }], dir),
      ),
    ).rejects.toThrow(/timed out/);
  });

  it("kills the hook's whole process tree when it times out", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-hooks-"));

    await expect(
      Effect.runPromise(
        runHostHooks([{ command: ORPHAN_HOOK, timeoutMs: 500 }], dir),
      ),
    ).rejects.toThrow(/timed out after 500ms/);

    await waitForProcessGone(await readPid(dir));
  });

  it("kills the hook's whole process tree when the signal aborts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-hooks-"));
    const ac = new AbortController();
    setTimeout(() => {
      ac.abort("cancelled");
    }, 500);

    await expect(
      Effect.runPromise(
        runHostHooks([{ command: ORPHAN_HOOK }], dir, ac.signal),
      ),
    ).rejects.toThrow("Command aborted");

    await waitForProcessGone(await readPid(dir));
  });

  it("uses default timeout when timeoutMs is not specified", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-hooks-"));

    // A fast command should succeed with default 60s timeout
    await Effect.runPromise(
      runHostHooks([{ command: "echo ok > timeout-default.txt" }], dir),
    );

    const content = await readFile(join(dir, "timeout-default.txt"), "utf8");
    expect(content.trim()).toBe("ok");
  });
});
