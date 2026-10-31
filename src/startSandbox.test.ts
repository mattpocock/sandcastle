import { Duration, Effect, Exit, TestClock, TestContext } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { exec } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createBindMountSandboxProvider,
  createIsolatedSandboxProvider,
} from "./SandboxProvider.js";
import type {
  BindMountSandboxHandle,
  IsolatedSandboxHandle,
} from "./SandboxProvider.js";
import { SANDBOX_REPO_DIR } from "./SandboxFactory.js";
import {
  startSandbox,
  COPY_PATHS_TIMEOUT_MS,
  CONTAINER_START_TIMEOUT_MS,
} from "./startSandbox.js";
import { testIsolated } from "./sandboxes/test-isolated.js";
import {
  ContainerStartTimeoutError,
  CopyToWorktreeTimeoutError,
} from "./errors.js";

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
  });

  describe("isolated provider", () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
      await Promise.all(
        tempDirs.map(async (d) => rm(d, { recursive: true, force: true })),
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
          copySourceDir: hostDir,
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
            copyIn: async (hostPath: string, sandboxPath: string) => {
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
            copySourceDir: hostDir,
          }),
        );
        // Yield to allow real async operations (create, syncIn) to complete
        yield* Effect.yieldNow();
        yield* Effect.promise(
          async () => new Promise((r) => setTimeout(r, 2000)),
        );
        yield* Effect.yieldNow();
        // Now advance past the copyPaths timeout
        yield* TestClock.adjust(Duration.millis(COPY_PATHS_TIMEOUT_MS + 1));
        return yield* fiber.await;
      }).pipe(Effect.provide(TestContext.TestContext));

      const exit = await Effect.runPromise(program);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        const { error } = exit.cause;
        expect(error).toBeInstanceOf(CopyToWorktreeTimeoutError);
        const timeoutError = error as CopyToWorktreeTimeoutError;
        expect(timeoutError.timeoutMs).toBe(COPY_PATHS_TIMEOUT_MS);
        expect(timeoutError.paths).toEqual(["hang.txt"]);
      } else {
        throw new Error("Expected Fail cause");
      }
    }, 15_000);

    it("closes the handle when sync-in fails after create", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
      tempDirs.push(hostDir);
      await initRepo(hostDir);
      await commitFile(hostDir, "hello.txt", "hello", "initial");

      const realProvider = testIsolated();
      let closeCalls = 0;
      const provider = createIsolatedSandboxProvider({
        name: "failing-sync-in",
        create: async (options) => {
          const handle = await realProvider.create(options);
          return {
            ...handle,
            // Every command fails, so sync-in's git clone fails.
            exec: async () => ({ stdout: "", stderr: "denied", exitCode: 128 }),
            close: async () => {
              closeCalls++;
              await handle.close();
            },
          };
        },
      });

      const exit = await Effect.runPromiseExit(
        startSandbox({ provider, hostRepoDir: hostDir, env: {} }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(closeCalls).toBe(1);
    });

    it("closes the handle when copying copyPaths fails", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
      tempDirs.push(hostDir);
      await initRepo(hostDir);
      await commitFile(hostDir, "hello.txt", "hello", "initial");
      await writeFile(join(hostDir, "extra.txt"), "extra content");

      const realProvider = testIsolated();
      let closeCalls = 0;
      const provider = createIsolatedSandboxProvider({
        name: "failing-copy",
        create: async (options) => {
          const handle = await realProvider.create(options);
          return {
            ...handle,
            copyIn: async (hostPath: string, sandboxPath: string) => {
              if (sandboxPath.includes("repo.bundle")) {
                return handle.copyIn(hostPath, sandboxPath);
              }
              throw new Error("copy failed");
            },
            close: async () => {
              closeCalls++;
              await handle.close();
            },
          };
        },
      });

      const exit = await Effect.runPromiseExit(
        startSandbox({
          provider,
          hostRepoDir: hostDir,
          env: {},
          copyPaths: ["extra.txt"],
          copySourceDir: hostDir,
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(closeCalls).toBe(1);
    });

    it("does not close the handle when setup succeeds", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
      tempDirs.push(hostDir);
      await initRepo(hostDir);
      await commitFile(hostDir, "hello.txt", "hello", "initial");

      const realProvider = testIsolated();
      let closeCalls = 0;
      const provider = createIsolatedSandboxProvider({
        name: "counting",
        create: async (options) => {
          const handle = await realProvider.create(options);
          return {
            ...handle,
            close: async () => {
              closeCalls++;
              await handle.close();
            },
          };
        },
      });

      const { handle } = await Effect.runPromise(
        startSandbox({ provider, hostRepoDir: hostDir, env: {} }),
      );
      expect(closeCalls).toBe(0);
      await handle.close();
    });

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
          copySourceDir: hostDir,
        }),
      );

      await handle.close();
    });
  });

  describe("create() outliving the container start timeout", () => {
    /**
     * A provider whose create() only resolves when the test says so, so the
     * start timeout can fire while create() is still in flight.
     */
    const makeSlowCreate = () => {
      let resolveCreate!: () => void;
      const released = new Promise<void>((r) => (resolveCreate = r));
      let closeCalls = 0;
      const close = async () => {
        closeCalls++;
      };
      return {
        released,
        resolveCreate: () => {
          resolveCreate();
        },
        closeCalls: () => closeCalls,
        close,
      };
    };

    const timeOutThenResolve = async (
      start: Effect.Effect<unknown, unknown>,
      slow: ReturnType<typeof makeSlowCreate>,
    ) => {
      const exit = await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(start);
          yield* Effect.yieldNow();
          yield* TestClock.adjust(
            Duration.millis(CONTAINER_START_TIMEOUT_MS + 1),
          );
          return yield* fiber.await;
        }).pipe(Effect.provide(TestContext.TestContext)),
      );
      // The provider finishes creating the sandbox after we gave up on it.
      slow.resolveCreate();
      await new Promise((r) => setTimeout(r, 10));
      return exit;
    };

    const expectStartTimeout = (exit: Exit.Exit<unknown, unknown>) => {
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(ContainerStartTimeoutError);
      } else {
        throw new Error("Expected Fail cause");
      }
    };

    it("closes an isolated sandbox that finishes creating after the timeout", async () => {
      const slow = makeSlowCreate();
      const provider = createIsolatedSandboxProvider({
        name: "slow-isolated",
        create: async () => {
          await slow.released;
          return {
            worktreePath: "/home/agent/workspace",
            exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
            copyIn: async () => {},
            copyFileOut: async () => {},
            close: slow.close,
          };
        },
      });

      const exit = await timeOutThenResolve(
        startSandbox({ provider, hostRepoDir: "/repo", env: {} }),
        slow,
      );

      expectStartTimeout(exit);
      expect(slow.closeCalls()).toBe(1);
    });

    it("closes a bind-mount sandbox that finishes creating after the timeout", async () => {
      const slow = makeSlowCreate();
      const provider = createBindMountSandboxProvider({
        name: "slow-bind-mount",
        create: async () => {
          await slow.released;
          return {
            worktreePath: SANDBOX_REPO_DIR,
            exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
            copyFileIn: async () => {},
            copyFileOut: async () => {},
            close: slow.close,
          };
        },
      });

      const exit = await timeOutThenResolve(
        startSandbox({
          provider,
          hostRepoDir: "/repo",
          env: {},
          worktreeOrRepoPath: "/worktree",
          gitMounts: [],
          repoDir: SANDBOX_REPO_DIR,
        }),
        slow,
      );

      expectStartTimeout(exit);
      expect(slow.closeCalls()).toBe(1);
    });
  });
});
