import { Cause, Effect, Layer, Ref } from "effect";
import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { Display, type DisplayEntry, SilentDisplay } from "./Display.js";
import { makeLocalSandboxLayer } from "./testSandbox.js";
import { DEFAULT_MODEL, orchestrate } from "./Orchestrator.js";
import { piProvider, codexProvider } from "./AgentProvider.js";
import { Sandbox } from "./SandboxFactory.js";
import type { DockerError, SandboxError } from "./errors.js";
import { TimeoutError } from "./errors.js";
import { SandboxFactory } from "./SandboxFactory.js";

const execAsync = promisify(exec);

const testDisplayLayer = SilentDisplay.layer(
  Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]),
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
const toStreamJson = (output: string): string => {
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: output }] },
    }),
  );
  lines.push(JSON.stringify({ type: "result", result: output }));
  return lines.join("\n");
};

/** Format a mock agent result as pi JSON mode lines */
const toPiStreamJson = (output: string): string => {
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: "message_update",
      message: {},
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

/** Format a mock agent result as Codex JSONL lines */
const toCodexStreamJson = (output: string): string => {
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: output },
    }),
  );
  lines.push(
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 },
    }),
  );
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
 * @returns The factory layer and the sandboxRepoDir path to pass to orchestrate
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
          makeEffect({ hostWorktreePath: sandboxBaseDir }).pipe(
            Effect.provide(buildLayer(sandboxBaseDir)),
          ) as Effect.Effect<A, E | DockerError, Exclude<R, Sandbox>>,
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
 * Create a mock sandbox layer that intercepts agent commands matching `commandPrefix`
 * and runs a mock script instead. All other commands pass through to the filesystem sandbox.
 */
const makeMockAgentLayerFor = (
  commandPrefix: string,
  toStream: (output: string) => string,
  sandboxDir: string,
  mockAgentBehavior: (sandboxRepoDir: string) => Promise<string>,
): Layer.Layer<Sandbox> => {
  const fsLayer = makeLocalSandboxLayer(sandboxDir);

  return Layer.succeed(Sandbox, {
    exec: (command, options) => {
      if (command.startsWith(commandPrefix)) {
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
    execStreaming: (command, onStdoutLine, options) => {
      if (command.startsWith(commandPrefix)) {
        return Effect.gen(function* () {
          const cwd = options?.cwd ?? sandboxDir;
          const output = yield* Effect.promise(() => mockAgentBehavior(cwd));
          const streamOutput = toStream(output);
          for (const line of streamOutput.split("\n")) {
            onStdoutLine(line);
          }
          return { stdout: streamOutput, stderr: "", exitCode: 0 };
        });
      }
      return Effect.flatMap(Sandbox, (real) =>
        real.execStreaming(command, onStdoutLine, options),
      ).pipe(Effect.provide(fsLayer));
    },
    copyIn: (hostPath, sandboxPath) =>
      Effect.flatMap(Sandbox, (real) =>
        real.copyIn(hostPath, sandboxPath),
      ).pipe(Effect.provide(fsLayer)),
    copyOut: (sandboxPath, hostPath) =>
      Effect.flatMap(Sandbox, (real) =>
        real.copyOut(sandboxPath, hostPath),
      ).pipe(Effect.provide(fsLayer)),
  });
};

/** Create a mock layer that intercepts `claude` commands (Claude Code provider) */
const makeMockAgentLayer = (
  sandboxDir: string,
  mockAgentBehavior: (sandboxRepoDir: string) => Promise<string>,
): Layer.Layer<Sandbox> =>
  makeMockAgentLayerFor("claude ", toStreamJson, sandboxDir, mockAgentBehavior);

/** Create a mock layer that intercepts `pi` commands (pi provider) */
const makeMockPiAgentLayer = (
  sandboxDir: string,
  mockAgentBehavior: (sandboxRepoDir: string) => Promise<string>,
): Layer.Layer<Sandbox> =>
  makeMockAgentLayerFor("pi ", toPiStreamJson, sandboxDir, mockAgentBehavior);

/** Create a mock layer that intercepts `codex` commands (Codex provider) */
const makeMockCodexAgentLayer = (
  sandboxDir: string,
  mockAgentBehavior: (sandboxRepoDir: string) => Promise<string>,
): Layer.Layer<Sandbox> =>
  makeMockAgentLayerFor(
    "codex ",
    toCodexStreamJson,
    sandboxDir,
    mockAgentBehavior,
  );

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
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 1,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterationsRun).toBe(1);
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
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 5,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterationsRun).toBe(1);
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
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 5,
        prompt: "do some work",
        completionSignal: "TASK_FINISHED",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterationsRun).toBe(1);
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
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 2,
        prompt: "do some work",
        completionSignal: "TASK_FINISHED",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    // Custom signal not in output, so all iterations run
    expect(result.iterationsRun).toBe(2);
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
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 5,
        prompt: "do some work",
        completionSignal: ["TASK_FINISHED", "TASK_ABORTED"],
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterationsRun).toBe(1);
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
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 5,
        prompt: "do some work",
        completionSignal: ["TASK_FINISHED", "TASK_ABORTED"],
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterationsRun).toBe(1);
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
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 2,
        prompt: "do some work",
        completionSignal: ["TASK_FINISHED", "TASK_ABORTED"],
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterationsRun).toBe(2);
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
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 5,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterationsRun).toBe(3);
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
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 2,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterationsRun).toBe(2);
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
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 3,

        prompt: "test isolation",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterationsRun).toBe(2);
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
        hostRepoDir: hostDir,
        sandboxRepoDir,
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
        hostRepoDir: hostDir,
        sandboxRepoDir,
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
        hostRepoDir: hostDir,
        sandboxRepoDir,
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
        hostRepoDir: hostDir,
        sandboxRepoDir,
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
});

// Stream parsing unit tests live in AgentProvider.test.ts
// (they are part of the AgentProvider contract).

describe("Orchestrator with pi provider", () => {
  it("runs a single iteration using piProvider", async () => {
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
          await execAsync('git commit -m "pi: agent commit"', {
            cwd: repoDir,
          });
          return "Done with iteration.";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 1,
        prompt: "do some work",
        agentProvider: piProvider,
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterationsRun).toBe(1);

    // Verify the agent's commit was synced back to host
    const content = await readFile(join(hostDir, "pi-output.txt"), "utf-8");
    expect(content).toBe("pi was here");
  });

  it("stops early on completion signal with piProvider", async () => {
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
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 5,
        prompt: "do some work",
        agentProvider: piProvider,
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterationsRun).toBe(1);
    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
  });

  it("uses piProvider default model when no model specified", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-pi-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockPiAgentLayer(dir, async () => {
          return "Done.";
        }),
    );

    // Should not throw — piProvider.defaultModel is used as fallback
    const result = await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 1,
        prompt: "do some work",
        agentProvider: piProvider,
        // model intentionally omitted
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterationsRun).toBe(1);
  });
});

describe("Orchestrator with codex provider", () => {
  it("runs a single iteration using codexProvider", async () => {
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
          await execAsync('git commit -m "codex: agent commit"', {
            cwd: repoDir,
          });
          return "Done with iteration.";
        }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 1,
        prompt: "do some work",
        agentProvider: codexProvider,
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterationsRun).toBe(1);

    const content = await readFile(join(hostDir, "codex-output.txt"), "utf-8");
    expect(content).toBe("codex was here");
  });

  it("stops early on completion signal with codexProvider", async () => {
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
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 5,
        prompt: "do some work",
        agentProvider: codexProvider,
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterationsRun).toBe(1);
    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
  });
});

describe("Orchestrator tool call display integration", () => {
  it("emits toolCall display entries for allowlisted tools in stream", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-toolcall-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = SilentDisplay.layer(ref);

    const mockLayer = makeTestSandboxFactory(hostDir, (dir) => {
      const fsLayer = makeLocalSandboxLayer(dir);
      return Layer.succeed(Sandbox, {
        exec: (command, options) =>
          Effect.flatMap(Sandbox, (real) => real.exec(command, options)).pipe(
            Effect.provide(fsLayer),
          ),
        execStreaming: (command, onStdoutLine, options) => {
          if (command.startsWith("claude ")) {
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
            for (const line of lines) onStdoutLine(line);
            return Effect.succeed({
              stdout: lines.join("\n"),
              stderr: "",
              exitCode: 0,
            });
          }
          return Effect.flatMap(Sandbox, (real) =>
            real.execStreaming(command, onStdoutLine, options),
          ).pipe(Effect.provide(fsLayer));
        },
        copyIn: (hostPath, sandboxPath) =>
          Effect.flatMap(Sandbox, (real) =>
            real.copyIn(hostPath, sandboxPath),
          ).pipe(Effect.provide(fsLayer)),
        copyOut: (sandboxPath, hostPath) =>
          Effect.flatMap(Sandbox, (real) =>
            real.copyOut(sandboxPath, hostPath),
          ).pipe(Effect.provide(fsLayer)),
      });
    });

    await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir: mockLayer.sandboxRepoDir,
        iterations: 1,
        prompt: "do some work",
      }).pipe(
        Effect.provide(Layer.merge(mockLayer.factoryLayer, displayLayer)),
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
          exec: (command, options) =>
            Effect.flatMap(Sandbox, (real) => real.exec(command, options)).pipe(
              Effect.provide(fsLayer),
            ),
          execStreaming: (command, onStdoutLine, options) => {
            if (command.startsWith("claude ")) {
              return Effect.succeed({
                stdout: "",
                stderr: "Agent crashed",
                exitCode: 1,
              });
            }
            return Effect.flatMap(Sandbox, (real) =>
              real.execStreaming(command, onStdoutLine, options),
            ).pipe(Effect.provide(fsLayer));
          },
          copyIn: (hostPath, sandboxPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyIn(hostPath, sandboxPath),
            ).pipe(Effect.provide(fsLayer)),
          copyOut: (sandboxPath, hostPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyOut(sandboxPath, hostPath),
            ).pipe(Effect.provide(fsLayer)),
        });
      },
    );

    const exit = await Effect.runPromiseExit(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
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
          exec: (command, options) =>
            Effect.flatMap(Sandbox, (real) => real.exec(command, options)).pipe(
              Effect.provide(fsLayer),
            ),
          execStreaming: (command, onStdoutLine, options) => {
            if (command.startsWith("claude ")) {
              // Only emit an assistant line, no result line
              const assistantLine = JSON.stringify({
                type: "assistant",
                message: { content: [{ type: "text", text: "working..." }] },
              });
              onStdoutLine(assistantLine);
              return Effect.succeed({
                stdout: "All done. <promise>COMPLETE</promise>",
                stderr: "",
                exitCode: 0,
              });
            }
            return Effect.flatMap(Sandbox, (real) =>
              real.execStreaming(command, onStdoutLine, options),
            ).pipe(Effect.provide(fsLayer));
          },
          copyIn: (hostPath, sandboxPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyIn(hostPath, sandboxPath),
            ).pipe(Effect.provide(fsLayer)),
          copyOut: (sandboxPath, hostPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyOut(sandboxPath, hostPath),
            ).pipe(Effect.provide(fsLayer)),
        });
      },
    );

    const result = await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 5,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    // Should detect COMPLETE from the stdout fallback
    expect(result.iterationsRun).toBe(1);
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
          exec: (command, options) =>
            Effect.flatMap(Sandbox, (real) => real.exec(command, options)).pipe(
              Effect.provide(fsLayer),
            ),
          execStreaming: (command, onStdoutLine, options) => {
            if (command.startsWith("claude ")) {
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
                    onStdoutLine(line);
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
              real.execStreaming(command, onStdoutLine, options),
            ).pipe(Effect.provide(fsLayer));
          },
          copyIn: (hostPath, sandboxPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyIn(hostPath, sandboxPath),
            ).pipe(Effect.provide(fsLayer)),
          copyOut: (sandboxPath, hostPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyOut(sandboxPath, hostPath),
            ).pipe(Effect.provide(fsLayer)),
        });
      },
    );

    const exit = await Effect.runPromiseExit(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
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
        hostRepoDir: "/nonexistent/repo",
        sandboxRepoDir,
        iterations: 1,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(exit._tag).toBe("Failure");
  });

  it("propagates error when getSandboxHead fails (empty repo)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-nohead-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Layer that sabotages HEAD resolution by making git rev-parse HEAD always fail
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const fsLayer = makeLocalSandboxLayer(dir);
        return Layer.succeed(Sandbox, {
          exec: (command, options) => {
            if (command === "git rev-parse HEAD") {
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
          execStreaming: (command, onStdoutLine, options) =>
            Effect.flatMap(Sandbox, (real) =>
              real.execStreaming(command, onStdoutLine, options),
            ).pipe(Effect.provide(fsLayer)),
          copyIn: (hostPath, sandboxPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyIn(hostPath, sandboxPath),
            ).pipe(Effect.provide(fsLayer)),
          copyOut: (sandboxPath, hostPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyOut(sandboxPath, hostPath),
            ).pipe(Effect.provide(fsLayer)),
        });
      },
    );

    const exit = await Effect.runPromiseExit(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 1,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(exit._tag).toBe("Failure");
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
          exec: (command, options) =>
            Effect.flatMap(Sandbox, (real) => real.exec(command, options)).pipe(
              Effect.provide(fsLayer),
            ),
          execStreaming: (command, onStdoutLine, options) => {
            if (command.startsWith("claude ")) {
              capturedCommand = command;
              const output = "Test output";
              const streamOutput = toStreamJson(output);
              for (const line of streamOutput.split("\n")) {
                onStdoutLine(line);
              }
              return Effect.succeed({
                stdout: streamOutput,
                stderr: "",
                exitCode: 0,
              });
            }
            return Effect.flatMap(Sandbox, (real) =>
              real.execStreaming(command, onStdoutLine, options),
            ).pipe(Effect.provide(fsLayer));
          },
          copyIn: (hostPath, sandboxPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyIn(hostPath, sandboxPath),
            ).pipe(Effect.provide(fsLayer)),
          copyOut: (sandboxPath, hostPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyOut(sandboxPath, hostPath),
            ).pipe(Effect.provide(fsLayer)),
        });
      },
    );

    await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
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
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 5,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterationsRun).toBe(1);
    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
  });

  it("uses DEFAULT_MODEL when no model is specified", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-defmodel-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let capturedCommand = "";

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const fsLayer = makeLocalSandboxLayer(dir);
        return Layer.succeed(Sandbox, {
          exec: (command, options) =>
            Effect.flatMap(Sandbox, (real) => real.exec(command, options)).pipe(
              Effect.provide(fsLayer),
            ),
          execStreaming: (command, onStdoutLine, options) => {
            if (command.startsWith("claude ")) {
              capturedCommand = command;
              const output = "Done.";
              const streamOutput = toStreamJson(output);
              for (const line of streamOutput.split("\n")) {
                onStdoutLine(line);
              }
              return Effect.succeed({
                stdout: streamOutput,
                stderr: "",
                exitCode: 0,
              });
            }
            return Effect.flatMap(Sandbox, (real) =>
              real.execStreaming(command, onStdoutLine, options),
            ).pipe(Effect.provide(fsLayer));
          },
          copyIn: (hostPath, sandboxPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyIn(hostPath, sandboxPath),
            ).pipe(Effect.provide(fsLayer)),
          copyOut: (sandboxPath, hostPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyOut(sandboxPath, hostPath),
            ).pipe(Effect.provide(fsLayer)),
        });
      },
    );

    await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(capturedCommand).toContain(`--model '${DEFAULT_MODEL}'`);
  });

  it("uses custom model when specified in options", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-custmodel-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let capturedCommand = "";

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const fsLayer = makeLocalSandboxLayer(dir);
        return Layer.succeed(Sandbox, {
          exec: (command, options) =>
            Effect.flatMap(Sandbox, (real) => real.exec(command, options)).pipe(
              Effect.provide(fsLayer),
            ),
          execStreaming: (command, onStdoutLine, options) => {
            if (command.startsWith("claude ")) {
              capturedCommand = command;
              const output = "Done.";
              const streamOutput = toStreamJson(output);
              for (const line of streamOutput.split("\n")) {
                onStdoutLine(line);
              }
              return Effect.succeed({
                stdout: streamOutput,
                stderr: "",
                exitCode: 0,
              });
            }
            return Effect.flatMap(Sandbox, (real) =>
              real.execStreaming(command, onStdoutLine, options),
            ).pipe(Effect.provide(fsLayer));
          },
          copyIn: (hostPath, sandboxPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyIn(hostPath, sandboxPath),
            ).pipe(Effect.provide(fsLayer)),
          copyOut: (sandboxPath, hostPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyOut(sandboxPath, hostPath),
            ).pipe(Effect.provide(fsLayer)),
        });
      },
    );

    await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 1,
        prompt: "do some work",
        model: "claude-sonnet-4-6",
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

    let capturedPrompt = "";

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const fsLayer = makeLocalSandboxLayer(dir);
        return Layer.succeed(Sandbox, {
          exec: (command, options) =>
            Effect.flatMap(Sandbox, (real) => real.exec(command, options)).pipe(
              Effect.provide(fsLayer),
            ),
          execStreaming: (command, onStdoutLine, options) => {
            if (command.startsWith("claude ")) {
              // Capture the prompt passed to claude
              capturedPrompt = command;
              const output = "Done.";
              const streamOutput = toStreamJson(output);
              for (const line of streamOutput.split("\n")) {
                onStdoutLine(line);
              }
              return Effect.succeed({
                stdout: streamOutput,
                stderr: "",
                exitCode: 0,
              });
            }
            return Effect.flatMap(Sandbox, (real) =>
              real.execStreaming(command, onStdoutLine, options),
            ).pipe(Effect.provide(fsLayer));
          },
          copyIn: (hostPath, sandboxPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyIn(hostPath, sandboxPath),
            ).pipe(Effect.provide(fsLayer)),
          copyOut: (sandboxPath, hostPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyOut(sandboxPath, hostPath),
            ).pipe(Effect.provide(fsLayer)),
        });
      },
    );

    await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 1,
        prompt: "Context: !`echo hello-from-sandbox`\n\nDo the work.",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    // The prompt should have !`echo hello-from-sandbox` replaced with "hello-from-sandbox"
    expect(capturedPrompt).toContain("hello-from-sandbox");
    expect(capturedPrompt).not.toContain("!`echo");
  });

  it("passes prompt through unchanged when no !`command` expressions", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-nopreproc-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let capturedPrompt = "";

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "Done.";
        }),
    );

    // Intercept to capture prompt — use the simpler mock that captures command
    const { factoryLayer: fl2, sandboxRepoDir: sr2 } = makeTestSandboxFactory(
      hostDir,
      (dir) => {
        const fsLayer = makeLocalSandboxLayer(dir);
        return Layer.succeed(Sandbox, {
          exec: (command, options) =>
            Effect.flatMap(Sandbox, (real) => real.exec(command, options)).pipe(
              Effect.provide(fsLayer),
            ),
          execStreaming: (command, onStdoutLine, options) => {
            if (command.startsWith("claude ")) {
              capturedPrompt = command;
              const output = "Done.";
              const streamOutput = toStreamJson(output);
              for (const line of streamOutput.split("\n")) {
                onStdoutLine(line);
              }
              return Effect.succeed({
                stdout: streamOutput,
                stderr: "",
                exitCode: 0,
              });
            }
            return Effect.flatMap(Sandbox, (real) =>
              real.execStreaming(command, onStdoutLine, options),
            ).pipe(Effect.provide(fsLayer));
          },
          copyIn: (hostPath, sandboxPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyIn(hostPath, sandboxPath),
            ).pipe(Effect.provide(fsLayer)),
          copyOut: (sandboxPath, hostPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyOut(sandboxPath, hostPath),
            ).pipe(Effect.provide(fsLayer)),
        });
      },
    );

    await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir: sr2,
        iterations: 1,
        prompt: "Just a plain prompt with no commands.",
      }).pipe(Effect.provide(Layer.merge(fl2, testDisplayLayer))),
    );

    expect(capturedPrompt).toContain("Just a plain prompt with no commands.");
  });
});

describe("Orchestrator Display integration", () => {
  it("emits iteration header, spinner, usage summary, and completion status", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-display-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = SilentDisplay.layer(ref);

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "All done. <promise>COMPLETE</promise>";
        }),
    );

    // Override toStreamJson to include usage data
    const mockLayer = makeTestSandboxFactory(hostDir, (dir) => {
      const fsLayer = makeLocalSandboxLayer(dir);
      return Layer.succeed(Sandbox, {
        exec: (command, options) =>
          Effect.flatMap(Sandbox, (real) => real.exec(command, options)).pipe(
            Effect.provide(fsLayer),
          ),
        execStreaming: (command, onStdoutLine, options) => {
          if (command.startsWith("claude ")) {
            const output = "All done. <promise>COMPLETE</promise>";
            const lines = [
              JSON.stringify({
                type: "assistant",
                message: { content: [{ type: "text", text: output }] },
              }),
              JSON.stringify({
                type: "result",
                result: output,
                total_cost_usd: 0.14,
                num_turns: 3,
                duration_ms: 12000,
                usage: {
                  input_tokens: 52340,
                  output_tokens: 3201,
                  cache_read_input_tokens: 10000,
                  cache_creation_input_tokens: 5000,
                },
              }),
            ];
            for (const line of lines) {
              onStdoutLine(line);
            }
            return Effect.succeed({
              stdout: lines.join("\n"),
              stderr: "",
              exitCode: 0,
            });
          }
          return Effect.flatMap(Sandbox, (real) =>
            real.execStreaming(command, onStdoutLine, options),
          ).pipe(Effect.provide(fsLayer));
        },
        copyIn: (hostPath, sandboxPath) =>
          Effect.flatMap(Sandbox, (real) =>
            real.copyIn(hostPath, sandboxPath),
          ).pipe(Effect.provide(fsLayer)),
        copyOut: (sandboxPath, hostPath) =>
          Effect.flatMap(Sandbox, (real) =>
            real.copyOut(sandboxPath, hostPath),
          ).pipe(Effect.provide(fsLayer)),
      });
    });

    await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir: mockLayer.sandboxRepoDir,
        iterations: 5,
        prompt: "do some work",
      }).pipe(
        Effect.provide(Layer.merge(mockLayer.factoryLayer, displayLayer)),
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

    // Usage summary
    const summaryEntries = entries.filter((e) => e._tag === "summary");
    expect(summaryEntries.length).toBeGreaterThanOrEqual(1);
    const usageSummary = summaryEntries[0] as {
      _tag: "summary";
      title: string;
      rows: Record<string, string>;
    };
    expect(usageSummary.rows).toHaveProperty("Tokens");
    expect(usageSummary.rows).not.toHaveProperty("Cost");
    expect(usageSummary.rows).not.toHaveProperty("Context");

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
    const displayLayer = SilentDisplay.layer(ref);

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
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 2,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, displayLayer))),
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

  it("uses 5 minutes as the default idle timeout", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-timeout-default-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) => makeMockAgentLayer(dir, async () => "done"),
    );

    // Verify indirectly: a run that completes quickly should not time out.
    // The default idle timeout is 300s (5 minutes) — far longer than any mock agent delay.
    const exitResult = await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 1,
        prompt: "test",
        // No idleTimeoutSeconds — should default to 5 minutes (300s)
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
    const displayLayer = SilentDisplay.layer(ref);

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "All done. <promise>COMPLETE</promise>";
        }),
    );

    await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 1,
        prompt: "do some work",
        name: "issue-42",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, displayLayer))),
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
    const displayLayer = SilentDisplay.layer(ref);

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory(
      hostDir,
      (dir) =>
        makeMockAgentLayer(dir, async () => {
          return "All done. <promise>COMPLETE</promise>";
        }),
    );

    await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, displayLayer))),
    );

    const entries = await Effect.runPromise(Ref.get(ref));
    const statusEntries = entries.filter((e) => e._tag === "status");

    // No status messages should be prefixed with brackets
    expect(statusEntries.every((e) => !e.message.startsWith("["))).toBe(true);
  });

  it("fails with TimeoutError when idleTimeoutSeconds is exceeded with no output", async () => {
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
        hostRepoDir: hostDir,
        sandboxRepoDir,
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
      expect(err).toBeInstanceOf(TimeoutError);
      if (err instanceof TimeoutError) {
        expect(err.idleTimeoutSeconds).toBe(0.1);
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
          exec: (command, options) =>
            Effect.flatMap(Sandbox, (real) => real.exec(command, options)).pipe(
              Effect.provide(fsLayer),
            ),
          execStreaming: (command, onStdoutLine, options) => {
            if (command.startsWith("claude ")) {
              return Effect.gen(function* () {
                // Wait 100ms then emit a text event (resets idle timer)
                yield* Effect.promise(
                  () => new Promise((resolve) => setTimeout(resolve, 100)),
                );
                onStdoutLine(
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
                onStdoutLine(
                  JSON.stringify({ type: "result", result: "done" }),
                );
                return { stdout: "", stderr: "", exitCode: 0 };
              });
            }
            return Effect.flatMap(Sandbox, (real) =>
              real.execStreaming(command, onStdoutLine, options),
            ).pipe(Effect.provide(fsLayer));
          },
          copyIn: (hostPath, sandboxPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyIn(hostPath, sandboxPath),
            ).pipe(Effect.provide(fsLayer)),
          copyOut: (sandboxPath, hostPath) =>
            Effect.flatMap(Sandbox, (real) =>
              real.copyOut(sandboxPath, hostPath),
            ).pipe(Effect.provide(fsLayer)),
        });
      },
    );

    const exitResult = await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
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
});
