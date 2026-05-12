import { Cause, Effect, Layer, Ref } from "effect";
import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { Display, type DisplayEntry, SilentDisplay } from "./Display.js";
import { makeLocalSandboxLayer } from "./testSandbox.js";
import { orchestrate } from "./Orchestrator.js";
import { substitutePromptArgs } from "./PromptArgumentSubstitution.js";
import {
  claudeCode,
  codex as codexFactory,
  opencode as opencodeFactory,
  pi as piFactory,
  DEFAULT_MODEL,
} from "./AgentProvider.js";
import { Sandbox } from "./SandboxFactory.js";
import type { DockerError, SandboxError } from "./errors.js";
import { AgentError, AgentIdleTimeoutError } from "./errors.js";
import { SandboxFactory } from "./SandboxFactory.js";
import { encodeProjectPath } from "./SessionStore.js";
import { defaultSessionPathsLayer, sessionPathsLayer } from "./SessionPaths.js";
import {
  callbackAgentStreamEmitterLayer,
  noopAgentStreamEmitterLayer,
  type AgentStreamEvent,
} from "./AgentStreamEmitter.js";
import type { BindMountSandboxHandle } from "./SandboxProvider.js";

const execAsync = promisify(exec);

const testProvider = claudeCode("test-model");

const testDisplayLayer = Layer.mergeAll(
  SilentDisplay.layer(Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([])),
  defaultSessionPathsLayer,
  noopAgentStreamEmitterLayer,
);

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

/** Format a mock agent result as stream-json lines (mimicking Claude's output) */
const toStreamJson = (output: string, sessionId?: string): string => {
  const lines: string[] = [];
  if (sessionId) {
    lines.push(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: sessionId,
      }),
    );
  }
  lines.push(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: output }] },
    }),
  );
  lines.push(JSON.stringify({ type: "result", result: output }));
  return lines.join("\n");
};

/**
 * Create a mock SandboxFactory that creates a fresh git worktree
 * from hostRepoDir for each withSandbox call, then cleans it up after.
 *
 * Each iteration gets an isolated sandbox: the worktree directory is
 * removed and recreated before each call, and cleaned up after.
 *
 * @param hostRepoDir - The host git repository to create worktrees from
 * @param buildLayer - Given a fresh sandbox dir, return a Sandbox layer
 * @returns The factory layer
 */
const makeTestSandboxFactory = (
  hostRepoDir: string,
  buildLayer: (sandboxDir: string) => Layer.Layer<Sandbox>,
): { factoryLayer: Layer.Layer<SandboxFactory>; sandboxRepoDir: string } => {
  const sandboxBaseDir = join(tmpdir(), `orch-factory-${randomUUID()}`);
  const sandboxRepoDir = sandboxBaseDir; // The worktree IS the sandbox

  let branchCounter = 0;

  const factoryLayer = Layer.succeed(SandboxFactory, {
    withSandbox: <A, E, R>(
      makeEffect: (
        info: import("./SandboxFactory.js").SandboxInfo,
      ) => Effect.Effect<A, E, R | Sandbox>,
    ): Effect.Effect<
      import("./SandboxFactory.js").WithSandboxResult<A>,
      E | DockerError,
      Exclude<R, Sandbox>
    > =>
      Effect.acquireUseRelease(
        // Acquire: create fresh worktree from host repo
        Effect.promise(async () => {
          await rm(sandboxBaseDir, { recursive: true, force: true });
          const branchName = `sandcastle/test-${++branchCounter}`;
          await execAsync(
            `git worktree add -b "${branchName}" "${sandboxBaseDir}" HEAD`,
            { cwd: hostRepoDir },
          );
          return branchName;
        }),
        // Use: provide sandbox layer and run effect
        (_branchName) =>
          makeEffect({
            hostWorktreePath: sandboxBaseDir,
            sandboxRepoPath: sandboxBaseDir,
            applyToHost: () => Effect.void,
          }).pipe(Effect.provide(buildLayer(sandboxBaseDir))) as Effect.Effect<
            A,
            E | DockerError,
            Exclude<R, Sandbox>
          >,
        // Release: remove the worktree (branch cleanup is handled by withSandboxLifecycle)
        (_branchName) =>
          Effect.promise(async () => {
            try {
              await execAsync(
                `git worktree remove "${sandboxBaseDir}" --force`,
                { cwd: hostRepoDir },
              ).catch(() => {});
            } catch {}
          }),
      ).pipe(
        Effect.map((value) => ({ value, preservedWorktreePath: undefined })),
      ),
  });

  return { factoryLayer, sandboxRepoDir };
};

/**
 * Create a mock sandbox layer that intercepts `claude` commands
 * and runs a mock script instead. All other commands pass through
 * to the filesystem sandbox.
 */
const makeMockAgentLayer = (
  sandboxDir: string,
  mockAgentBehavior: (sandboxRepoDir: string) => Promise<string>,
): Layer.Layer<Sandbox> => {
  const fsLayer = makeLocalSandboxLayer(sandboxDir);

  return Layer.succeed(Sandbox, {
    exec: (command, options) => {
      // Intercept claude invocations
      if (command.startsWith("claude ")) {
        if (options?.onLine) {
          const onLine = options.onLine;
          return Effect.gen(function* () {
            const cwd = options?.cwd ?? sandboxDir;
            const output = yield* Effect.promise(() => mockAgentBehavior(cwd));
            const streamOutput = toStreamJson(output);
            // Emit each line to the callback
            for (const line of streamOutput.split("\n")) {
              onLine(line);
            }
            return { stdout: streamOutput, stderr: "", exitCode: 0 };
          });
        }
        return Effect.gen(function* () {
          const cwd = options?.cwd ?? sandboxDir;
          const output = yield* Effect.promise(() => mockAgentBehavior(cwd));
          return { stdout: output, stderr: "", exitCode: 0 };
        });
      }
      // Pass through to real filesystem sandbox
      return Effect.flatMap(Sandbox, (real) =>
        real.exec(command, options),
      ).pipe(Effect.provide(fsLayer));
    },
    copyIn: (hostPath, sandboxPath) =>
      Effect.flatMap(Sandbox, (real) =>
        real.copyIn(hostPath, sandboxPath),
      ).pipe(Effect.provide(fsLayer)),
    copyFileOut: (sandboxPath, hostPath) =>
      Effect.flatMap(Sandbox, (real) =>
        real.copyFileOut(sandboxPath, hostPath),
      ).pipe(Effect.provide(fsLayer)),
  });
};

describe("Orchestrator", () => {
  it("runs a single iteration: sync-in, agent, sync-out", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: creates a commit in the sandbox repo
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async (repoDir) => {
          await writeFile(join(repoDir, "agent-output.txt"), "agent was here");
          await execAsync("git add -A", { cwd: repoDir });
          await execAsync('git config user.email "agent@test.com"', {
            cwd: repoDir,
          });
          await execAsync('git config user.name "Agent"', { cwd: repoDir });
          await execAsync('git commit -m "RALPH: agent commit"', {
            cwd: repoDir,
          });
          return "Done with iteration.";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(1);
    expect(result.completionSignal).toBeUndefined();

    // Verify the agent's commit was synced back to host
    const content = await readFile(join(hostDir, "agent-output.txt"), "utf-8");
    expect(content).toBe("agent was here");
  });

  it("stops early on completion signal", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: emits completion signal
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "All done. <promise>COMPLETE</promise>";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 5,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(1);
    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
  });

  it("stops early on custom completion signal", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: emits a custom completion signal
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "All done. TASK_FINISHED";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 5,
        prompt: "do some work",
        completionSignal: "TASK_FINISHED",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(1);
    expect(result.completionSignal).toBe("TASK_FINISHED");
  });

  it("does not trigger default completion signal when custom one is set", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: emits the default completion signal but custom one is set
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "All done. <promise>COMPLETE</promise>";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 2,
        prompt: "do some work",
        completionSignal: "TASK_FINISHED",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    // Custom signal not in output, so all iterations run
    expect(result.iterations.length).toBe(2);
    expect(result.completionSignal).toBeUndefined();
  });

  it("stops early when any signal in an array matches", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: emits the second signal in the array
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "All done. TASK_ABORTED";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 5,
        prompt: "do some work",
        completionSignal: ["TASK_FINISHED", "TASK_ABORTED"],
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(1);
    expect(result.completionSignal).toBe("TASK_ABORTED");
  });

  it("returns the matched signal from an array", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: emits the first signal in the array
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "All done. TASK_FINISHED";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 5,
        prompt: "do some work",
        completionSignal: ["TASK_FINISHED", "TASK_ABORTED"],
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(1);
    expect(result.completionSignal).toBe("TASK_FINISHED");
  });

  it("runs all iterations when no signal in array matches", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: emits neither signal
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "Still working.";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 2,
        prompt: "do some work",
        completionSignal: ["TASK_FINISHED", "TASK_ABORTED"],
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(2);
    expect(result.completionSignal).toBeUndefined();
  });

  it("runs multiple iterations with re-sync between them", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let iterationCount = 0;

    // Mock agent: creates a commit each iteration, completes on iteration 3
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async (repoDir) => {
          iterationCount++;
          const filename = `iter-${iterationCount}.txt`;
          await writeFile(
            join(repoDir, filename),
            `iteration ${iterationCount}`,
          );
          await execAsync("git add -A", { cwd: repoDir });
          await execAsync('git config user.email "agent@test.com"', {
            cwd: repoDir,
          });
          await execAsync('git config user.name "Agent"', { cwd: repoDir });
          await execAsync(
            `git commit -m "RALPH: iteration ${iterationCount}"`,
            {
              cwd: repoDir,
            },
          );

          if (iterationCount === 3) {
            return "All tasks done. <promise>COMPLETE</promise>";
          }
          return `Finished iteration ${iterationCount}.`;
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 5,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(3);
    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");

    // Verify all 3 iteration files arrived on host
    for (let i = 1; i <= 3; i++) {
      const content = await readFile(join(hostDir, `iter-${i}.txt`), "utf-8");
      expect(content).toBe(`iteration ${i}`);
    }
  });

  it("handles iteration with no agent commits gracefully", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: doesn't make any commits
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "Nothing to do.";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 2,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(2);
    expect(result.completionSignal).toBeUndefined();

    // Host should still be at the original commit
    const hostHead = await getHead(hostDir);
    const { stdout } = await execAsync("git log --oneline", { cwd: hostDir });
    expect(stdout.trim().split("\n")).toHaveLength(1);
  });

  it("each iteration gets an isolated sandbox (no state leaks)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-iso-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let iteration = 0;
    let markerExistedInIter2 = true;

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async (repoDir) => {
          iteration++;
          if (iteration === 1) {
            // Create an untracked marker file — should NOT leak to iteration 2
            await writeFile(join(repoDir, ".sandbox-marker"), "iter1");
            return "Done iter 1";
          }
          // Iteration 2: check if marker leaked from iteration 1
          markerExistedInIter2 = existsSync(join(repoDir, ".sandbox-marker"));
          return "Done iter 2. <promise>COMPLETE</promise>";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 3,

        prompt: "test isolation",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(2);
    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
    // Untracked file from iteration 1 must not exist in iteration 2's sandbox
    expect(markerExistedInIter2).toBe(false);
  });
});

describe("OrchestrateResult", () => {
  it("captures agent stdout in the result", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-result-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return 'Here is my structured output: {"plan": [1, 2, 3]}';
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.stdout).toContain(
      'Here is my structured output: {"plan": [1, 2, 3]}',
    );
  });

  it("accumulates commits across multiple iterations", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-result-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let iterationCount = 0;

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async (repoDir) => {
          iterationCount++;
          await writeFile(
            join(repoDir, `file-${iterationCount}.txt`),
            `content ${iterationCount}`,
          );
          await execAsync("git add -A", { cwd: repoDir });
          await execAsync('git config user.email "agent@test.com"', {
            cwd: repoDir,
          });
          await execAsync('git config user.name "Agent"', { cwd: repoDir });
          await execAsync(`git commit -m "commit ${iterationCount}"`, {
            cwd: repoDir,
          });

          if (iterationCount === 3) {
            return "All done. <promise>COMPLETE</promise>";
          }
          return `Iteration ${iterationCount} done.`;
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 5,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.commits).toHaveLength(3);
    // Each commit sha should be valid
    for (const commit of result.commits) {
      expect(commit.sha).toMatch(/^[0-9a-f]{40}$/);
    }
    // All shas should be unique
    const uniqueShas = new Set(result.commits.map((c) => c.sha));
    expect(uniqueShas.size).toBe(3);
  });

  it("returns empty commits and branch when agent makes no commits", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-result-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "Nothing to do.";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.commits).toEqual([]);
    expect(result.branch).toBe("main");
  });

  it("returns commit shas and branch after a single iteration", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-result-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async (repoDir) => {
          await writeFile(join(repoDir, "new-file.txt"), "new content");
          await execAsync("git add -A", { cwd: repoDir });
          await execAsync('git config user.email "agent@test.com"', {
            cwd: repoDir,
          });
          await execAsync('git config user.name "Agent"', { cwd: repoDir });
          await execAsync('git commit -m "agent commit"', { cwd: repoDir });
          return "Done.";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    // Branch should match the host's current branch
    expect(result.branch).toBe("main");

    // Should have exactly one commit
    expect(result.commits).toHaveLength(1);
    expect(result.commits[0]!.sha).toMatch(/^[0-9a-f]{40}$/);

    // The sha should match what's on the host
    const hostHead = await getHead(hostDir);
    expect(result.commits[0]!.sha).toBe(hostHead);
  });

  it("surfaces commits even when worktree has uncommitted changes", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-result-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const sandboxBaseDir = join(tmpdir(), `orch-factory-${randomUUID()}`);
    let branchCounter = 0;

    // Custom factory that detects uncommitted changes and preserves worktree path
    const factoryLayer = Layer.succeed(SandboxFactory, {
      withSandbox: <A, E, R>(
        makeEffect: (
          info: import("./SandboxFactory.js").SandboxInfo,
        ) => Effect.Effect<A, E, R | Sandbox>,
      ): Effect.Effect<
        import("./SandboxFactory.js").WithSandboxResult<A>,
        E | DockerError,
        Exclude<R, Sandbox>
      > =>
        Effect.acquireUseRelease(
          Effect.promise(async () => {
            await rm(sandboxBaseDir, { recursive: true, force: true });
            const branchName = `sandcastle/test-${++branchCounter}`;
            await execAsync(
              `git worktree add -b "${branchName}" "${sandboxBaseDir}" HEAD`,
              { cwd: hostDir },
            );
            return branchName;
          }),
          (_branchName) =>
            makeEffect({
              hostWorktreePath: sandboxBaseDir,
              sandboxRepoPath: sandboxBaseDir,
              applyToHost: () => Effect.void,
            }).pipe(
              Effect.provide(
                makeMockAgentLayer(sandboxBaseDir, async (repoDir) => {
                  // Make a commit
                  await writeFile(
                    join(repoDir, "committed.txt"),
                    "committed content",
                  );
                  await execAsync("git add -A", { cwd: repoDir });
                  await execAsync('git config user.email "agent@test.com"', {
                    cwd: repoDir,
                  });
                  await execAsync('git config user.name "Agent"', {
                    cwd: repoDir,
                  });
                  await execAsync('git commit -m "agent commit"', {
                    cwd: repoDir,
                  });

                  // Leave uncommitted changes
                  await writeFile(
                    join(repoDir, "uncommitted.txt"),
                    "uncommitted content",
                  );

                  return "Done.";
                }),
              ),
            ) as Effect.Effect<A, E | DockerError, Exclude<R, Sandbox>>,
          (_branchName) =>
            Effect.promise(async () => {
              try {
                await execAsync(
                  `git worktree remove "${sandboxBaseDir}" --force`,
                  { cwd: hostDir },
                ).catch(() => {});
              } catch {}
            }),
        ).pipe(
          Effect.map((value) => {
            // Check for uncommitted changes before cleanup
            return { value, preservedWorktreePath: sandboxBaseDir };
          }),
        ),
    });

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    // Should have the preserved worktree path
    expect(result.preservedWorktreePath).toBe(sandboxBaseDir);

    // Commits should still be surfaced
    expect(result.commits).toHaveLength(1);
    expect(result.commits[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("parseStreamLine (via claudeCode provider)", () => {
  it("extracts text from assistant message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello world" }] },
    });
    expect(claudeCode("test-model").parseStreamLine(line)).toEqual([
      { type: "text", text: "Hello world" },
    ]);
  });

  it("extracts result from result message", () => {
    const line = JSON.stringify({
      type: "result",
      result: "Final answer <promise>COMPLETE</promise>",
    });
    expect(claudeCode("test-model").parseStreamLine(line)).toEqual([
      {
        type: "result",
        result: "Final answer <promise>COMPLETE</promise>",
      },
    ]);
  });

  it("returns empty array for non-JSON lines", () => {
    expect(claudeCode("test-model").parseStreamLine("not json")).toEqual([]);
    expect(claudeCode("test-model").parseStreamLine("")).toEqual([]);
  });

  it("returns empty array for malformed JSON starting with {", () => {
    expect(claudeCode("test-model").parseStreamLine("{bad json")).toEqual([]);
    expect(
      claudeCode("test-model").parseStreamLine('{"type": "assistant", broken'),
    ).toEqual([]);
  });

  it("returns empty array for unrecognized JSON types", () => {
    const line = JSON.stringify({ type: "system", data: "something" });
    expect(claudeCode("test-model").parseStreamLine(line)).toEqual([]);
  });

  it("handles multiple text content blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
      },
    });
    expect(claudeCode("test-model").parseStreamLine(line)).toEqual([
      { type: "text", text: "Hello world" },
    ]);
  });

  it("skips malformed tool_use blocks (no name/input)", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "123" },
          { type: "text", text: "result" },
        ],
      },
    });
    expect(claudeCode("test-model").parseStreamLine(line)).toEqual([
      { type: "text", text: "result" },
    ]);
  });

  it("extracts tool_use block from assistant event (Bash → command arg)", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "npm test" } },
        ],
      },
    });
    expect(claudeCode("test-model").parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "Bash", args: "npm test" },
    ]);
  });

  it("handles mixed text and tool_use content blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Running tests..." },
          { type: "tool_use", name: "Bash", input: { command: "npm test" } },
        ],
      },
    });
    expect(claudeCode("test-model").parseStreamLine(line)).toEqual([
      { type: "text", text: "Running tests..." },
      { type: "tool_call", name: "Bash", args: "npm test" },
    ]);
  });

  it("handles multiple tool_use blocks in one event", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "npm test" } },
          {
            type: "tool_use",
            name: "WebSearch",
            input: { query: "typescript types" },
          },
        ],
      },
    });
    expect(claudeCode("test-model").parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "Bash", args: "npm test" },
      { type: "tool_call", name: "WebSearch", args: "typescript types" },
    ]);
  });

  it("extracts WebFetch tool_use with url arg", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "WebFetch",
            input: { url: "https://example.com" },
          },
        ],
      },
    });
    expect(claudeCode("test-model").parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "WebFetch", args: "https://example.com" },
    ]);
  });

  it("extracts Agent tool_use with description arg", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Agent",
            input: { description: "Run tests and report results" },
          },
        ],
      },
    });
    expect(claudeCode("test-model").parseStreamLine(line)).toEqual([
      {
        type: "tool_call",
        name: "Agent",
        args: "Run tests and report results",
      },
    ]);
  });

  it("filters out non-allowlisted tools (Read, Glob, Grep, Edit, Write)", () => {
    for (const name of ["Read", "Glob", "Grep", "Edit", "Write"]) {
      const line = JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name, input: { file_path: "/some/file" } },
          ],
        },
      });
      expect(claudeCode("test-model").parseStreamLine(line)).toEqual([]);
    }
  });

  it("filters out tool_use blocks with missing expected input field", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          // Bash with no `command` field
          { type: "tool_use", name: "Bash", input: { other: "value" } },
        ],
      },
    });
    expect(claudeCode("test-model").parseStreamLine(line)).toEqual([]);
  });

  it("keeps text events even when all tool_use blocks are filtered out", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Looking at files..." },
          { type: "tool_use", name: "Read", input: { file_path: "/foo" } },
        ],
      },
    });
    expect(claudeCode("test-model").parseStreamLine(line)).toEqual([
      { type: "text", text: "Looking at files..." },
    ]);
  });

  it("returns only text when event has no tool_use blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Just text, no tools" }],
      },
    });
    expect(claudeCode("test-model").parseStreamLine(line)).toEqual([
      { type: "text", text: "Just text, no tools" },
    ]);
  });
});

describe("Orchestrator tool call display integration", () => {
  it("emits toolCall display entries for allowlisted tools in stream", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-toolcall-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = Layer.merge(
      SilentDisplay.layer(ref),
      noopAgentStreamEmitterLayer,
    );

    const mockLayer = makeTestSandboxFactory(hostDir, (dir) => {
      const fsLayer = makeLocalSandboxLayer(dir);
      return Layer.succeed(Sandbox, {
        exec: (command, options) => {
          if (command.startsWith("claude ") && options?.onLine) {
            const onLine = options.onLine;
            const lines = [
              JSON.stringify({
                type: "assistant",
                message: {
                  content: [
                    { type: "text", text: "Running tests..." },
                    {
                      type: "tool_use",
                      name: "Bash",
                      input: { command: "npm test" },
                    },
                    {
                      type: "tool_use",
                      name: "WebSearch",
                      input: { query: "effect-ts docs" },
                    },
                    // Read should be filtered out
                    {
                      type: "tool_use",
                      name: "Read",
                      input: { file_path: "/src/foo.ts" },
                    },
                  ],
                },
              }),
              JSON.stringify({
                type: "result",
                result: "<promise>COMPLETE</promise>",
              }),
            ];
            for (const line of lines) onLine(line);
            return Effect.succeed({
              stdout: lines.join("\n"),
              stderr: "",
              exitCode: 0,
            });
          }
          return Effect.flatMap(Sandbox, (real) =>
            real.exec(command, options),
          ).pipe(Effect.provide(fsLayer));
        },
        copyIn: (hostPath, sandboxPath) =>
          Effect.flatMap(Sandbox, (real) =>
            real.copyIn(hostPath, sandboxPath),
          ).pipe(Effect.provide(fsLayer)),
        copyFileOut: (sandboxPath, hostPath) =>
          Effect.flatMap(Sandbox, (real) =>
            real.copyFileOut(sandboxPath, hostPath),
          ).pipe(Effect.provide(fsLayer)),
      });
    });

    await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do some work",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            mockLayer.factoryLayer,
            displayLayer,
            defaultSessionPathsLayer,
            noopAgentStreamEmitterLayer,
          ),
        ),
      ),
    );

    const entries = await Effect.runPromise(Ref.get(ref));
    const toolCallEntries = entries.filter((e) => e._tag === "toolCall") as {
      _tag: "toolCall";
      name: string;
      formattedArgs: string;
    }[];

    expect(toolCallEntries).toHaveLength(2);
    expect(toolCallEntries[0]).toEqual({
      _tag: "toolCall",
      name: "Bash",
      formattedArgs: "npm test",
    });
    expect(toolCallEntries[1]).toEqual({
      _tag: "toolCall",
      name: "WebSearch",
      formattedArgs: "effect-ts docs",
    });
  });
});

describe("Orchestrator agent stream emitter", () => {
  it("emits text and toolCall events with iteration index and timestamps", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-stream-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = SilentDisplay.layer(ref);

    const events: AgentStreamEvent[] = [];
    const emitterLayer = callbackAgentStreamEmitterLayer((e) => {
      events.push(e);
    });

    const mockLayer = makeTestSandboxFactory(hostDir, (dir) => {
      const fsLayer = makeLocalSandboxLayer(dir);
      return Layer.succeed(Sandbox, {
        exec: (command, options) => {
          if (command.startsWith("claude ") && options?.onLine) {
            const onLine = options.onLine;
            const lines = [
              JSON.stringify({
                type: "assistant",
                message: {
                  content: [
                    { type: "text", text: "Working now" },
                    {
                      type: "tool_use",
                      name: "Bash",
                      input: { command: "ls" },
                    },
                  ],
                },
              }),
              JSON.stringify({
                type: "result",
                result: "<promise>COMPLETE</promise>",
              }),
            ];
            for (const line of lines) onLine(line);
            return Effect.succeed({
              stdout: lines.join("\n"),
              stderr: "",
              exitCode: 0,
            });
          }
          return Effect.flatMap(Sandbox, (real) =>
            real.exec(command, options),
          ).pipe(Effect.provide(fsLayer));
        },
        copyIn: (hostPath, sandboxPath) =>
          Effect.flatMap(Sandbox, (real) =>
            real.copyIn(hostPath, sandboxPath),
          ).pipe(Effect.provide(fsLayer)),
        copyFileOut: (sandboxPath, hostPath) =>
          Effect.flatMap(Sandbox, (real) =>
            real.copyFileOut(sandboxPath, hostPath),
          ).pipe(Effect.provide(fsLayer)),
      });
    });

    await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do work",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            mockLayer.factoryLayer,
            displayLayer,
            defaultSessionPathsLayer,
            emitterLayer,
          ),
        ),
      ),
    );

    const textEvents = events.filter((e) => e.type === "text");
    const toolCallEvents = events.filter((e) => e.type === "toolCall");

    expect(textEvents.length).toBeGreaterThan(0);
    expect(textEvents[0]!.message).toContain("Working now");
    expect(textEvents[0]!.iteration).toBe(1);
    expect(textEvents[0]!.timestamp).toBeInstanceOf(Date);

    expect(toolCallEvents).toHaveLength(1);
    expect(toolCallEvents[0]).toMatchObject({
      type: "toolCall",
      name: "Bash",
      formattedArgs: "ls",
      iteration: 1,
    });
    expect(toolCallEvents[0]!.timestamp).toBeInstanceOf(Date);
  });

  it("swallows errors thrown by the callback", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-stream-err-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = SilentDisplay.layer(ref);

    const emitterLayer = callbackAgentStreamEmitterLayer(() => {
      throw new Error("callback intentionally broken");
    });

    const mockLayer = makeTestSandboxFactory(hostDir, (dir) => {
      const fsLayer = makeLocalSandboxLayer(dir);
      return Layer.succeed(Sandbox, {
        exec: (command, options) => {
          if (command.startsWith("claude ") && options?.onLine) {
            const onLine = options.onLine;
            const lines = [
              JSON.stringify({
                type: "assistant",
                message: {
                  content: [{ type: "text", text: "Hello there" }],
                },
              }),
              JSON.stringify({
                type: "result",
                result: "<promise>COMPLETE</promise>",
              }),
            ];
            for (const line of lines) onLine(line);
            return Effect.succeed({
              stdout: lines.join("\n"),
              stderr: "",
              exitCode: 0,
            });
          }
          return Effect.flatMap(Sandbox, (real) =>
            real.exec(command, options),
          ).pipe(Effect.provide(fsLayer));
        },
        copyIn: (hostPath, sandboxPath) =>
          Effect.flatMap(Sandbox, (real) =>
            real.copyIn(hostPath, sandboxPath),
          ).pipe(Effect.provide(fsLayer)),
        copyFileOut: (sandboxPath, hostPath) =>
          Effect.flatMap(Sandbox, (real) =>
            real.copyFileOut(sandboxPath, hostPath),
          ).pipe(Effect.provide(fsLayer)),
      });
    });

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do work",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            mockLayer.factoryLayer,
            displayLayer,
            defaultSessionPathsLayer,
            emitterLayer,
          ),
        ),
      ),
    );

    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
  });
});

describe("Orchestrator error handling", () => {
  it("propagates SandboxError when agent exits with non-zero code", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-err-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Layer where agent invocation returns non-zero exit code
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const fsLayer = makeLocalSandboxLayer(dir);
        return Layer.succeed(Sandbox, {
          exec: (command, options) => {
            if (command.startsWith("claude ") && options?.onLine) {
              return Effect.succeed({
                stdout: "",
                stderr: "Agent crashed",
                exitCode: 1,
              });
            }
            return Effect.flatMap(Sandbox, (real) =>
              real.exec(command, options),
            ).pipe(Effect.provide(fsLayer));
          },
          copyIn: (hostPath, sandboxPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyIn(hostPath, sandboxPath),
            ).pipe(Effect.provide(fsLayer)),
          copyFileOut: (sandboxPath, hostPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyFileOut(sandboxPath, hostPath),
            ).pipe(Effect.provide(fsLayer)),
        });
      },
    );

    const exit = await Effect.runPromiseExit(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(exit._tag).toBe("Failure");
  });

  it("falls back to stdout when stream has no result line", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-fallback-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Layer where agent stream emits only assistant lines, no result line.
    // stdout contains the completion signal so the fallback path picks it up.
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const fsLayer = makeLocalSandboxLayer(dir);
        return Layer.succeed(Sandbox, {
          exec: (command, options) => {
            if (command.startsWith("claude ") && options?.onLine) {
              const onLine = options.onLine;
              // Only emit an assistant line, no result line
              const assistantLine = JSON.stringify({
                type: "assistant",
                message: { content: [{ type: "text", text: "working..." }] },
              });
              onLine(assistantLine);
              return Effect.succeed({
                stdout: "All done. <promise>COMPLETE</promise>",
                stderr: "",
                exitCode: 0,
              });
            }
            return Effect.flatMap(Sandbox, (real) =>
              real.exec(command, options),
            ).pipe(Effect.provide(fsLayer));
          },
          copyIn: (hostPath, sandboxPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyIn(hostPath, sandboxPath),
            ).pipe(Effect.provide(fsLayer)),
          copyFileOut: (sandboxPath, hostPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyFileOut(sandboxPath, hostPath),
            ).pipe(Effect.provide(fsLayer)),
        });
      },
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 5,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    // Should detect COMPLETE from the stdout fallback
    expect(result.iterations.length).toBe(1);
    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
  });

  it("preserves iteration 1 work when agent fails on iteration 2", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-partial-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let callCount = 0;

    // Layer: iteration 1 succeeds with a commit, iteration 2 agent crashes
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const fsLayer = makeLocalSandboxLayer(dir);
        return Layer.succeed(Sandbox, {
          exec: (command, options) => {
            if (command.startsWith("claude ") && options?.onLine) {
              const onLine = options.onLine;
              callCount++;
              if (callCount === 1) {
                // Iteration 1: make a commit
                return Effect.gen(function* () {
                  const cwd = options?.cwd ?? dir;
                  yield* Effect.promise(async () => {
                    await writeFile(join(cwd, "iter1.txt"), "iteration 1 data");
                    await execAsync("git add -A", { cwd });
                    await execAsync('git config user.email "agent@test.com"', {
                      cwd,
                    });
                    await execAsync('git config user.name "Agent"', { cwd });
                    await execAsync('git commit -m "RALPH: iteration 1"', {
                      cwd,
                    });
                  });
                  const output = "Finished iteration 1.";
                  const streamOutput = toStreamJson(output);
                  for (const line of streamOutput.split("\n")) {
                    onLine(line);
                  }
                  return { stdout: streamOutput, stderr: "", exitCode: 0 };
                });
              }
              // Iteration 2: agent crashes
              return Effect.succeed({
                stdout: "",
                stderr: "Agent segfault",
                exitCode: 1,
              });
            }
            return Effect.flatMap(Sandbox, (real) =>
              real.exec(command, options),
            ).pipe(Effect.provide(fsLayer));
          },
          copyIn: (hostPath, sandboxPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyIn(hostPath, sandboxPath),
            ).pipe(Effect.provide(fsLayer)),
          copyFileOut: (sandboxPath, hostPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyFileOut(sandboxPath, hostPath),
            ).pipe(Effect.provide(fsLayer)),
        });
      },
    );

    const exit = await Effect.runPromiseExit(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 3,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    // Should have failed on iteration 2
    expect(exit._tag).toBe("Failure");

    // But iteration 1's commit should be preserved on host
    const content = await readFile(join(hostDir, "iter1.txt"), "utf-8");
    expect(content).toBe("iteration 1 data");
  });

  it("propagates error when syncIn fails (invalid host repo)", async () => {
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      "/nonexistent/repo",
      (dir) => makeMockAgentLayer(dir, async () => "done"),
    );

    const exit = await Effect.runPromiseExit(
      orchestrate({
        provider: testProvider,
        hostRepoDir: "/nonexistent/repo",

        iterations: 1,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(exit._tag).toBe("Failure");
  });

  it("propagates error when sandbox branch resolution fails", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-nohead-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Layer that sabotages branch resolution in the sandbox
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const fsLayer = makeLocalSandboxLayer(dir);
        return Layer.succeed(Sandbox, {
          exec: (command, options) => {
            if (command === "git rev-parse --abbrev-ref HEAD") {
              return Effect.succeed({
                stdout: "",
                stderr: "fatal: ambiguous argument 'HEAD'",
                exitCode: 128,
              });
            }
            return Effect.flatMap(Sandbox, (real) =>
              real.exec(command, options),
            ).pipe(Effect.provide(fsLayer));
          },
          copyIn: (hostPath, sandboxPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyIn(hostPath, sandboxPath),
            ).pipe(Effect.provide(fsLayer)),
          copyFileOut: (sandboxPath, hostPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyFileOut(sandboxPath, hostPath),
            ).pipe(Effect.provide(fsLayer)),
        });
      },
    );

    const exit = await Effect.runPromiseExit(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(exit._tag).toBe("Failure");
  });

  it("falls back to tail of stdout when stderr is empty on non-zero exit (no-op parser)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-stderr-fallback-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const opencodeProvider = opencodeFactory("test-model");
    const stdoutContent = "Setting up environment...\nLoading model...\nError: API key is invalid\nPlease check your credentials";

    const { factoryLayer } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const fsLayer = makeLocalSandboxLayer(dir);
        return Layer.succeed(Sandbox, {
          exec: (command, options) => {
            if (command.startsWith("opencode ")) {
              return Effect.succeed({
                stdout: stdoutContent,
                stderr: "",
                exitCode: 1,
              });
            }
            return Effect.flatMap(Sandbox, (real) =>
              real.exec(command, options),
            ).pipe(Effect.provide(fsLayer));
          },
          copyIn: (hostPath, sandboxPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyIn(hostPath, sandboxPath),
            ).pipe(Effect.provide(fsLayer)),
          copyFileOut: (sandboxPath, hostPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyFileOut(sandboxPath, hostPath),
            ).pipe(Effect.provide(fsLayer)),
        });
      },
    );

    const exit = await Effect.runPromiseExit(
      orchestrate({
        provider: opencodeProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const err = Cause.squash(exit.cause);
      expect(err).toBeInstanceOf(AgentError);
      if (err instanceof AgentError) {
        expect(err.message).toContain("opencode exited with code 1:");
        expect(err.message).toContain("API key is invalid");
      }
    }
  });

  it("falls back to resultText when stderr is empty on non-zero exit (structured parser)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-resulttext-fallback-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Use Claude Code provider which has a structured parser that populates resultText
    const errorLine = JSON.stringify({
      type: "result",
      result: "Rate limit exceeded, please retry later",
    });

    const { factoryLayer } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const fsLayer = makeLocalSandboxLayer(dir);
        return Layer.succeed(Sandbox, {
          exec: (command, options) => {
            if (command.startsWith("claude ") && options?.onLine) {
              options.onLine(errorLine);
              return Effect.succeed({
                stdout: errorLine,
                stderr: "",
                exitCode: 1,
              });
            }
            return Effect.flatMap(Sandbox, (real) =>
              real.exec(command, options),
            ).pipe(Effect.provide(fsLayer));
          },
          copyIn: (hostPath, sandboxPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyIn(hostPath, sandboxPath),
            ).pipe(Effect.provide(fsLayer)),
          copyFileOut: (sandboxPath, hostPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyFileOut(sandboxPath, hostPath),
            ).pipe(Effect.provide(fsLayer)),
        });
      },
    );

    const exit = await Effect.runPromiseExit(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const err = Cause.squash(exit.cause);
      expect(err).toBeInstanceOf(AgentError);
      if (err instanceof AgentError) {
        expect(err.message).toContain("claude-code exited with code 1:");
        expect(err.message).toContain("Rate limit exceeded, please retry later");
      }
    }
  });

  it("preserves stderr in error when stderr is non-empty", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-stderr-present-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const opencodeProvider = opencodeFactory("test-model");

    const { factoryLayer } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const fsLayer = makeLocalSandboxLayer(dir);
        return Layer.succeed(Sandbox, {
          exec: (command, options) => {
            if (command.startsWith("opencode ")) {
              return Effect.succeed({
                stdout: "some stdout output",
                stderr: "fatal error from stderr",
                exitCode: 1,
              });
            }
            return Effect.flatMap(Sandbox, (real) =>
              real.exec(command, options),
            ).pipe(Effect.provide(fsLayer));
          },
          copyIn: (hostPath, sandboxPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyIn(hostPath, sandboxPath),
            ).pipe(Effect.provide(fsLayer)),
          copyFileOut: (sandboxPath, hostPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyFileOut(sandboxPath, hostPath),
            ).pipe(Effect.provide(fsLayer)),
        });
      },
    );

    const exit = await Effect.runPromiseExit(
      orchestrate({
        provider: opencodeProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const err = Cause.squash(exit.cause);
      expect(err).toBeInstanceOf(AgentError);
      if (err instanceof AgentError) {
        expect(err.message).toContain("fatal error from stderr");
        // Should NOT fall back to stdout when stderr is present
        expect(err.message).not.toContain("some stdout output");
      }
    }
  });
});

describe("Orchestrator streaming", () => {
  it("invokes claude with stream-json and verbose flags", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-stream-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let capturedCommand = "";

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const fsLayer = makeLocalSandboxLayer(dir);
        return Layer.succeed(Sandbox, {
          exec: (command, options) => {
            if (command.startsWith("claude ") && options?.onLine) {
              const onLine = options.onLine;
              capturedCommand = command;
              const output = "Test output";
              const streamOutput = toStreamJson(output);
              for (const line of streamOutput.split("\n")) {
                onLine(line);
              }
              return Effect.succeed({
                stdout: streamOutput,
                stderr: "",
                exitCode: 0,
              });
            }
            return Effect.flatMap(Sandbox, (real) =>
              real.exec(command, options),
            ).pipe(Effect.provide(fsLayer));
          },
          copyIn: (hostPath, sandboxPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyIn(hostPath, sandboxPath),
            ).pipe(Effect.provide(fsLayer)),
          copyFileOut: (sandboxPath, hostPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyFileOut(sandboxPath, hostPath),
            ).pipe(Effect.provide(fsLayer)),
        });
      },
    );

    await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(capturedCommand).toContain("--output-format stream-json");
    expect(capturedCommand).toContain("--verbose");
    expect(capturedCommand).not.toContain("--output-format text");
  });

  it("extracts completion signal from stream-json result line", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-result-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent that emits completion via stream-json result type
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "All done. <promise>COMPLETE</promise>";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 5,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(1);
    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
  });

  it("uses the model baked into the provider", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-defmodel-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let capturedCommand = "";

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const fsLayer = makeLocalSandboxLayer(dir);
        return Layer.succeed(Sandbox, {
          exec: (command, options) => {
            if (command.startsWith("claude ") && options?.onLine) {
              const onLine = options.onLine;
              capturedCommand = command;
              const output = "Done.";
              const streamOutput = toStreamJson(output);
              for (const line of streamOutput.split("\n")) {
                onLine(line);
              }
              return Effect.succeed({
                stdout: streamOutput,
                stderr: "",
                exitCode: 0,
              });
            }
            return Effect.flatMap(Sandbox, (real) =>
              real.exec(command, options),
            ).pipe(Effect.provide(fsLayer));
          },
          copyIn: (hostPath, sandboxPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyIn(hostPath, sandboxPath),
            ).pipe(Effect.provide(fsLayer)),
          copyFileOut: (sandboxPath, hostPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyFileOut(sandboxPath, hostPath),
            ).pipe(Effect.provide(fsLayer)),
        });
      },
    );

    await Effect.runPromise(
      orchestrate({
        provider: claudeCode(DEFAULT_MODEL),
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(capturedCommand).toContain(`--model '${DEFAULT_MODEL}'`);
  });

  it("uses the model from a custom provider", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-custmodel-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let capturedCommand = "";

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const fsLayer = makeLocalSandboxLayer(dir);
        return Layer.succeed(Sandbox, {
          exec: (command, options) => {
            if (command.startsWith("claude ") && options?.onLine) {
              const onLine = options.onLine;
              capturedCommand = command;
              const output = "Done.";
              const streamOutput = toStreamJson(output);
              for (const line of streamOutput.split("\n")) {
                onLine(line);
              }
              return Effect.succeed({
                stdout: streamOutput,
                stderr: "",
                exitCode: 0,
              });
            }
            return Effect.flatMap(Sandbox, (real) =>
              real.exec(command, options),
            ).pipe(Effect.provide(fsLayer));
          },
          copyIn: (hostPath, sandboxPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyIn(hostPath, sandboxPath),
            ).pipe(Effect.provide(fsLayer)),
          copyFileOut: (sandboxPath, hostPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyFileOut(sandboxPath, hostPath),
            ).pipe(Effect.provide(fsLayer)),
        });
      },
    );

    await Effect.runPromise(
      orchestrate({
        provider: claudeCode("claude-sonnet-4-6"),
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(capturedCommand).toContain("--model 'claude-sonnet-4-6'");
    expect(capturedCommand).not.toContain(DEFAULT_MODEL);
  });
});

describe("Orchestrator prompt preprocessing", () => {
  it("preprocesses !`command` expressions in the prompt before invoking agent", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-preproc-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let capturedStdin = "";

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const fsLayer = makeLocalSandboxLayer(dir);
        return Layer.succeed(Sandbox, {
          exec: (command, options) => {
            if (command.startsWith("claude ") && options?.onLine) {
              const onLine = options.onLine;
              // Capture the prompt delivered via stdin
              capturedStdin = options?.stdin ?? "";
              const output = "Done.";
              const streamOutput = toStreamJson(output);
              for (const line of streamOutput.split("\n")) {
                onLine(line);
              }
              return Effect.succeed({
                stdout: streamOutput,
                stderr: "",
                exitCode: 0,
              });
            }
            return Effect.flatMap(Sandbox, (real) =>
              real.exec(command, options),
            ).pipe(Effect.provide(fsLayer));
          },
          copyIn: (hostPath, sandboxPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyIn(hostPath, sandboxPath),
            ).pipe(Effect.provide(fsLayer)),
          copyFileOut: (sandboxPath, hostPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyFileOut(sandboxPath, hostPath),
            ).pipe(Effect.provide(fsLayer)),
        });
      },
    );

    // In production the prompt is always run through substitutePromptArgs
    // before reaching orchestrate (which marks template shell blocks).
    const marked = await Effect.runPromise(
      substitutePromptArgs(
        "Context: !`echo hello-from-sandbox`\n\nDo the work.",
        {},
      ).pipe(Effect.provide(testDisplayLayer)),
    );
    await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: marked,
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    // The prompt should have !`echo hello-from-sandbox` replaced with "hello-from-sandbox"
    expect(capturedStdin).toContain("hello-from-sandbox");
    expect(capturedStdin).not.toContain("!`echo");
  });

  it("passes prompt through unchanged when no !`command` expressions", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-nopreproc-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let capturedStdin = "";

    // Intercept to capture prompt delivered via stdin
    const { factoryLayer: fl2, sandboxRepoDir: sr2 } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const fsLayer = makeLocalSandboxLayer(dir);
        return Layer.succeed(Sandbox, {
          exec: (command, options) => {
            if (command.startsWith("claude ") && options?.onLine) {
              const onLine = options.onLine;
              capturedStdin = options?.stdin ?? "";
              const output = "Done.";
              const streamOutput = toStreamJson(output);
              for (const line of streamOutput.split("\n")) {
                onLine(line);
              }
              return Effect.succeed({
                stdout: streamOutput,
                stderr: "",
                exitCode: 0,
              });
            }
            return Effect.flatMap(Sandbox, (real) =>
              real.exec(command, options),
            ).pipe(Effect.provide(fsLayer));
          },
          copyIn: (hostPath, sandboxPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyIn(hostPath, sandboxPath),
            ).pipe(Effect.provide(fsLayer)),
          copyFileOut: (sandboxPath, hostPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyFileOut(sandboxPath, hostPath),
            ).pipe(Effect.provide(fsLayer)),
        });
      },
    );

    await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "Just a plain prompt with no commands.",
      }).pipe(Effect.provide(Layer.merge(fl2, testDisplayLayer))),
    );

    expect(capturedStdin).toContain("Just a plain prompt with no commands.");
  });

  it("passes prompt through literally when skipPromptExpansion is true", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-skipexp-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let capturedStdin = "";

    const { factoryLayer } = makeTestSandboxFactory(hostDir, (dir) => {
      const fsLayer = makeLocalSandboxLayer(dir);
      return Layer.succeed(Sandbox, {
        exec: (command, options) => {
          if (command.startsWith("claude ") && options?.onLine) {
            const onLine = options.onLine;
            capturedStdin = options?.stdin ?? "";
            const output = "Done.";
            const streamOutput = toStreamJson(output);
            for (const line of streamOutput.split("\n")) {
              onLine(line);
            }
            return Effect.succeed({
              stdout: streamOutput,
              stderr: "",
              exitCode: 0,
            });
          }
          return Effect.flatMap(Sandbox, (real) =>
            real.exec(command, options),
          ).pipe(Effect.provide(fsLayer));
        },
        copyIn: (hostPath, sandboxPath) =>
          Effect.flatMap(Sandbox, (real) =>
            real.copyIn(hostPath, sandboxPath),
          ).pipe(Effect.provide(fsLayer)),
        copyFileOut: (sandboxPath, hostPath) =>
          Effect.flatMap(Sandbox, (real) =>
            real.copyFileOut(sandboxPath, hostPath),
          ).pipe(Effect.provide(fsLayer)),
      });
    });

    const literalPrompt =
      "Context: !`echo hello-from-sandbox`\n\n{{ISSUE_NUMBER}} should pass through.";

    await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: literalPrompt,
        skipPromptExpansion: true,
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    // Both the shell expression and the {{KEY}} placeholder are delivered verbatim.
    expect(capturedStdin).toContain("!`echo hello-from-sandbox`");
    expect(capturedStdin).toContain("{{ISSUE_NUMBER}}");
    expect(capturedStdin).not.toContain("hello-from-sandbox\n");
  });
});

describe("Orchestrator Display integration", () => {
  it("emits iteration header, spinner, and completion status", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-display-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = Layer.merge(
      SilentDisplay.layer(ref),
      noopAgentStreamEmitterLayer,
    );

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "All done. <promise>COMPLETE</promise>";
        }),
    );

    await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 5,
        prompt: "do some work",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(factoryLayer, displayLayer, defaultSessionPathsLayer),
        ),
      ),
    );

    const entries = await Effect.runPromise(Ref.get(ref));

    // Iteration header
    const statusEntries = entries.filter((e) => e._tag === "status");
    expect(statusEntries.some((e) => e.message.includes("Iteration 1/5"))).toBe(
      true,
    );

    // Task log for sandbox setup
    const taskLogEntries = entries.filter((e) => e._tag === "taskLog");
    expect(
      taskLogEntries.some((e) => e.title.includes("Setting up sandbox")),
    ).toBe(true);

    // No spinner for sync-out when agent produces no commits
    const spinnerEntries = entries.filter((e) => e._tag === "spinner");
    expect(
      spinnerEntries.some((e) =>
        e.message.includes("Syncing commits back to host"),
      ),
    ).toBe(false);

    // No usage summary emitted
    const summaryEntries = entries.filter((e) => e._tag === "summary");
    expect(summaryEntries).toHaveLength(0);

    // Completion status
    expect(
      statusEntries.some(
        (e) =>
          e.message.includes("completion") || e.message.includes("complete"),
      ),
    ).toBe(true);
  });

  it("labels iteration header and max-reached message with 'max'", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-maxlabel-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = Layer.merge(
      SilentDisplay.layer(ref),
      noopAgentStreamEmitterLayer,
    );

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          // Never signals completion
          return "Nothing to do.";
        }),
    );

    await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 2,
        prompt: "do some work",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(factoryLayer, displayLayer, defaultSessionPathsLayer),
        ),
      ),
    );

    const entries = await Effect.runPromise(Ref.get(ref));
    const statusEntries = entries.filter((e) => e._tag === "status");

    // Iteration header should NOT include "(max)" — the summary already communicates the max
    expect(statusEntries.some((e) => e.message.includes("Iteration 1/2"))).toBe(
      true,
    );
    expect(statusEntries.every((e) => !e.message.includes("(max)"))).toBe(true);

    // Completion message when max is reached should say "max iterations"
    expect(
      statusEntries.some((e) => e.message.includes("max iterations")),
    ).toBe(true);
  });

  it("uses 10 minutes as the default idle timeout", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-timeout-default-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => makeMockAgentLayer(dir, async () => "done"),
    );

    // Verify indirectly: a run that completes quickly should not time out.
    // The default idle timeout is 600s (10 minutes) — far longer than any mock agent delay.
    const exitResult = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "test",
        // No idleTimeoutSeconds — should default to 10 minutes (600s)
      }).pipe(
        Effect.provide(Layer.merge(factoryLayer, testDisplayLayer)),
        Effect.exit,
      ),
    );

    // The run completes successfully — default idle timeout is large enough
    expect(exitResult._tag).toBe("Success");
  }, 10_000);

  it("prefixes status messages with [name] when name is provided", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-name-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = Layer.merge(
      SilentDisplay.layer(ref),
      noopAgentStreamEmitterLayer,
    );

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "All done. <promise>COMPLETE</promise>";
        }),
    );

    await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "do some work",
        name: "issue-42",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(factoryLayer, displayLayer, defaultSessionPathsLayer),
        ),
      ),
    );

    const entries = await Effect.runPromise(Ref.get(ref));
    const statusEntries = entries.filter((e) => e._tag === "status");

    // All status messages should be prefixed with [issue-42]
    expect(statusEntries.every((e) => e.message.startsWith("[issue-42]"))).toBe(
      true,
    );
    // Iteration message should still be readable
    expect(statusEntries.some((e) => e.message.includes("Iteration 1/1"))).toBe(
      true,
    );
  });

  it("does not prefix status messages when no name is provided", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-noname-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = Layer.merge(
      SilentDisplay.layer(ref),
      noopAgentStreamEmitterLayer,
    );

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "All done. <promise>COMPLETE</promise>";
        }),
    );

    await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "do some work",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(factoryLayer, displayLayer, defaultSessionPathsLayer),
        ),
      ),
    );

    const entries = await Effect.runPromise(Ref.get(ref));
    const statusEntries = entries.filter((e) => e._tag === "status");

    // No status messages should be prefixed with brackets
    expect(statusEntries.every((e) => !e.message.startsWith("["))).toBe(true);
  });

  it("fails with AgentIdleTimeoutError when idleTimeoutSeconds is exceeded with no output", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-timeout-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: takes 2 seconds to respond and produces no output during that time
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          return "done";
        }),
    );

    const exitResult = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "test",
        idleTimeoutSeconds: 0.1, // 100ms — well below the 2s agent delay with no output
      }).pipe(
        Effect.provide(Layer.merge(factoryLayer, testDisplayLayer)),
        Effect.exit,
      ),
    );

    expect(exitResult._tag).toBe("Failure");
    if (exitResult._tag === "Failure") {
      const err = Cause.squash(exitResult.cause);
      expect(err).toBeInstanceOf(AgentIdleTimeoutError);
      if (err instanceof AgentIdleTimeoutError) {
        expect(err.timeoutMs).toBe(100);
        expect(err.message).toContain("idle");
        expect(err.message).toContain("--idle-timeout");
      }
    }
  }, 10_000);

  it("resets the idle timer on each text/tool_call output", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-idle-reset-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: emits text after 100ms, then completes after another 100ms.
    // With idleTimeoutSeconds=0.15 (150ms), the timer fires at t=150ms without reset.
    // But the text event at t=100ms should reset the timer to t=250ms, allowing
    // the run to complete at t=200ms before the reset timer fires.
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const fsLayer = makeLocalSandboxLayer(dir);
        return Layer.succeed(Sandbox, {
          exec: (command, options) => {
            if (command.startsWith("claude ") && options?.onLine) {
              const onLine = options.onLine;
              return Effect.gen(function* () {
                // Wait 100ms then emit a text event (resets idle timer)
                yield* Effect.promise(
                  () => new Promise((resolve) => setTimeout(resolve, 100)),
                );
                onLine(
                  JSON.stringify({
                    type: "assistant",
                    message: {
                      content: [{ type: "text", text: "working..." }],
                    },
                  }),
                );
                // Wait another 100ms then emit the result
                yield* Effect.promise(
                  () => new Promise((resolve) => setTimeout(resolve, 100)),
                );
                onLine(JSON.stringify({ type: "result", result: "done" }));
                return { stdout: "", stderr: "", exitCode: 0 };
              });
            }
            return Effect.flatMap(Sandbox, (real) =>
              real.exec(command, options),
            ).pipe(Effect.provide(fsLayer));
          },
          copyIn: (hostPath, sandboxPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyIn(hostPath, sandboxPath),
            ).pipe(Effect.provide(fsLayer)),
          copyFileOut: (sandboxPath, hostPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyFileOut(sandboxPath, hostPath),
            ).pipe(Effect.provide(fsLayer)),
        });
      },
    );

    const exitResult = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "test",
        idleTimeoutSeconds: 0.15, // 150ms — timer resets on text at t=100ms
      }).pipe(
        Effect.provide(Layer.merge(factoryLayer, testDisplayLayer)),
        Effect.exit,
      ),
    );

    // Should succeed because the text event at t=100ms resets the idle timer
    expect(exitResult._tag).toBe("Success");
  }, 10_000);

  it("resets the idle timer on unparsed stdout lines (no structured events)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-idle-raw-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: emits raw (non-JSON) stdout lines that don't parse into any
    // structured event, then completes. With idleTimeoutSeconds=0.15 (150ms),
    // the timer would fire at t=150ms if only parsed events reset it.
    // The raw line at t=100ms should reset the timer to t=250ms, allowing
    // the run to complete at t=200ms.
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const fsLayer = makeLocalSandboxLayer(dir);
        return Layer.succeed(Sandbox, {
          exec: (command, options) => {
            if (command.startsWith("claude ") && options?.onLine) {
              const onLine = options.onLine;
              return Effect.gen(function* () {
                // Wait 100ms then emit a raw, unparsable line (should still reset idle timer)
                yield* Effect.promise(
                  () => new Promise((resolve) => setTimeout(resolve, 100)),
                );
                onLine("raw TUI output: rendering panel...");
                // Wait another 100ms then emit the result so the run completes
                yield* Effect.promise(
                  () => new Promise((resolve) => setTimeout(resolve, 100)),
                );
                onLine(JSON.stringify({ type: "result", result: "done" }));
                return { stdout: "", stderr: "", exitCode: 0 };
              });
            }
            return Effect.flatMap(Sandbox, (real) =>
              real.exec(command, options),
            ).pipe(Effect.provide(fsLayer));
          },
          copyIn: (hostPath, sandboxPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyIn(hostPath, sandboxPath),
            ).pipe(Effect.provide(fsLayer)),
          copyFileOut: (sandboxPath, hostPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyFileOut(sandboxPath, hostPath),
            ).pipe(Effect.provide(fsLayer)),
        });
      },
    );

    const exitResult = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "test",
        idleTimeoutSeconds: 0.15, // 150ms — should be reset by raw stdout at t=100ms
      }).pipe(
        Effect.provide(Layer.merge(factoryLayer, testDisplayLayer)),
        Effect.exit,
      ),
    );

    // Should succeed because the raw stdout line at t=100ms resets the idle timer
    expect(exitResult._tag).toBe("Success");
  }, 10_000);

  it("logs periodic idle warnings every IDLE_WARNING_INTERVAL_MS of inactivity", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-idle-warn-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Agent stays idle for 250ms with _idleWarningIntervalMs=100ms,
    // so ~2 warnings should fire before the agent completes.
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const fsLayer = makeLocalSandboxLayer(dir);
        return Layer.succeed(Sandbox, {
          exec: (command, options) => {
            if (command.startsWith("claude ") && options?.onLine) {
              const onLine = options.onLine;
              return Effect.gen(function* () {
                // Stay idle for 250ms — enough for ~2 warnings at 100ms interval
                yield* Effect.promise(
                  () => new Promise((resolve) => setTimeout(resolve, 250)),
                );
                onLine(JSON.stringify({ type: "result", result: "done" }));
                return { stdout: "", stderr: "", exitCode: 0 };
              });
            }
            return Effect.flatMap(Sandbox, (real) =>
              real.exec(command, options),
            ).pipe(Effect.provide(fsLayer));
          },
          copyIn: (hostPath, sandboxPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyIn(hostPath, sandboxPath),
            ).pipe(Effect.provide(fsLayer)),
          copyFileOut: (sandboxPath, hostPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyFileOut(sandboxPath, hostPath),
            ).pipe(Effect.provide(fsLayer)),
        });
      },
    );

    const displayEntries = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = Layer.merge(
      SilentDisplay.layer(displayEntries),
      noopAgentStreamEmitterLayer,
    );

    const exitResult = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "test",
        idleTimeoutSeconds: 10, // high enough not to kill
        _idleWarningIntervalMs: 100, // fire warnings every 100ms for testing
      }).pipe(
        Effect.provide(
          Layer.mergeAll(factoryLayer, displayLayer, defaultSessionPathsLayer),
        ),
        Effect.exit,
      ),
    );

    expect(exitResult._tag).toBe("Success");

    const allEntries = await Effect.runPromise(Ref.get(displayEntries));
    const warningEntries = allEntries.filter(
      (e) => e._tag === "status" && e.severity === "warn",
    );

    // Should have at least 2 warning entries (at ~100ms and ~200ms)
    expect(warningEntries.length).toBeGreaterThanOrEqual(2);
    // First warning should say "1 minute" (even though the interval is 100ms in test)
    expect((warningEntries[0] as { message: string }).message).toContain(
      "Agent idle for 1 minute",
    );
    expect((warningEntries[1] as { message: string }).message).toContain(
      "Agent idle for 2 minutes",
    );
  }, 10_000);

  it("resets idle warning counter when agent produces output", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-idle-warn-reset-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: idle 150ms, emit text (resets counter), idle 150ms, complete.
    // With 100ms warning interval, we should see warning at ~100ms (1 minute),
    // then text at ~150ms resets counter, then warning at ~250ms (1 minute again, not 2).
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const fsLayer = makeLocalSandboxLayer(dir);
        return Layer.succeed(Sandbox, {
          exec: (command, options) => {
            if (command.startsWith("claude ") && options?.onLine) {
              const onLine = options.onLine;
              return Effect.gen(function* () {
                // Idle for 150ms — warning fires at ~100ms
                yield* Effect.promise(
                  () => new Promise((resolve) => setTimeout(resolve, 150)),
                );
                // Emit text — should reset the warning counter
                onLine(
                  JSON.stringify({
                    type: "assistant",
                    message: {
                      content: [{ type: "text", text: "working..." }],
                    },
                  }),
                );
                // Idle for another 150ms — warning fires at ~100ms after reset
                yield* Effect.promise(
                  () => new Promise((resolve) => setTimeout(resolve, 150)),
                );
                onLine(JSON.stringify({ type: "result", result: "done" }));
                return { stdout: "", stderr: "", exitCode: 0 };
              });
            }
            return Effect.flatMap(Sandbox, (real) =>
              real.exec(command, options),
            ).pipe(Effect.provide(fsLayer));
          },
          copyIn: (hostPath, sandboxPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyIn(hostPath, sandboxPath),
            ).pipe(Effect.provide(fsLayer)),
          copyFileOut: (sandboxPath, hostPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyFileOut(sandboxPath, hostPath),
            ).pipe(Effect.provide(fsLayer)),
        });
      },
    );

    const displayEntries = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = Layer.merge(
      SilentDisplay.layer(displayEntries),
      noopAgentStreamEmitterLayer,
    );

    const exitResult = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "test",
        idleTimeoutSeconds: 10,
        _idleWarningIntervalMs: 100,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(factoryLayer, displayLayer, defaultSessionPathsLayer),
        ),
        Effect.exit,
      ),
    );

    expect(exitResult._tag).toBe("Success");

    const allEntries = await Effect.runPromise(Ref.get(displayEntries));
    const warningEntries = allEntries.filter(
      (e) => e._tag === "status" && e.severity === "warn",
    );

    // Should have at least 2 warnings (one before text, one after text reset)
    expect(warningEntries.length).toBeGreaterThanOrEqual(2);
    // Both should say "1 minute" because the counter was reset by the text event
    expect((warningEntries[0] as { message: string }).message).toContain(
      "Agent idle for 1 minute",
    );
    expect((warningEntries[1] as { message: string }).message).toContain(
      "Agent idle for 1 minute",
    );
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Pi provider integration tests
// ---------------------------------------------------------------------------

const piTestProvider = piFactory("claude-sonnet-4-6");

/** Format a mock agent result as pi JSON stream lines */
const toPiStreamJson = (output: string): string => {
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: output },
    }),
  );
  lines.push(
    JSON.stringify({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: output }],
        },
      ],
    }),
  );
  return lines.join("\n");
};

/**
 * Create a mock sandbox layer that intercepts `pi` commands
 * and runs a mock script instead.
 */
const makeMockPiAgentLayer = (
  sandboxDir: string,
  mockAgentBehavior: (sandboxRepoDir: string) => Promise<string>,
): Layer.Layer<Sandbox> => {
  const fsLayer = makeLocalSandboxLayer(sandboxDir);

  return Layer.succeed(Sandbox, {
    exec: (command, options) => {
      if (command.startsWith("pi ")) {
        if (options?.onLine) {
          const onLine = options.onLine;
          return Effect.gen(function* () {
            const cwd = options?.cwd ?? sandboxDir;
            const output = yield* Effect.promise(() => mockAgentBehavior(cwd));
            const streamOutput = toPiStreamJson(output);
            for (const line of streamOutput.split("\n")) {
              onLine(line);
            }
            return { stdout: streamOutput, stderr: "", exitCode: 0 };
          });
        }
        return Effect.gen(function* () {
          const cwd = options?.cwd ?? sandboxDir;
          const output = yield* Effect.promise(() => mockAgentBehavior(cwd));
          return { stdout: output, stderr: "", exitCode: 0 };
        });
      }
      return Effect.flatMap(Sandbox, (real) =>
        real.exec(command, options),
      ).pipe(Effect.provide(fsLayer));
    },
    copyIn: (hostPath, sandboxPath) =>
      Effect.flatMap(Sandbox, (real) =>
        real.copyIn(hostPath, sandboxPath),
      ).pipe(Effect.provide(fsLayer)),
    copyFileOut: (sandboxPath, hostPath) =>
      Effect.flatMap(Sandbox, (real) =>
        real.copyFileOut(sandboxPath, hostPath),
      ).pipe(Effect.provide(fsLayer)),
  });
};

describe("Orchestrator with pi provider", () => {
  it("runs a single iteration with pi provider and produces a commit", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-pi-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockPiAgentLayer(dir, async (repoDir) => {
          await writeFile(join(repoDir, "pi-output.txt"), "pi was here");
          await execAsync("git add -A", { cwd: repoDir });
          await execAsync('git config user.email "agent@test.com"', {
            cwd: repoDir,
          });
          await execAsync('git config user.name "Agent"', { cwd: repoDir });
          await execAsync('git commit -m "RALPH: pi agent commit"', {
            cwd: repoDir,
          });
          return "Done with iteration.";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: piTestProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(1);
    const content = await readFile(join(hostDir, "pi-output.txt"), "utf-8");
    expect(content).toBe("pi was here");
  });

  it("stops early on completion signal with pi provider", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-pi-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockPiAgentLayer(dir, async () => {
          return "All done. <promise>COMPLETE</promise>";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: piTestProvider,
        hostRepoDir: hostDir,

        iterations: 5,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(1);
    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
  });

  it("buffers small pi text deltas into larger display chunks", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-pi-buf-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Build a mock that streams many tiny text_delta events (one per word),
    // mimicking Pi's real streaming behavior.
    const words = [
      "Hello",
      " ",
      "world",
      ".",
      " ",
      "This",
      " ",
      "is",
      " ",
      "a",
      " ",
      "test",
      ".\n",
    ];
    const agentResult = "Hello world. This is a test.";
    const streamLines: string[] = [];
    for (const word of words) {
      streamLines.push(
        JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: word },
        }),
      );
    }
    streamLines.push(
      JSON.stringify({
        type: "agent_end",
        messages: [
          { role: "assistant", content: [{ type: "text", text: agentResult }] },
        ],
      }),
    );

    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = Layer.merge(
      SilentDisplay.layer(ref),
      noopAgentStreamEmitterLayer,
    );

    const fsLayer = makeLocalSandboxLayer(hostDir);
    const mockLayer = Layer.succeed(Sandbox, {
      exec: (command, options) => {
        if (command.startsWith("pi ") && options?.onLine) {
          const onLine = options.onLine;
          return Effect.sync(() => {
            for (const line of streamLines) {
              onLine(line);
            }
            return { stdout: streamLines.join("\n"), stderr: "", exitCode: 0 };
          });
        }
        return Effect.flatMap(Sandbox, (real) =>
          real.exec(command, options),
        ).pipe(Effect.provide(fsLayer));
      },
      copyIn: (hostPath, sandboxPath) =>
        Effect.flatMap(Sandbox, (real) =>
          real.copyIn(hostPath, sandboxPath),
        ).pipe(Effect.provide(fsLayer)),
      copyFileOut: (sandboxPath, hostPath) =>
        Effect.flatMap(Sandbox, (real) =>
          real.copyFileOut(sandboxPath, hostPath),
        ).pipe(Effect.provide(fsLayer)),
    });

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      () => mockLayer,
    );

    await Effect.runPromise(
      orchestrate({
        provider: piTestProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "do some work",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(factoryLayer, displayLayer, defaultSessionPathsLayer),
        ),
      ),
    );

    const entries = await Effect.runPromise(Ref.get(ref));
    const textEntries = entries.filter(
      (e): e is DisplayEntry & { _tag: "text" } => e._tag === "text",
    );

    // 13 individual text_delta events were streamed, but buffering should
    // produce far fewer display entries. The exact count depends on heuristics
    // (sentence boundary, newline, length threshold), but it must be less than 13.
    expect(textEntries.length).toBeLessThan(words.length);
    expect(textEntries.length).toBeGreaterThan(0);

    // All text must be preserved — concatenation of display entries equals original
    const displayedText = textEntries.map((e) => e.message).join("");
    expect(displayedText).toBe(words.join(""));
  });

  it("flushes buffered text before tool call display", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-pi-tool-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Stream text deltas followed by a tool_execution_start
    const streamLines = [
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "thinking" },
      }),
      JSON.stringify({
        type: "tool_execution_start",
        toolName: "Bash",
        args: { command: "ls" },
      }),
      JSON.stringify({
        type: "agent_end",
        messages: [
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ],
      }),
    ];

    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = Layer.merge(
      SilentDisplay.layer(ref),
      noopAgentStreamEmitterLayer,
    );

    const fsLayer = makeLocalSandboxLayer(hostDir);
    const mockLayer = Layer.succeed(Sandbox, {
      exec: (command, options) => {
        if (command.startsWith("pi ") && options?.onLine) {
          const onLine = options.onLine;
          return Effect.sync(() => {
            for (const line of streamLines) {
              onLine(line);
            }
            return { stdout: streamLines.join("\n"), stderr: "", exitCode: 0 };
          });
        }
        return Effect.flatMap(Sandbox, (real) =>
          real.exec(command, options),
        ).pipe(Effect.provide(fsLayer));
      },
      copyIn: (hostPath, sandboxPath) =>
        Effect.flatMap(Sandbox, (real) =>
          real.copyIn(hostPath, sandboxPath),
        ).pipe(Effect.provide(fsLayer)),
      copyFileOut: (sandboxPath, hostPath) =>
        Effect.flatMap(Sandbox, (real) =>
          real.copyFileOut(sandboxPath, hostPath),
        ).pipe(Effect.provide(fsLayer)),
    });

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      () => mockLayer,
    );

    await Effect.runPromise(
      orchestrate({
        provider: piTestProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "do some work",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(factoryLayer, displayLayer, defaultSessionPathsLayer),
        ),
      ),
    );

    const entries = await Effect.runPromise(Ref.get(ref));

    // Find the text and toolCall entries
    const relevantEntries = entries.filter(
      (e) => e._tag === "text" || e._tag === "toolCall",
    );

    // Text "thinking" must appear BEFORE the tool call
    const textIdx = relevantEntries.findIndex(
      (e) => e._tag === "text" && e.message === "thinking",
    );
    const toolIdx = relevantEntries.findIndex((e) => e._tag === "toolCall");
    expect(textIdx).toBeGreaterThanOrEqual(0);
    expect(toolIdx).toBeGreaterThan(textIdx);
  });
});

// ---------------------------------------------------------------------------
// Codex provider integration tests
// ---------------------------------------------------------------------------

const codexTestProvider = codexFactory("gpt-5.4-mini");

/** Format a mock agent result as Codex JSON stream lines */
const toCodexStreamJson = (output: string): string => {
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: output },
    }),
  );
  return lines.join("\n");
};

/**
 * Create a mock sandbox layer that intercepts `codex` commands
 * and runs a mock script instead.
 */
const makeMockCodexAgentLayer = (
  sandboxDir: string,
  mockAgentBehavior: (sandboxRepoDir: string) => Promise<string>,
): Layer.Layer<Sandbox> => {
  const fsLayer = makeLocalSandboxLayer(sandboxDir);

  return Layer.succeed(Sandbox, {
    exec: (command, options) => {
      if (command.startsWith("codex ")) {
        if (options?.onLine) {
          const onLine = options.onLine;
          return Effect.gen(function* () {
            const cwd = options?.cwd ?? sandboxDir;
            const output = yield* Effect.promise(() => mockAgentBehavior(cwd));
            const streamOutput = toCodexStreamJson(output);
            for (const line of streamOutput.split("\n")) {
              onLine(line);
            }
            return { stdout: streamOutput, stderr: "", exitCode: 0 };
          });
        }
        return Effect.gen(function* () {
          const cwd = options?.cwd ?? sandboxDir;
          const output = yield* Effect.promise(() => mockAgentBehavior(cwd));
          return { stdout: output, stderr: "", exitCode: 0 };
        });
      }
      return Effect.flatMap(Sandbox, (real) =>
        real.exec(command, options),
      ).pipe(Effect.provide(fsLayer));
    },
    copyIn: (hostPath, sandboxPath) =>
      Effect.flatMap(Sandbox, (real) =>
        real.copyIn(hostPath, sandboxPath),
      ).pipe(Effect.provide(fsLayer)),
    copyFileOut: (sandboxPath, hostPath) =>
      Effect.flatMap(Sandbox, (real) =>
        real.copyFileOut(sandboxPath, hostPath),
      ).pipe(Effect.provide(fsLayer)),
  });
};

describe("Orchestrator with codex provider", () => {
  it("runs a single iteration with codex provider and produces a commit", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-codex-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockCodexAgentLayer(dir, async (repoDir) => {
          await writeFile(join(repoDir, "codex-output.txt"), "codex was here");
          await execAsync("git add -A", { cwd: repoDir });
          await execAsync('git config user.email "agent@test.com"', {
            cwd: repoDir,
          });
          await execAsync('git config user.name "Agent"', { cwd: repoDir });
          await execAsync('git commit -m "RALPH: codex agent commit"', {
            cwd: repoDir,
          });
          return "Done with iteration.";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: codexTestProvider,
        hostRepoDir: hostDir,

        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(1);
    const content = await readFile(join(hostDir, "codex-output.txt"), "utf-8");
    expect(content).toBe("codex was here");
  });

  it("stops early on completion signal with codex provider", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-codex-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockCodexAgentLayer(dir, async () => {
          return "All done. <promise>COMPLETE</promise>";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: codexTestProvider,
        hostRepoDir: hostDir,

        iterations: 5,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(1);
    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
  });
});

describe("Session capture integration", () => {
  /**
   * Create a test factory that provides a bindMountHandle with copyFileIn/copyFileOut
   * backed by the filesystem. This allows session capture to work through the
   * sandboxSessionStore → transferSession → hostSessionStore path.
   */
  const makeSessionCaptureFactory = (
    hostRepoDir: string,
    mockAgentBehavior: (sandboxRepoDir: string) => Promise<string>,
    sessionId: string,
  ): { factoryLayer: Layer.Layer<SandboxFactory> } => {
    const sandboxBaseDir = join(tmpdir(), `orch-session-${randomUUID()}`);
    let branchCounter = 0;

    const factoryLayer = Layer.succeed(SandboxFactory, {
      withSandbox: <A, E, R>(
        makeEffect: (
          info: import("./SandboxFactory.js").SandboxInfo,
        ) => Effect.Effect<A, E, R | Sandbox>,
      ): Effect.Effect<
        import("./SandboxFactory.js").WithSandboxResult<A>,
        E | DockerError,
        Exclude<R, Sandbox>
      > =>
        Effect.acquireUseRelease(
          Effect.promise(async () => {
            await rm(sandboxBaseDir, { recursive: true, force: true });
            const branchName = `sandcastle/test-${++branchCounter}`;
            await execAsync(
              `git worktree add -b "${branchName}" "${sandboxBaseDir}" HEAD`,
              { cwd: hostRepoDir },
            );
            return branchName;
          }),
          (_branchName) => {
            // Create a bind-mount handle backed by filesystem copy
            const handle: BindMountSandboxHandle = {
              worktreePath: sandboxBaseDir,
              exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
              copyFileIn: async (hostPath, sandboxPath) => {
                await mkdir(join(sandboxPath, ".."), { recursive: true });
                await copyFile(hostPath, sandboxPath);
              },
              copyFileOut: async (sandboxPath, hostPath) => {
                await mkdir(join(hostPath, ".."), { recursive: true });
                await copyFile(sandboxPath, hostPath);
              },
              close: async () => {},
            };

            // Build a sandbox layer that intercepts claude commands
            const fsLayer = makeLocalSandboxLayer(sandboxBaseDir);
            const sandboxLayer = Layer.succeed(Sandbox, {
              exec: (command, options) => {
                if (command.startsWith("claude ") && options?.onLine) {
                  const onLine = options.onLine;
                  return Effect.gen(function* () {
                    const cwd = options?.cwd ?? sandboxBaseDir;
                    const output = yield* Effect.promise(() =>
                      mockAgentBehavior(cwd),
                    );
                    const streamOutput = toStreamJson(output, sessionId);
                    for (const line of streamOutput.split("\n")) {
                      onLine(line);
                    }
                    return { stdout: streamOutput, stderr: "", exitCode: 0 };
                  });
                }
                return Effect.flatMap(Sandbox, (real) =>
                  real.exec(command, options),
                ).pipe(Effect.provide(fsLayer));
              },
              copyIn: (hostPath, sandboxPath) =>
                Effect.flatMap(Sandbox, (real) =>
                  real.copyIn(hostPath, sandboxPath),
                ).pipe(Effect.provide(fsLayer)),
              copyFileOut: (sandboxPath, hostPath) =>
                Effect.flatMap(Sandbox, (real) =>
                  real.copyFileOut(sandboxPath, hostPath),
                ).pipe(Effect.provide(fsLayer)),
            });

            return makeEffect({
              hostWorktreePath: sandboxBaseDir,
              sandboxRepoPath: sandboxBaseDir,
              applyToHost: () => Effect.void,
              bindMountHandle: handle,
            }).pipe(Effect.provide(sandboxLayer)) as Effect.Effect<
              A,
              E | DockerError,
              Exclude<R, Sandbox>
            >;
          },
          (_branchName) =>
            Effect.promise(async () => {
              try {
                await execAsync(
                  `git worktree remove "${sandboxBaseDir}" --force`,
                  { cwd: hostRepoDir },
                ).catch(() => {});
              } catch {}
            }),
        ).pipe(
          Effect.map((value) => ({ value, preservedWorktreePath: undefined })),
        ),
    });

    return { factoryLayer };
  };

  it("captures session JSONL to host and populates sessionFilePath", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-capture-host-"));
    const hostProjectsDir = await mkdtemp(
      join(tmpdir(), "orch-capture-projects-"),
    );
    const sandboxProjectsDir = await mkdtemp(
      join(tmpdir(), "orch-capture-sb-projects-"),
    );
    const mockSessionId = "test-session-abc-123";

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const { factoryLayer } = makeSessionCaptureFactory(
      hostDir,
      async (repoDir) => {
        // Write a session JSONL file into the sandbox's session store location
        const encoded = encodeProjectPath(repoDir);
        const sessionsDir = join(sandboxProjectsDir, encoded);
        // Since our sandbox IS the filesystem, write the session file at the
        // expected sandbox path (the handle's copyFileOut will just do a fs copy)
        await mkdir(sessionsDir, { recursive: true });
        await writeFile(
          join(sessionsDir, `${mockSessionId}.jsonl`),
          // Use sandbox cwd (repoDir) — transferSession should rewrite to host cwd
          [
            JSON.stringify({ type: "system", cwd: repoDir }),
            JSON.stringify({ type: "message", cwd: repoDir, text: "hello" }),
          ].join("\n"),
        );
        return "Done. <promise>COMPLETE</promise>";
      },
      mockSessionId,
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do some work",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            factoryLayer,
            testDisplayLayer,
            sessionPathsLayer({ hostProjectsDir, sandboxProjectsDir }),
          ),
        ),
      ),
    );

    // Verify iteration result
    expect(result.iterations.length).toBe(1);
    expect(result.iterations[0]!.sessionId).toBe(mockSessionId);
    expect(result.iterations[0]!.sessionFilePath).toBeDefined();

    // Verify the captured file exists on the host
    const capturedPath = result.iterations[0]!.sessionFilePath!;
    const capturedContent = await readFile(capturedPath, "utf-8");
    const lines = capturedContent.split("\n");

    // Verify cwd was rewritten from sandbox cwd to host cwd
    const firstEntry = JSON.parse(lines[0]!) as { cwd: string };
    expect(firstEntry.cwd).toBe(hostDir);
    const secondEntry = JSON.parse(lines[1]!) as { cwd: string; text: string };
    expect(secondEntry.cwd).toBe(hostDir);
    expect(secondEntry.text).toBe("hello");
  });

  it("skips capture for non-Claude agents (captureSessions: false)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-nocapture-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Use claudeCode with captureSessions: false to test the flag
    // (Using claudeCode so the mock agent layer intercepts correctly)
    const provider = claudeCode("test-model", { captureSessions: false });

    const { factoryLayer } = makeTestSandboxFactory(hostDir, (dir) =>
      makeMockAgentLayer(dir, async () => {
        return "Done.";
      }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(1);
    expect(result.iterations[0]!.sessionFilePath).toBeUndefined();
  });

  it("skips capture when no sessionId is extracted", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-nosession-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Use default factory (no bindMountHandle, no session_id in stream)
    const { factoryLayer } = makeTestSandboxFactory(hostDir, (dir) =>
      makeMockAgentLayer(dir, async () => {
        return "Done.";
      }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(1);
    expect(result.iterations[0]!.sessionId).toBeUndefined();
    expect(result.iterations[0]!.sessionFilePath).toBeUndefined();
  });

  it("resumes a session: transfers JSONL to sandbox and passes --resume to agent", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-resume-host-"));
    const hostProjectsDir = await mkdtemp(
      join(tmpdir(), "orch-resume-projects-"),
    );
    const sandboxProjectsDir = await mkdtemp(
      join(tmpdir(), "orch-resume-sb-projects-"),
    );
    const mockSessionId = "resume-session-xyz";

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Write a session JSONL on the host (simulating a prior capture)
    const encoded = encodeProjectPath(hostDir);
    const hostSessionsDir = join(hostProjectsDir, encoded);
    await mkdir(hostSessionsDir, { recursive: true });
    await writeFile(
      join(hostSessionsDir, `${mockSessionId}.jsonl`),
      [
        JSON.stringify({ type: "system", cwd: hostDir }),
        JSON.stringify({ type: "message", cwd: hostDir, text: "prior work" }),
      ].join("\n"),
    );

    const { factoryLayer } = makeSessionCaptureFactory(
      hostDir,
      async (repoDir) => {
        // Verify that the session JSONL was transferred into the sandbox
        const sbEncoded = encodeProjectPath(repoDir);
        const sbSessionPath = join(
          sandboxProjectsDir,
          sbEncoded,
          `${mockSessionId}.jsonl`,
        );
        const content = await readFile(sbSessionPath, "utf-8");
        const lines = content.split("\n");
        // Verify cwd was rewritten from host to sandbox
        const firstEntry = JSON.parse(lines[0]!) as { cwd: string };
        expect(firstEntry.cwd).toBe(repoDir);

        // Also write the new session file the agent would produce
        const sessionsDir = join(sandboxProjectsDir, sbEncoded);
        await mkdir(sessionsDir, { recursive: true });
        await writeFile(
          join(sessionsDir, `${mockSessionId}.jsonl`),
          [
            JSON.stringify({ type: "system", cwd: repoDir }),
            JSON.stringify({
              type: "message",
              cwd: repoDir,
              text: "continued work",
            }),
          ].join("\n"),
        );

        return "Done. <promise>COMPLETE</promise>";
      },
      mockSessionId,
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "continue working",
        resumeSession: mockSessionId,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            factoryLayer,
            testDisplayLayer,
            sessionPathsLayer({ hostProjectsDir, sandboxProjectsDir }),
          ),
        ),
      ),
    );

    // Verify iteration result
    expect(result.iterations.length).toBe(1);
    expect(result.iterations[0]!.sessionId).toBe(mockSessionId);
    expect(result.iterations[0]!.sessionFilePath).toBeDefined();

    // Verify the captured file on host has rewritten cwd
    const capturedPath = result.iterations[0]!.sessionFilePath!;
    const capturedContent = await readFile(capturedPath, "utf-8");
    const capturedLines = capturedContent.split("\n");
    const entry = JSON.parse(capturedLines[0]!) as { cwd: string };
    expect(entry.cwd).toBe(hostDir);
  });

  it("populates usage on IterationResult when session has assistant usage", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-usage-host-"));
    const hostProjectsDir = await mkdtemp(
      join(tmpdir(), "orch-usage-projects-"),
    );
    const sandboxProjectsDir = await mkdtemp(
      join(tmpdir(), "orch-usage-sb-projects-"),
    );
    const mockSessionId = "usage-session-123";

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const { factoryLayer } = makeSessionCaptureFactory(
      hostDir,
      async (repoDir) => {
        const encoded = encodeProjectPath(repoDir);
        const sessionsDir = join(sandboxProjectsDir, encoded);
        await mkdir(sessionsDir, { recursive: true });
        await writeFile(
          join(sessionsDir, `${mockSessionId}.jsonl`),
          [
            JSON.stringify({
              type: "system",
              subtype: "init",
              session_id: mockSessionId,
            }),
            JSON.stringify({
              type: "assistant",
              message: {
                model: "claude-opus-4-7",
                usage: {
                  input_tokens: 3,
                  cache_creation_input_tokens: 9294,
                  cache_read_input_tokens: 8526,
                  output_tokens: 458,
                },
              },
            }),
          ].join("\n"),
        );
        return "Done. <promise>COMPLETE</promise>";
      },
      mockSessionId,
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do some work",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            factoryLayer,
            testDisplayLayer,
            sessionPathsLayer({ hostProjectsDir, sandboxProjectsDir }),
          ),
        ),
      ),
    );

    expect(result.iterations[0]!.usage).toEqual({
      inputTokens: 3,
      cacheCreationInputTokens: 9294,
      cacheReadInputTokens: 8526,
      outputTokens: 458,
    });
  });

  it("usage is undefined when captureSessions is false", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-nousage-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const provider = claudeCode("test-model", { captureSessions: false });

    const { factoryLayer } = makeTestSandboxFactory(hostDir, (dir) =>
      makeMockAgentLayer(dir, async () => {
        return "Done.";
      }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations[0]!.usage).toBeUndefined();
  });
});

describe("Orchestrator signal (AbortSignal)", () => {
  it("rejects with pre-aborted signal before running any iteration", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let agentCalled = false;
    const { factoryLayer } = makeTestSandboxFactory(hostDir, (dir) =>
      makeMockAgentLayer(dir, async () => {
        agentCalled = true;
        return "Done.";
      }),
    );

    const ac = new AbortController();
    ac.abort("pre-aborted");

    await expect(
      Effect.runPromise(
        orchestrate({
          provider: testProvider,
          hostRepoDir: hostDir,
          iterations: 1,
          prompt: "do some work",
          signal: ac.signal,
        }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
      ),
    ).rejects.toThrow("pre-aborted");

    expect(agentCalled).toBe(false);
  });

  it("aborts mid-iteration and rejects", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const ac = new AbortController();

    // Mock agent that takes a while — abort fires while it's running
    const { factoryLayer } = makeTestSandboxFactory(hostDir, (dir) =>
      makeMockAgentLayer(dir, async () => {
        // Simulate slow agent: abort mid-flight
        ac.abort("cancelled mid-iteration");
        // Give the abort a tick to propagate
        await new Promise((r) => setTimeout(r, 10));
        return "Done.";
      }),
    );

    await expect(
      Effect.runPromise(
        orchestrate({
          provider: testProvider,
          hostRepoDir: hostDir,
          iterations: 1,
          prompt: "do some work",
          signal: ac.signal,
        }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
      ),
    ).rejects.toThrow("cancelled mid-iteration");
  });

  it("aborts between iterations and does not start the next one", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const ac = new AbortController();
    let iterationCount = 0;

    const { factoryLayer } = makeTestSandboxFactory(hostDir, (dir) =>
      makeMockAgentLayer(dir, async () => {
        iterationCount++;
        if (iterationCount === 1) {
          // After first iteration completes, abort before second starts
          ac.abort("cancelled between iterations");
        }
        return `Iteration ${iterationCount} done.`;
      }),
    );

    await expect(
      Effect.runPromise(
        orchestrate({
          provider: testProvider,
          hostRepoDir: hostDir,
          iterations: 5,
          prompt: "do some work",
          signal: ac.signal,
        }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
      ),
    ).rejects.toThrow("cancelled between iterations");

    expect(iterationCount).toBe(1);
  });

  it("abort after completion is a no-op", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const ac = new AbortController();

    const { factoryLayer } = makeTestSandboxFactory(hostDir, (dir) =>
      makeMockAgentLayer(dir, async () => {
        return "All done. <promise>COMPLETE</promise>";
      }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do some work",
        signal: ac.signal,
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    // Abort after completion — should not throw or affect result
    ac.abort("too late");

    expect(result.iterations.length).toBe(1);
    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
  });

  it("works normally when no signal is provided", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const { factoryLayer } = makeTestSandboxFactory(hostDir, (dir) =>
      makeMockAgentLayer(dir, async () => {
        return "Done. <promise>COMPLETE</promise>";
      }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        provider: testProvider,
        hostRepoDir: hostDir,
        iterations: 1,
        prompt: "do some work",
        // no signal
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterations.length).toBe(1);
    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
  });
});
