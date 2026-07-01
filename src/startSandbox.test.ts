import { Duration, Effect, Exit, TestClock, TestContext } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { exec } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createBindMountSandboxProvider,
  createIsolatedSandboxProvider,
  type BindMountSandboxHandle,
  type IsolatedSandboxHandle,
} from "./SandboxProvider.js";
import { SANDBOX_REPO_DIR } from "./SandboxFactory.js";
import { startSandbox, COPY_PATHS_TIMEOUT_MS } from "./startSandbox.js";
import { testIsolated } from "./sandboxes/test-isolated.js";
import { CopyToWorktreeTimeoutError } from "./errors.js";
import { DEFAULT_SANDBOX_SKILLS_DIR } from "./AgentSkills.js";

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

const makeSkill = async (root: string, name: string) => {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `# ${name}\n`);
  return dir;
};

describe("startSandbox", () => {
  describe("bind-mount provider", () => {
    it("calls provider.create with mounts and env", async () => {
      const createCalls: any[] = [];
      const provider = createBindMountSandboxProvider({
        name: "test",
        create: async (options) => {
          createCalls.push(options);
          return {
            worktreePath: SANDBOX_REPO_DIR,
            exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
            copyFileIn: async () => {},
            copyFileOut: async () => {},
            close: async () => {},
          };
        },
      });

      const gitMounts = [{ hostPath: "/repo/.git", sandboxPath: "/repo/.git" }];
      const result = await Effect.runPromise(
        startSandbox({
          provider,
          hostRepoDir: "/repo",
          env: { FOO: "bar" },
          worktreeOrRepoPath: "/worktree",
          gitMounts,
          repoDir: SANDBOX_REPO_DIR,
        }),
      );

      expect(createCalls).toHaveLength(1);
      expect(createCalls[0].mounts).toContainEqual({
        hostPath: "/worktree",
        sandboxPath: SANDBOX_REPO_DIR,
      });
      expect(createCalls[0].mounts).toContainEqual({
        hostPath: "/repo/.git",
        sandboxPath: "/repo/.git",
      });
      expect(createCalls[0].env).toEqual({ FOO: "bar" });
      expect(result.worktreePath).toBe(SANDBOX_REPO_DIR);
      expect(result.handle).toBeDefined();
      expect(result.sandbox).toBeDefined();
    });

    it("returns a working sandboxLayer", async () => {
      const provider = createBindMountSandboxProvider({
        name: "test",
        create: async () => ({
          worktreePath: SANDBOX_REPO_DIR,
          exec: async () => ({ stdout: "hello", stderr: "", exitCode: 0 }),
          copyFileIn: async () => {},
          copyFileOut: async () => {},
          close: async () => {},
        }),
      });

      const { sandbox } = await Effect.runPromise(
        startSandbox({
          provider,
          hostRepoDir: "/repo",
          env: {},
          worktreeOrRepoPath: "/worktree",
          gitMounts: [],
          repoDir: SANDBOX_REPO_DIR,
        }),
      );

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* sandbox.exec("echo hello");
        }),
      );

      expect(result.stdout).toBe("hello");
    });

    it("adds readonly skill mounts outside the repository worktree", async () => {
      const skillRoot = await mkdtemp(join(tmpdir(), "sandcastle-skill-"));
      try {
        const skillDir = await makeSkill(skillRoot, "review-skill");
        const skillSandboxPath = `${DEFAULT_SANDBOX_SKILLS_DIR}/review-skill`;
        const createCalls: any[] = [];
        const provider = createBindMountSandboxProvider({
          name: "test",
          create: async (options) => {
            createCalls.push(options);
            return {
              worktreePath: SANDBOX_REPO_DIR,
              exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
              copyFileIn: async () => {},
              copyFileOut: async () => {},
              close: async () => {},
            };
          },
        });

        await Effect.runPromise(
          startSandbox({
            provider,
            hostRepoDir: "/repo",
            env: {},
            worktreeOrRepoPath: "/worktree",
            gitMounts: [],
            repoDir: SANDBOX_REPO_DIR,
            skills: [
              {
                name: "review-skill",
                hostPath: skillDir,
                sandboxPath: skillSandboxPath,
                readonly: true,
              },
            ],
          }),
        );

        const skillMount = createCalls[0].mounts.find(
          (mount: { hostPath: string }) => mount.hostPath === skillDir,
        );
        expect(skillMount).toEqual({
          hostPath: skillDir,
          sandboxPath: skillSandboxPath,
          readonly: true,
        });
        expect(skillMount.sandboxPath.startsWith(SANDBOX_REPO_DIR)).toBe(false);
      } finally {
        await rm(skillRoot, { recursive: true, force: true });
      }
    });
  });

  describe("isolated provider", () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
      await Promise.all(
        tempDirs.map((d) => rm(d, { recursive: true, force: true })),
      );
      tempDirs.length = 0;
    });

    it("creates handle, syncs repo, and returns sandboxLayer", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
      tempDirs.push(hostDir);
      await initRepo(hostDir);
      await commitFile(hostDir, "hello.txt", "hello world", "initial");

      const provider = testIsolated();
      const { handle, sandbox, worktreePath } = await Effect.runPromise(
        startSandbox({
          provider,
          hostRepoDir: hostDir,
          env: {},
        }),
      );

      // Verify the repo was synced - hello.txt should exist
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* sandbox.exec("cat hello.txt");
        }),
      );

      expect(result.stdout.trim()).toBe("hello world");
      expect(worktreePath).toBeDefined();
      await handle.close();
    });

    it("copies copyPaths into the sandbox after sync", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
      tempDirs.push(hostDir);
      await initRepo(hostDir);
      await commitFile(hostDir, "hello.txt", "hello", "initial");
      await writeFile(join(hostDir, "extra.txt"), "extra content");

      const provider = testIsolated();
      const { handle, sandbox } = await Effect.runPromise(
        startSandbox({
          provider,
          hostRepoDir: hostDir,
          env: {},
          copyPaths: ["extra.txt"],
        }),
      );

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* sandbox.exec("cat extra.txt");
        }),
      );

      expect(result.stdout.trim()).toBe("extra content");
      await handle.close();
    });

    it("copies skills to the stable sandbox skills path, not into the worktree", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
      tempDirs.push(hostDir);
      const skillRoot = await mkdtemp(join(tmpdir(), "sandcastle-skill-"));
      tempDirs.push(skillRoot);
      await initRepo(hostDir);
      await commitFile(hostDir, "hello.txt", "hello", "initial");
      const skillDir = await makeSkill(skillRoot, "review-skill");
      const skillSandboxPath = `${DEFAULT_SANDBOX_SKILLS_DIR}/review-skill`;
      const skillCopies: Array<{ hostPath: string; sandboxPath: string }> = [];

      const realProvider = testIsolated();
      const provider = createIsolatedSandboxProvider({
        name: "recording-isolated",
        create: async (options) => {
          const handle = await realProvider.create(options);
          return {
            ...handle,
            copyIn: async (hostPath: string, sandboxPath: string) => {
              if (hostPath === skillDir) {
                skillCopies.push({ hostPath, sandboxPath });
                return;
              }
              await handle.copyIn(hostPath, sandboxPath);
            },
          };
        },
      });

      const { handle, sandbox } = await Effect.runPromise(
        startSandbox({
          provider,
          hostRepoDir: hostDir,
          env: {},
          skills: [
            {
              name: "review-skill",
              hostPath: skillDir,
              sandboxPath: skillSandboxPath,
              readonly: true,
            },
          ],
        }),
      );

      try {
        expect(skillCopies).toEqual([
          { hostPath: skillDir, sandboxPath: skillSandboxPath },
        ]);

        const result = await Effect.runPromise(
          sandbox.exec(
            "test ! -e .sandcastle/skills/review-skill/SKILL.md && echo not-in-worktree",
          ),
        );
        expect(result.stdout.trim()).toBe("not-in-worktree");
      } finally {
        await handle.close();
      }
    });

    it("closes the isolated handle when skill copy fails", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
      tempDirs.push(hostDir);
      const skillRoot = await mkdtemp(join(tmpdir(), "sandcastle-skill-"));
      tempDirs.push(skillRoot);
      await initRepo(hostDir);
      await commitFile(hostDir, "hello.txt", "hello", "initial");
      const skillDir = await makeSkill(skillRoot, "review-skill");
      const skillSandboxPath = `${DEFAULT_SANDBOX_SKILLS_DIR}/review-skill`;
      let closeCalls = 0;

      const realProvider = testIsolated();
      const provider = createIsolatedSandboxProvider({
        name: "failing-skill-copy",
        create: async (options) => {
          const handle = await realProvider.create(options);
          return {
            ...handle,
            copyIn: async (hostPath: string, sandboxPath: string) => {
              if (hostPath === skillDir) {
                throw new Error("skill copy failed");
              }
              await handle.copyIn(hostPath, sandboxPath);
            },
            close: async () => {
              closeCalls++;
              await handle.close();
            },
          };
        },
      });

      await expect(
        Effect.runPromise(
          startSandbox({
            provider,
            hostRepoDir: hostDir,
            env: {},
            skills: [
              {
                name: "review-skill",
                hostPath: skillDir,
                sandboxPath: skillSandboxPath,
                readonly: true,
              },
            ],
          }),
        ),
      ).rejects.toThrow(
        "Failed to copy skill review-skill into sandbox: skill copy failed",
      );
      expect(closeCalls).toBe(1);
    });

    it("times out when copyIn hangs", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
      tempDirs.push(hostDir);
      await initRepo(hostDir);
      await commitFile(hostDir, "hello.txt", "hello", "initial");
      await writeFile(join(hostDir, "hang.txt"), "will hang");

      const realProvider = testIsolated();
      const hangingProvider = createIsolatedSandboxProvider({
        name: "hanging-copy",
        create: async (options) => {
          const handle = await realProvider.create(options);
          return {
            ...handle,
            copyIn: (hostPath: string, sandboxPath: string) => {
              // Allow syncIn's copyIn calls (bundle files) to succeed,
              // but hang on everything else
              if (sandboxPath.includes("repo.bundle")) {
                return handle.copyIn(hostPath, sandboxPath);
              }
              return new Promise<void>(() => {}); // never resolves
            },
          };
        },
      });

      // Fork startSandbox and advance the TestClock after syncIn completes.
      // Container create and syncIn use real promises that resolve in real time.
      // With TestClock, their withTimeout timers won't fire until we advance,
      // so they complete successfully. Then we advance past COPY_PATHS_TIMEOUT_MS.
      const program = Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          startSandbox({
            provider: hangingProvider,
            hostRepoDir: hostDir,
            env: {},
            copyPaths: ["hang.txt"],
          }),
        );
        // Yield to allow real async operations (create, syncIn) to complete
        yield* Effect.yieldNow();
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 2000)));
        yield* Effect.yieldNow();
        // Now advance past the copyPaths timeout
        yield* TestClock.adjust(Duration.millis(COPY_PATHS_TIMEOUT_MS + 1));
        return yield* fiber.await;
      }).pipe(Effect.provide(TestContext.TestContext));

      const exit = await Effect.runPromise(program);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        const error = exit.cause.error;
        expect(error).toBeInstanceOf(CopyToWorktreeTimeoutError);
        const timeoutError = error as CopyToWorktreeTimeoutError;
        expect(timeoutError.timeoutMs).toBe(COPY_PATHS_TIMEOUT_MS);
        expect(timeoutError.paths).toEqual(["hang.txt"]);
      } else {
        throw new Error("Expected Fail cause");
      }
    }, 15_000);

    it("skips missing copyPaths without error", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
      tempDirs.push(hostDir);
      await initRepo(hostDir);
      await commitFile(hostDir, "hello.txt", "hello", "initial");

      const provider = testIsolated();
      const { handle } = await Effect.runPromise(
        startSandbox({
          provider,
          hostRepoDir: hostDir,
          env: {},
          copyPaths: ["nonexistent.txt"],
        }),
      );

      await handle.close();
    });
  });
});
