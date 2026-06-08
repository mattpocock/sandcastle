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
  type BindMountSandboxHandle,
  type IsolatedSandboxHandle,
} from "./SandboxProvider.js";
import { SANDBOX_REPO_DIR } from "./SandboxFactory.js";
import { startSandbox, COPY_PATHS_TIMEOUT_MS } from "./startSandbox.js";
import { testIsolated } from "./sandboxes/test-isolated.js";
import { CopyToWorktreeTimeoutError } from "./errors.js";

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

    it("times out when copyIn hangs", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
      tempDirs.push(hostDir);
      await initRepo(hostDir);
      await commitFile(hostDir, "hello.txt", "hello", "initial");
      await writeFile(join(hostDir, "hang.txt"), "will hang");

      const realProvider = testIsolated();
      let markHangStarted!: () => void;
      const hangStarted = new Promise<void>((resolve) => {
        markHangStarted = resolve;
      });
      const hangingProvider = createIsolatedSandboxProvider({
        name: "hanging-copy",
        create: async (options) => {
          const handle = await realProvider.create(options);
          return {
            ...handle,
            copyIn: (hostPath: string, sandboxPath: string) => {
              if (hostPath.endsWith("hang.txt")) {
                markHangStarted();
                return new Promise<void>(() => {}); // never resolves
              }
              return handle.copyIn(hostPath, sandboxPath);
            },
          };
        },
      });

      // Advance the TestClock only after the explicit copyPaths copy has
      // started; syncIn also uses copyIn and has its own timeout.
      const program = Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          startSandbox({
            provider: hangingProvider,
            hostRepoDir: hostDir,
            env: {},
            copyPaths: ["hang.txt"],
          }),
        );
        yield* Effect.promise(() => hangStarted);
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
