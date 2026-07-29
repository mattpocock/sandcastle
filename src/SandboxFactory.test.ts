import { Effect, Exit, Layer, Ref } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { AgentError, AgentIdleTimeoutError } from "./errors.js";
import { SilentDisplay, type DisplayEntry } from "./Display.js";
import {
  createBindMountSandboxProvider,
  createIsolatedSandboxProvider,
  type SandboxProvider,
  type BranchStrategy,
  type NoSandboxProvider,
} from "./SandboxProvider.js";
import { testIsolated } from "./sandboxes/test-isolated.js";
import { testStubProvider } from "./sandboxes/test-shared.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";

import {
  SandboxFactory,
  SandboxConfig,
  WorktreeDockerSandboxFactory,
  SANDBOX_REPO_DIR,
} from "./SandboxFactory.js";
import { pruneStale } from "./WorktreeManager.js";

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

/** Initialize a real git repo with an initial commit so WorktreeManager.create succeeds. */
const initRepoWithCommit = async (dir: string) => {
  await initRepo(dir);
  await commitFile(dir, "initial.txt", "initial", "initial commit");
};

/** Find the sole worktree directory created under hostDir/.sandcastle/worktrees. */
const findCreatedWorktree = async (
  hostDir: string,
): Promise<string | undefined> => {
  const worktreesDir = join(hostDir, ".sandcastle", "worktrees");
  if (!existsSync(worktreesDir)) return undefined;
  const entries = await readdir(worktreesDir);
  if (entries.length === 0) return undefined;
  return join(worktreesDir, entries[0]!);
};

/** Get the branch checked out at a worktree directory. */
const branchAt = async (dir: string): Promise<string> => {
  const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", {
    cwd: dir,
  });
  return stdout.trim();
};

/** Create a mock sandbox provider that records calls and delegates to a no-op handle. */
const makeMockProvider = (): {
  provider: SandboxProvider;
  createCalls: any[];
  readonly closeCalls: number;
} => {
  const stub = testStubProvider({
    name: "test-provider",
    worktreePath: SANDBOX_REPO_DIR,
  });
  return {
    provider: stub.provider,
    createCalls: stub.createCalls as any[],
    get closeCalls() {
      return stub.closeCalls.count;
    },
  };
};

describe("WorktreeDockerSandboxFactory", () => {
  let hostRepoDir: string;
  const tempDirs: string[] = [];

  let mockProvider: ReturnType<typeof makeMockProvider>;

  const makeLayer = (
    displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]),
    branchStrategy: BranchStrategy = { type: "merge-to-head" },
  ) =>
    Layer.provide(
      WorktreeDockerSandboxFactory.layer,
      Layer.mergeAll(
        Layer.succeed(SandboxConfig, {
          env: { FOO: "bar" },
          hostRepoDir,
          sandboxProvider: mockProvider.provider,
          branchStrategy,
        }),
        NodeFileSystem.layer,
        SilentDisplay.layer(displayRef),
      ),
    );

  beforeEach(async () => {
    hostRepoDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostRepoDir);
    await initRepoWithCommit(hostRepoDir);
    mockProvider = makeMockProvider();
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((d) => rm(d, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  it("creates a real worktree on the given branch when branch is specified", async () => {
    const layerWithBranch = makeLayer(
      Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]),
      { type: "branch", branch: "feature/my-branch" },
    );

    let observedBranch: string | undefined;
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox((info) =>
          Effect.promise(async () => {
            observedBranch = await branchAt(info.hostWorktreePath!);
          }),
        );
      }).pipe(Effect.provide(layerWithBranch)),
    );

    expect(observedBranch).toBe("feature/my-branch");
  });

  it("creates a worktree on a generated sandcastle/<timestamp> branch when no branch is specified", async () => {
    let observedBranch: string | undefined;
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox((info) =>
          Effect.promise(async () => {
            observedBranch = await branchAt(info.hostWorktreePath!);
          }),
        );
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(observedBranch).toMatch(/^sandcastle\//);
  });

  it("creates the worktree before calling provider.create", async () => {
    const callOrder: string[] = [];
    const { provider } = makeMockProvider();
    const origCreate = provider.create;
    (provider as any).create = async (opts: any) => {
      callOrder.push("provider-create");
      // Verify the worktree directory already exists at this point
      if (existsSync(opts.worktreePath)) {
        callOrder.push("worktree-exists-before-provider-create");
      }
      return origCreate(opts);
    };

    const layer = Layer.provide(
      WorktreeDockerSandboxFactory.layer,
      Layer.mergeAll(
        Layer.succeed(SandboxConfig, {
          env: { FOO: "bar" },
          hostRepoDir,
          sandboxProvider: provider,
          branchStrategy: { type: "merge-to-head" },
        }),
        NodeFileSystem.layer,
        SilentDisplay.layer(Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([])),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(layer)),
    );

    expect(callOrder).toContain("worktree-exists-before-provider-create");
  });

  it("passes worktree path and git mounts to provider.create", async () => {
    let observedWorktree: string | undefined;
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox((info) =>
          Effect.sync(() => {
            observedWorktree = info.hostWorktreePath;
          }),
        );
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(mockProvider.createCalls).toHaveLength(1);
    const opts = mockProvider.createCalls[0];
    expect(observedWorktree).toBeDefined();
    expect(opts.mounts).toContainEqual({
      hostPath: observedWorktree,
      sandboxPath: SANDBOX_REPO_DIR,
    });
    expect(opts.mounts).toContainEqual({
      hostPath: `${hostRepoDir}/.git`,
      sandboxPath: `${hostRepoDir}/.git`,
    });
  });

  it("removes the worktree after the effect completes (clean state)", async () => {
    let observedWorktreePath: string | undefined;
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox((info) =>
          Effect.sync(() => {
            observedWorktreePath = info.hostWorktreePath;
          }),
        );
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(observedWorktreePath).toBeDefined();
    expect(existsSync(observedWorktreePath!)).toBe(false);
  });

  it("closes provider handle on release", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(mockProvider.closeCalls).toBe(1);
  });

  it("preserves worktree when the effect fails with uncommitted changes in the worktree", async () => {
    let observedWorktreePath: string | undefined;
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox((info) =>
            Effect.gen(function* () {
              observedWorktreePath = info.hostWorktreePath;
              // Create an uncommitted change inside the worktree
              yield* Effect.promise(() =>
                writeFile(join(info.hostWorktreePath!, "dirty.txt"), "dirty"),
              );
              return yield* Effect.die("boom");
            }),
          );
        }).pipe(Effect.provide(makeLayer())),
      ),
    ).rejects.toThrow();

    expect(observedWorktreePath).toBeDefined();
    expect(existsSync(observedWorktreePath!)).toBe(true);
  });

  it("attaches preservedWorktreePath to AgentIdleTimeoutError on failure with dirty worktree", async () => {
    let observedWorktreePath: string | undefined;
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox((info) =>
          Effect.gen(function* () {
            observedWorktreePath = info.hostWorktreePath;
            yield* Effect.promise(() =>
              writeFile(join(info.hostWorktreePath!, "dirty.txt"), "dirty"),
            );
            return yield* Effect.fail(
              new AgentIdleTimeoutError({
                message: "timed out",
                timeoutMs: 30_000,
              }),
            );
          }),
        );
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("unreachable");
    expect(exit.cause._tag).toBe("Fail");
    if (exit.cause._tag !== "Fail") throw new Error("unreachable");
    expect(exit.cause.error).toBeInstanceOf(AgentIdleTimeoutError);
    expect(
      (exit.cause.error as AgentIdleTimeoutError).preservedWorktreePath,
    ).toBe(observedWorktreePath);
  });

  it("attaches preservedWorktreePath to AgentError on failure with dirty worktree", async () => {
    let observedWorktreePath: string | undefined;
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox((info) =>
          Effect.gen(function* () {
            observedWorktreePath = info.hostWorktreePath;
            yield* Effect.promise(() =>
              writeFile(join(info.hostWorktreePath!, "dirty.txt"), "dirty"),
            );
            return yield* Effect.fail(
              new AgentError({ message: "agent failed" }),
            );
          }),
        );
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("unreachable");
    expect(exit.cause._tag).toBe("Fail");
    if (exit.cause._tag !== "Fail") throw new Error("unreachable");
    expect(exit.cause.error).toBeInstanceOf(AgentError);
    expect((exit.cause.error as AgentError).preservedWorktreePath).toBe(
      observedWorktreePath,
    );
  });

  it("logs copy-to-sandbox as a spinner when copyToWorktree paths are provided", async () => {
    await writeFile(join(hostRepoDir, "some-file.txt"), "content");

    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const layerWithCopy = Layer.provide(
      WorktreeDockerSandboxFactory.layer,
      Layer.mergeAll(
        Layer.succeed(SandboxConfig, {
          env: {},
          hostRepoDir,
          copyToWorktree: ["some-file.txt"],
          sandboxProvider: mockProvider.provider,
          branchStrategy: { type: "merge-to-head" },
        }),
        NodeFileSystem.layer,
        SilentDisplay.layer(ref),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(layerWithCopy)),
    );

    const entries = await Effect.runPromise(Ref.get(ref));
    const spinnerEntry = entries.find(
      (e) => e._tag === "spinner" && e.message === "Copying to worktree",
    );
    expect(spinnerEntry).toBeDefined();
  });

  it("removes worktree silently on success with clean worktree", async () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    let observedWorktreePath: string | undefined;
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox((info) =>
          Effect.sync(() => {
            observedWorktreePath = info.hostWorktreePath;
          }),
        );
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(existsSync(observedWorktreePath!)).toBe(false);
    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it("preserves worktree and returns preservedWorktreePath on success with dirty worktree", async () => {
    let observedWorktreePath: string | undefined;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        return yield* factory.withSandbox((info) =>
          Effect.gen(function* () {
            observedWorktreePath = info.hostWorktreePath;
            yield* Effect.promise(() =>
              writeFile(join(info.hostWorktreePath!, "dirty.txt"), "dirty"),
            );
            return "done";
          }),
        );
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(result.preservedWorktreePath).toBe(observedWorktreePath);
    expect(result.value).toBe("done");
    expect(existsSync(observedWorktreePath!)).toBe(true);
  });

  // Documents current behaviour, and passes as-is: preserved worktrees are
  // never reclaimed by the prune that runs before every new worktree, because
  // its criterion is "git no longer knows this directory", not "this directory
  // is old". An orphaned worktree in the same run gets removed, so the
  // difference between the two is visible side by side.
  //
  // For an unattended process this means every run that ends with uncommitted
  // work leaves a full copy of the repo behind, for good: nothing collects
  // them and there is no option to opt out.
  it("prune leaves preserved worktrees from earlier runs in place, but removes an orphaned one", async () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Two runs, each ending with uncommitted work in its own worktree.
    const preservedPaths: string[] = [];
    for (const marker of ["first", "second"]) {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          return yield* factory.withSandbox((info) =>
            Effect.gen(function* () {
              yield* Effect.promise(() =>
                writeFile(
                  join(info.hostWorktreePath!, `${marker}.txt`),
                  marker,
                ),
              );
              return marker;
            }),
          );
        }).pipe(Effect.provide(makeLayer())),
      );
      preservedPaths.push(result.preservedWorktreePath!);
    }

    stderrSpy.mockRestore();

    // Two distinct worktrees are on disk after the two runs.
    expect(new Set(preservedPaths).size).toBe(2);
    for (const path of preservedPaths) {
      expect(existsSync(path)).toBe(true);
    }

    // A third directory under .sandcastle/worktrees/ that git does not know
    // about — an orphaned worktree, e.g. left behind by a crash.
    const worktreesDir = join(hostRepoDir, ".sandcastle", "worktrees");
    const orphanedPath = join(worktreesDir, "orphaned-worktree");
    await mkdir(orphanedPath, { recursive: true });

    // The cleanup sandcastle performs by itself before creating any worktree.
    const pruneExit = await Effect.runPromiseExit(
      pruneStale(hostRepoDir).pipe(Effect.provide(NodeFileSystem.layer)),
    );

    // It runs, and it succeeds.
    expect(Exit.isSuccess(pruneExit)).toBe(true);

    // The orphaned worktree is gone.
    expect(existsSync(orphanedPath)).toBe(false);

    // Both preserved worktrees are still there.
    for (const path of preservedPaths) {
      expect(existsSync(path)).toBe(true);
    }
    const remaining = await readdir(worktreesDir);
    expect(remaining.sort()).toEqual(
      preservedPaths.map((path) => basename(path)).sort(),
    );

    // Why prune spares them: git still has them registered, so they are not
    // orphaned. The orphaned directory was never in this list.
    const { stdout: worktreeList } = await execAsync(
      "git worktree list --porcelain",
      { cwd: hostRepoDir },
    );
    for (const path of preservedPaths) {
      expect(worktreeList).toContain(basename(path));
    }
    expect(worktreeList).not.toContain(basename(orphanedPath));
  });

  it("prints uncommitted changes message on success with dirty worktree", async () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    let observedWorktreePath: string | undefined;
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox((info) =>
          Effect.gen(function* () {
            observedWorktreePath = info.hostWorktreePath;
            yield* Effect.promise(() =>
              writeFile(join(info.hostWorktreePath!, "dirty.txt"), "dirty"),
            );
          }),
        );
      }).pipe(Effect.provide(makeLayer())),
    );

    const output = stderrSpy.mock.calls.map((c) => c[0]).join(" ");
    expect(output).toContain("uncommitted changes");
    expect(output).toContain(observedWorktreePath);
    stderrSpy.mockRestore();
  });

  it("removes worktree on failure with clean worktree", async () => {
    let observedWorktreePath: string | undefined;
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox((info) => {
            observedWorktreePath = info.hostWorktreePath;
            return Effect.fail(new AgentError({ message: "agent failed" }));
          });
        }).pipe(Effect.provide(makeLayer())),
      ),
    ).rejects.toThrow();

    expect(observedWorktreePath).toBeDefined();
    expect(existsSync(observedWorktreePath!)).toBe(false);
  });

  it("removes worktree when sandbox start fails (e.g. missing image)", async () => {
    const failingProvider = createBindMountSandboxProvider({
      name: "failing-provider",
      create: async () => {
        throw new Error("Image 'sandcastle:test' not found locally");
      },
    });

    const layer = Layer.provide(
      WorktreeDockerSandboxFactory.layer,
      Layer.mergeAll(
        Layer.succeed(SandboxConfig, {
          env: { FOO: "bar" },
          hostRepoDir,
          sandboxProvider: failingProvider,
          branchStrategy: { type: "merge-to-head" },
        }),
        NodeFileSystem.layer,
        SilentDisplay.layer(Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([])),
      ),
    );

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox(() => Effect.void);
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow();

    // No worktree should remain on disk
    const worktree = await findCreatedWorktree(hostRepoDir);
    expect(worktree).toBeUndefined();
  });

  it("prints 'no uncommitted changes' message on failure with clean worktree", async () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox(() =>
            Effect.fail(new AgentError({ message: "agent failed" })),
          );
        }).pipe(Effect.provide(makeLayer())),
      ),
    ).rejects.toThrow();

    const output = stderrSpy.mock.calls.map((c) => c[0]).join(" ");
    expect(output).toContain("no uncommitted changes");
    stderrSpy.mockRestore();
  });

  it("does not attach preservedWorktreePath to AgentIdleTimeoutError when worktree is clean on failure", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() =>
          Effect.fail(
            new AgentIdleTimeoutError({
              message: "timed out",
              timeoutMs: 30_000,
            }),
          ),
        );
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("unreachable");
    expect(exit.cause._tag).toBe("Fail");
    if (exit.cause._tag !== "Fail") throw new Error("unreachable");
    expect(exit.cause.error).toBeInstanceOf(AgentIdleTimeoutError);
    expect(
      (exit.cause.error as AgentIdleTimeoutError).preservedWorktreePath,
    ).toBeUndefined();
  });

  describe("head branch strategy", () => {
    const makeHeadLayer = (
      displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]),
    ) => makeLayer(displayRef, { type: "head" });

    it("does not create a worktree", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox(() => Effect.void);
        }).pipe(Effect.provide(makeHeadLayer())),
      );

      const worktree = await findCreatedWorktree(hostRepoDir);
      expect(worktree).toBeUndefined();
    });

    it("passes host repo dir and git mounts to provider", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox(() => Effect.void);
        }).pipe(Effect.provide(makeHeadLayer())),
      );

      expect(mockProvider.createCalls).toHaveLength(1);
      const opts = mockProvider.createCalls[0];
      expect(opts.mounts).toContainEqual({
        hostPath: hostRepoDir,
        sandboxPath: SANDBOX_REPO_DIR,
      });
      expect(opts.mounts).toContainEqual({
        hostPath: `${hostRepoDir}/.git`,
        sandboxPath: `${hostRepoDir}/.git`,
      });
    });

    it("returns undefined preservedWorktreePath", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          return yield* factory.withSandbox(() => Effect.succeed("done"));
        }).pipe(Effect.provide(makeHeadLayer())),
      );

      expect(result.preservedWorktreePath).toBeUndefined();
      expect(result.value).toBe("done");
    });

    it("passes hostWorktreePath pointing to host repo dir", async () => {
      let receivedInfo: { hostWorktreePath?: string } | undefined;
      await Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox((info) => {
            receivedInfo = info;
            return Effect.void;
          });
        }).pipe(Effect.provide(makeHeadLayer())),
      );

      expect(receivedInfo?.hostWorktreePath).toBe(hostRepoDir);
    });
  });

  it("returns undefined preservedWorktreePath on success with clean worktree", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        return yield* factory.withSandbox(() => Effect.succeed("done"));
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(result.preservedWorktreePath).toBeUndefined();
    expect(result.value).toBe("done");
  });
});

describe("WorktreeDockerSandboxFactory — isolated providers", () => {
  const tempDirs: string[] = [];

  const makeIsolatedLayer = (hostRepoDir: string, copyToWorktree?: string[]) =>
    Layer.provide(
      WorktreeDockerSandboxFactory.layer,
      Layer.mergeAll(
        Layer.succeed(SandboxConfig, {
          env: {},
          hostRepoDir,
          copyToWorktree,
          sandboxProvider: testIsolated(),
          branchStrategy: { type: "merge-to-head" },
        }),
        NodeFileSystem.layer,
        SilentDisplay.layer(Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([])),
      ),
    );

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((d) => rm(d, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  it("copies copyToWorktree files into the isolated sandbox via copyIn", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepoWithCommit(hostDir);
    await commitFile(hostDir, "extra.txt", "extra content", "add extra");

    let fileContent = "";
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox((_, sandbox) =>
          Effect.gen(function* () {
            const result = yield* sandbox.exec("cat extra.txt");
            fileContent = result.stdout.trim();
          }),
        );
      }).pipe(Effect.provide(makeIsolatedLayer(hostDir, ["extra.txt"]))),
    );

    expect(fileContent).toBe("extra content");
  });

  it("copies nested copyToWorktree paths, creating parent directories", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepoWithCommit(hostDir);
    await mkdir(join(hostDir, "subdir"), { recursive: true });
    await writeFile(join(hostDir, "subdir", "config.json"), '{"key":"value"}');
    await execAsync(
      'git add subdir/config.json && git commit -m "add config"',
      {
        cwd: hostDir,
      },
    );

    let fileContent = "";
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox((_, sandbox) =>
          Effect.gen(function* () {
            const result = yield* sandbox.exec("cat subdir/config.json");
            fileContent = result.stdout.trim();
          }),
        );
      }).pipe(
        Effect.provide(makeIsolatedLayer(hostDir, ["subdir/config.json"])),
      ),
    );

    expect(fileContent).toBe('{"key":"value"}');
  });

  it("works without copyToWorktree (no regression)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepoWithCommit(hostDir);
    await commitFile(hostDir, "hello.txt", "hello world", "add hello");

    let fileContent = "";
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox((_, sandbox) =>
          Effect.gen(function* () {
            const result = yield* sandbox.exec("cat hello.txt");
            fileContent = result.stdout.trim();
          }),
        );
      }).pipe(Effect.provide(makeIsolatedLayer(hostDir))),
    );

    expect(fileContent).toBe("hello world");
  });

  it("copies copyToWorktree directories into the isolated sandbox via copyIn", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepoWithCommit(hostDir);
    await mkdir(join(hostDir, "config", "nested"), { recursive: true });
    await writeFile(join(hostDir, "config", "a.json"), '{"a":1}');
    await writeFile(join(hostDir, "config", "nested", "b.json"), '{"b":2}');
    await execAsync('git add config && git commit -m "add config dir"', {
      cwd: hostDir,
    });

    let contentA = "";
    let contentB = "";
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox((_, sandbox) =>
          Effect.gen(function* () {
            contentA = (yield* sandbox.exec("cat config/a.json")).stdout.trim();
            contentB = (yield* sandbox.exec(
              "cat config/nested/b.json",
            )).stdout.trim();
          }),
        );
      }).pipe(Effect.provide(makeIsolatedLayer(hostDir, ["config"]))),
    );

    expect(contentA).toBe('{"a":1}');
    expect(contentB).toBe('{"b":2}');
  });

  it("skips missing copyToWorktree paths without error", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepoWithCommit(hostDir);

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeIsolatedLayer(hostDir, ["nonexistent.txt"]))),
    );
  });

  it("isolated provider does not have a branchStrategy property", () => {
    const provider = testIsolated();
    expect("branchStrategy" in provider).toBe(false);
  });

  it("creates a worktree before starting the isolated sandbox", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepoWithCommit(hostDir);

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeIsolatedLayer(hostDir))),
    );

    // After cleanup the worktree dir is gone, but the .sandcastle/worktrees dir exists
    expect(existsSync(join(hostDir, ".sandcastle", "worktrees"))).toBe(true);
  });

  it("creates a worktree with a named branch for branch strategy", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepoWithCommit(hostDir);

    const layer = Layer.provide(
      WorktreeDockerSandboxFactory.layer,
      Layer.mergeAll(
        Layer.succeed(SandboxConfig, {
          env: {},
          hostRepoDir: hostDir,
          sandboxProvider: testIsolated(),
          branchStrategy: { type: "branch", branch: "feature/my-branch" },
        }),
        NodeFileSystem.layer,
        SilentDisplay.layer(Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([])),
      ),
    );

    let observedBranch: string | undefined;
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox((info) =>
          Effect.promise(async () => {
            observedBranch = await branchAt(info.hostWorktreePath!);
          }),
        );
      }).pipe(Effect.provide(layer)),
    );

    expect(observedBranch).toBe("feature/my-branch");
  });

  it("provides hostWorktreePath in SandboxInfo", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepoWithCommit(hostDir);

    let receivedInfo: { hostWorktreePath?: string } | undefined;
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox((info) => {
          receivedInfo = info;
          return Effect.void;
        });
      }).pipe(Effect.provide(makeIsolatedLayer(hostDir))),
    );

    expect(receivedInfo?.hostWorktreePath).toBeDefined();
    expect(receivedInfo!.hostWorktreePath).toContain(
      join(hostDir, ".sandcastle", "worktrees"),
    );
  });

  it("removes worktree on success with clean worktree", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepoWithCommit(hostDir);

    let observedWorktreePath: string | undefined;
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox((info) =>
          Effect.sync(() => {
            observedWorktreePath = info.hostWorktreePath;
          }),
        );
      }).pipe(Effect.provide(makeIsolatedLayer(hostDir))),
    );

    expect(existsSync(observedWorktreePath!)).toBe(false);
  });

  it("preserves worktree on failure with dirty worktree", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepoWithCommit(hostDir);

    let observedWorktreePath: string | undefined;
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox((info) =>
            Effect.gen(function* () {
              observedWorktreePath = info.hostWorktreePath;
              yield* Effect.promise(() =>
                writeFile(join(info.hostWorktreePath!, "dirty.txt"), "dirty"),
              );
              return yield* Effect.die("boom");
            }),
          );
        }).pipe(Effect.provide(makeIsolatedLayer(hostDir))),
      ),
    ).rejects.toThrow();

    expect(existsSync(observedWorktreePath!)).toBe(true);
  });

  it("removes worktree when isolated sandbox start fails", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepoWithCommit(hostDir);

    const failingProvider = createIsolatedSandboxProvider({
      name: "failing-isolated",
      create: async () => {
        throw new Error("isolated sandbox unavailable");
      },
    });

    const layer = Layer.provide(
      WorktreeDockerSandboxFactory.layer,
      Layer.mergeAll(
        Layer.succeed(SandboxConfig, {
          env: {},
          hostRepoDir: hostDir,
          sandboxProvider: failingProvider,
          branchStrategy: { type: "merge-to-head" },
        }),
        NodeFileSystem.layer,
        SilentDisplay.layer(Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([])),
      ),
    );

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox(() => Effect.void);
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow();

    // No worktree should remain
    const worktree = await findCreatedWorktree(hostDir);
    expect(worktree).toBeUndefined();
  });

  it("provides applyToHost callback that syncs commits to worktree", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepoWithCommit(hostDir);

    let observedWorktreePath: string | undefined;
    let commitMade = false;
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox((info, sandbox) =>
          Effect.gen(function* () {
            observedWorktreePath = info.hostWorktreePath;
            yield* sandbox.exec(
              'git config user.email "test@test.com" && git config user.name "Test"',
            );
            yield* sandbox.exec(
              'echo "new content" > new-file.txt && git add new-file.txt && git commit -m "sandbox commit"',
            );
            commitMade = true;
            if (!info.applyToHost)
              throw new Error("applyToHost not provided for isolated sandbox");
            yield* info.applyToHost();
          }),
        );
      }).pipe(Effect.provide(makeIsolatedLayer(hostDir))),
    );

    expect(commitMade).toBe(true);
    expect(observedWorktreePath).toBeDefined();
    // applyToHost runs syncOut, transferring the sandbox commit onto the
    // worktree branch via format-patch/am. The branch remains after cleanup.
    const { stdout } = await execAsync("git log --oneline --all", {
      cwd: hostDir,
    });
    expect(stdout).toContain("sandbox commit");
  });
});

describe("WorktreeDockerSandboxFactory — no-sandbox provider", () => {
  const tempDirs: string[] = [];

  const makeNoSandboxLayer = (
    hostRepoDir: string,
    branchStrategy: BranchStrategy = { type: "head" },
  ) =>
    Layer.provide(
      WorktreeDockerSandboxFactory.layer,
      Layer.mergeAll(
        Layer.succeed(SandboxConfig, {
          env: {},
          hostRepoDir,
          sandboxProvider: noSandbox(),
          branchStrategy,
        }),
        NodeFileSystem.layer,
        SilentDisplay.layer(Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([])),
      ),
    );

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((d) => rm(d, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  it("head mode: does not create a worktree and runs in hostRepoDir", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepoWithCommit(hostDir);
    await commitFile(hostDir, "hello.txt", "hi", "add hello");

    let receivedInfo: { hostWorktreePath?: string } | undefined;
    let execOut = "";
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox((info, sandbox) => {
          receivedInfo = info;
          return Effect.gen(function* () {
            const r = yield* sandbox.exec("cat hello.txt");
            execOut = r.stdout.trim();
          });
        });
      }).pipe(Effect.provide(makeNoSandboxLayer(hostDir))),
    );

    const worktree = await findCreatedWorktree(hostDir);
    expect(worktree).toBeUndefined();
    expect(receivedInfo?.hostWorktreePath).toBe(hostDir);
    expect(execOut).toBe("hi");
  });

  it("worktree mode: creates worktree, runs in it, cleans up on success", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepoWithCommit(hostDir);

    let observedWorktreePath: string | undefined;
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox((info) =>
          Effect.sync(() => {
            observedWorktreePath = info.hostWorktreePath;
          }),
        );
      }).pipe(
        Effect.provide(makeNoSandboxLayer(hostDir, { type: "merge-to-head" })),
      ),
    );

    expect(observedWorktreePath).toBeDefined();
    expect(observedWorktreePath).toContain(
      join(hostDir, ".sandcastle", "worktrees"),
    );
    expect(existsSync(observedWorktreePath!)).toBe(false);
  });

  it("worktree mode: removes worktree when sandbox start fails", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepoWithCommit(hostDir);

    const failingProvider: NoSandboxProvider = {
      tag: "none",
      name: "failing-no-sandbox",
      env: {},
      create: async () => {
        throw new Error("no-sandbox create failed");
      },
    };

    const layer = Layer.provide(
      WorktreeDockerSandboxFactory.layer,
      Layer.mergeAll(
        Layer.succeed(SandboxConfig, {
          env: {},
          hostRepoDir: hostDir,
          sandboxProvider: failingProvider,
          branchStrategy: { type: "merge-to-head" },
        }),
        NodeFileSystem.layer,
        SilentDisplay.layer(Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([])),
      ),
    );

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox(() => Effect.void);
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow();

    const worktree = await findCreatedWorktree(hostDir);
    expect(worktree).toBeUndefined();
  });
});
