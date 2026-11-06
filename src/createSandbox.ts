import { NodeContext, NodeFileSystem } from "@effect/platform-node";
import { join } from "node:path";
import { Effect, Layer, Ref } from "effect";
import { shellEscape } from "./AgentProvider.js";
import type { AgentProvider } from "./AgentProvider.js";
import {
  ClackDisplay,
  Display,
  FileDisplay,
  SilentDisplay,
} from "./Display.js";
import type { DisplayEntry } from "./Display.js";
import { resolveEnv } from "./EnvResolver.js";
import { mergeProviderEnv } from "./mergeProviderEnv.js";
import { orchestrate } from "./Orchestrator.js";
import type { IterationResult } from "./Orchestrator.js";
import { agentStreamEmitterLayer } from "./AgentStreamEmitter.js";
import type { PromptArgs } from "./PromptArgumentSubstitution.js";
import { resolveSandboxPrompt } from "./resolveSandboxPrompt.js";
import { preprocessPrompt } from "./PromptPreprocessor.js";
import type { LoggingOption, Timeouts } from "./run.js";
import {
  buildAgentStreamHandler,
  buildCompletionMessage,
  buildContextWindowLines,
  buildLogFilename,
  printFileDisplayStartup,
} from "./run.js";
import { withSandboxLifecycle, runHostHooks } from "./SandboxLifecycle.js";
import type { SyncError, SyncOutPathError } from "./errors.js";
import type { SandboxHooks } from "./SandboxLifecycle.js";
import {
  reuseSandboxFactoryLayer,
  SANDBOX_REPO_DIR,
  resolveGitMounts,
} from "./SandboxFactory.js";
import type { MountEntry, SandboxService } from "./SandboxFactory.js";
import type {
  SandboxProvider,
  BindMountSandboxHandle,
  BindMountSandboxProvider,
  IsolatedSandboxHandle,
  NoSandboxHandle,
  MergeToHeadBranchStrategy,
  NamedBranchStrategy,
  ExecResult,
} from "./SandboxProvider.js";
import { execOk } from "./sandboxSetup.js";
import { startSandbox } from "./startSandbox.js";
import { syncOut } from "./syncOut.js";
import * as WorktreeManager from "./WorktreeManager.js";
import { copyToWorktree } from "./CopyToWorktree.js";
import { resolveCwd } from "./resolveCwd.js";
import { patchGitMountsForWindows, removeMountTempDirs } from "./mountUtils.js";
import {
  assertForkSupported,
  assertResumeSessionExists,
} from "./resumePrecheck.js";
import { registerShutdown } from "./shutdownRegistry.js";
import { assertInteractiveSupported } from "./nativeSandboxProvider.js";
import { raceAbortSignal } from "./raceAbortSignal.js";
import { validateTimeoutOptions } from "./validateTimeouts.js";

export interface CreateSandboxOptions {
  /** Explicit branch for the worktree (required). */
  readonly branch: string;
  /**
   * Ref to fork from when `branch` does not yet exist. Ignored when the branch
   * already exists. Defaults to `HEAD`.
   */
  readonly baseBranch?: string;
  /** Sandbox provider (e.g. docker({ imageName: "sandcastle:myrepo" })). */
  readonly sandbox: SandboxProvider;
  /**
   * Host repo directory. Replaces `process.cwd()` as the anchor for
   * `.sandcastle/worktrees/`, `.sandcastle/.env`, and git operations.
   *
   * - Relative paths are resolved against `process.cwd()`.
   * - Absolute paths are used as-is.
   * - Defaults to `process.cwd()` when omitted.
   */
  readonly cwd?: string;
  /** Lifecycle hooks grouped by execution location (host or sandbox). */
  readonly hooks?: SandboxHooks;
  /** Paths relative to the host repo root to copy into the worktree at creation time. */
  readonly copyToWorktree?: string[];
  /** Override default timeouts for built-in lifecycle steps. Unset keys keep their defaults. */
  readonly timeouts?: Timeouts;
  /** @internal Test-only overrides to bypass the sandbox provider. */
  readonly _test?: {
    readonly buildSandbox?: (sandboxDir: string) => SandboxService;
    /**
     * Fake bind-mount handle exposed to the orchestrator's session-capture path.
     * Only honored when `sandbox.tag === "bind-mount"`. Used to exercise the
     * `bindMountHandle` flow in tests without booting a real container.
     */
    readonly bindMountHandle?: BindMountSandboxHandle;
  };
}

/**
 * Options accepted by `SandboxRunResult.resume()` / `.fork()`. Mirrors
 * `ResumeRunResultOptions` in `run.ts` — drops the fields owned by the
 * captured run (prompt, iteration count, resumeSession/forkSession bookkeeping).
 *
 * Defined as the base interface that `SandboxRunOptions` extends — the
 * interface-extends shape is cheaper for the TS checker than
 * `Omit<SandboxRunOptions, ...>` (which forces a mapped-type computation
 * on every reference).
 */
export interface ResumeSandboxRunResultOptions {
  /** Key-value map for {{KEY}} placeholder substitution in prompts. */
  readonly promptArgs?: PromptArgs;
  /** Substring(s) the agent emits to stop the iteration loop early. */
  readonly completionSignal?: string | string[];
  /** Idle timeout in seconds. Default: 600. */
  readonly idleTimeoutSeconds?: number;
  /** Grace window in seconds after a completion signal is observed but the agent process has not exited. See ADR 0019. Default: 60. */
  readonly completionTimeoutSeconds?: number;
  /** Display name for this run. */
  readonly name?: string;
  /** Logging mode. */
  readonly logging?: LoggingOption;
  /**
   * An `AbortSignal` that cancels the run when aborted.
   *
   * - Pre-aborted signal rejects immediately without setup.
   * - Mid-iteration abort kills the in-flight agent subprocess.
   * - The rejected promise surfaces `signal.reason` verbatim.
   * - The `Sandbox` handle remains usable after abort — call `.run()` again
   *   with a fresh signal, or `.close()` to tear down.
   */
  readonly signal?: AbortSignal;
}

export interface SandboxRunOptions extends ResumeSandboxRunResultOptions {
  /** Agent provider to use (e.g. claudeCode("claude-opus-4-8")). */
  readonly agent: AgentProvider;
  /** Inline prompt string (mutually exclusive with promptFile). */
  readonly prompt?: string;
  /** Path to a prompt file (mutually exclusive with prompt). */
  readonly promptFile?: string;
  /** Maximum iterations to run (default: 1). */
  readonly maxIterations?: number;
  /** Resume a prior agent session by id. The session JSONL must exist on the host (captured by a prior `sandbox.run()`). Incompatible with `maxIterations > 1`. */
  readonly resumeSession?: string;
  /**
   * When true alongside `resumeSession`, fork the session instead of mutating
   * it. The parent session JSONL is left intact and the agent writes a new
   * session under a fresh id. Exposed as the public `.fork()` method on
   * `SandboxRunResult` rather than as a stand-alone caller option — see
   * ADR 0018.
   *
   * @internal
   */
  readonly forkSession?: boolean;
}

export interface SandboxRunResult {
  /** Per-iteration results (use `iterations.length` for the count). */
  readonly iterations: IterationResult[];
  /** The matched completion signal string, or undefined if none fired. */
  readonly completionSignal?: string;
  /** Combined stdout output from all agent iterations. */
  readonly stdout: string;
  /** List of commits made by the agent during the run. */
  readonly commits: { sha: string }[];
  /** Path to the log file, if logging was drained to a file. */
  readonly logFilePath?: string;
  /**
   * Continue the last captured agent session for exactly one iteration inside
   * the same long-lived sandbox. Present only when the provider supports
   * resume (`sessionStorage` populated) and a session id was captured.
   */
  readonly resume?: (
    prompt: string,
    options?: ResumeSandboxRunResultOptions,
  ) => Promise<SandboxRunResult>;
  /**
   * Fork the last captured agent session for exactly one iteration inside the
   * same long-lived sandbox: the parent session JSONL is left intact and the
   * child run gets its own session id. Present only when the provider
   * supports resume (`sessionStorage` populated) and a session id was
   * captured. See ADR 0018 for fork semantics.
   */
  readonly fork?: (
    prompt: string,
    options?: ResumeSandboxRunResultOptions,
  ) => Promise<SandboxRunResult>;
}

export interface SandboxInteractiveOptions {
  /** Agent provider to use (e.g. claudeCode("claude-opus-4-8")). */
  readonly agent: AgentProvider;
  /** Inline prompt string (mutually exclusive with promptFile). */
  readonly prompt?: string;
  /** Path to a prompt file (mutually exclusive with prompt). */
  readonly promptFile?: string;
  /** Key-value map for {{KEY}} placeholder substitution in prompts. */
  readonly promptArgs?: PromptArgs;
  /** Display name for this interactive session. */
  readonly name?: string;
  /**
   * An `AbortSignal` that cancels the interactive session when aborted.
   *
   * - Pre-aborted signal rejects immediately without setup.
   * - The rejected promise surfaces `signal.reason` verbatim.
   * - The `Sandbox` handle remains usable after abort.
   */
  readonly signal?: AbortSignal;
}

export interface SandboxInteractiveResult {
  /** List of commits made during the interactive session. */
  readonly commits: { sha: string }[];
  /** Exit code of the interactive process. */
  readonly exitCode: number;
}

export interface CloseResult {
  /** Host path to the preserved worktree, set when the worktree had uncommitted changes. */
  readonly preservedWorktreePath?: string;
}

export interface Sandbox {
  /** The branch the worktree is on. */
  readonly branch: string;
  /** Host path to the worktree. */
  readonly worktreePath: string;
  /**
   * The provider's id for this sandbox, for a supervisor outside this process
   * (a run registry, a kill step for stuck runs) to address it with the
   * provider's own tools:
   *
   * - `docker()`: the container name: `docker inspect <sandboxId>`,
   *   `docker rm -f <sandboxId>`.
   * - `podman()`: the container name: `podman inspect <sandboxId>`,
   *   `podman rm -f <sandboxId>`.
   * - `vercel()`: the Vercel sandbox's id (its `name` from `@vercel/sandbox`
   *   2 on, its `sandboxId` in 1.x): pass it to the SDK's `Sandbox.get()`,
   *   then call `stop()`.
   * - `daytona()`: the Daytona sandbox id: `daytona.get(<sandboxId>)`, then
   *   `delete()`, from `@daytona/sdk`.
   * - `modal()`: the Modal sandbox id: `modal.sandboxes.fromId(<sandboxId>)`,
   *   then `terminate()`, from `modal`.
   * - `sprites()`: the Sprite's name: `client.getSprite(<sandboxId>)`, then
   *   `delete()`, from `@fly/sprites`.
   * - A custom provider: whatever its handle's `sandboxId` is.
   *
   * `undefined` for `noSandbox()` and the native `bwrap()` and `seatbelt()`
   * sandboxes: their sandbox is a child process of this one, with nothing
   * outside it to address.
   */
  readonly sandboxId?: string;
  /** Invoke an agent inside the existing sandbox. */
  run(options: SandboxRunOptions): Promise<SandboxRunResult>;
  /** Launch an interactive agent session inside the existing sandbox. */
  interactive(
    options: SandboxInteractiveOptions,
  ): Promise<SandboxInteractiveResult>;
  /**
   * Execute a command inside the existing sandbox.
   *
   * `cwd` defaults to the sandbox repo path (same default `interactive()`
   * uses), so callers get the same working directory across providers. Pass
   * `cwd` to override.
   *
   * Returns the full `ExecResult` — non-zero `exitCode` is surfaced, not
   * thrown. Callers that want strict semantics should check `result.exitCode`
   * themselves (matching the contract of `BindMountSandboxHandle.exec`).
   */
  exec(command: string, options?: SandboxExecOptions): Promise<ExecResult>;
  /** Tear down the sandbox and worktree. */
  close(): Promise<CloseResult>;
  /** Auto teardown via `await using`. */
  [Symbol.asyncDispose](): Promise<void>;
}

/** Options accepted by `Sandbox.exec()`. Mirrors the provider handle's `exec` options. */
export interface SandboxExecOptions {
  /** Per-line stdout callback for streaming output. */
  readonly onLine?: (line: string) => void;
  /** Working directory for the command. Defaults to the sandbox repo path. */
  readonly cwd?: string;
  /** Run the whole command as root, when the provider supports it. */
  readonly sudo?: boolean;
  /** Stdin payload — piped to the child process and then closed. Avoids the Linux 128 KB per-arg limit. */
  readonly stdin?: string;
}

/** @internal Context for building Sandbox handle methods. */
interface SandboxHandleContext {
  readonly branch: string;
  readonly worktreePath: string;
  readonly hostRepoDir: string;
  readonly sandboxRepoDir: string;
  readonly sandbox: SandboxService;
  readonly providerHandle:
    | BindMountSandboxHandle
    | IsolatedSandboxHandle
    | NoSandboxHandle
    | undefined;
  /**
   * Pre-narrowed bind-mount handle, set when the provider is a bind-mount
   * provider. Required by the orchestrator's session capture path
   * (`AgentSessionStorage.captureToHost/resumeIntoSandbox`), which is typed
   * on `BindMountSandboxHandle` and calls `copyFileOut`/`copyFileIn` —
   * methods that no-sandbox and isolated handles do not implement.
   */
  readonly bindMountHandle: BindMountSandboxHandle | undefined;
  /** Provider tag, used by resumeSession to dispatch the host-side session lookup. */
  readonly providerTag: SandboxProvider["tag"];
  /** The sandbox provider, checked before an interactive session starts. */
  readonly sandboxProvider: SandboxProvider;
  /** The sandbox provider's env, checked against each run's agent env for overlapping keys. */
  readonly sandboxProviderEnv: Record<string, string>;
  readonly applyToHost: () => Effect.Effect<void, SyncError | SyncOutPathError>;
  readonly timeouts?: Timeouts;
  /** Worktree branch strategy. Set only when the handle is backed by a
   *  `createWorktree(...)` handle; absent for top-level `createSandbox()`,
   *  which is always explicit-branch. When `type === "merge-to-head"`, each
   *  run()/interactive() routes through the lifecycle's merge step and the
   *  worktree's source branch is preserved across calls. */
  readonly branchStrategy?: MergeToHeadBranchStrategy | NamedBranchStrategy;
}

/**
 * @internal Applies an agent provider's `env` to its print command.
 *
 * `run()` merges the agent's env into the container env at start. A
 * long-lived sandbox (`createSandbox()`, `worktree.createSandbox()`) is
 * started before any agent is chosen, and each `sandbox.run()` may use a
 * different agent, so the env is exported in the agent's own shell instead.
 * It reaches only that run's agent process, with the same precedence as
 * `run()` (agent env overrides `.sandcastle/.env`) and the same rejection of
 * keys that overlap the sandbox provider's env.
 */
const withAgentEnv = (
  agent: AgentProvider,
  sandboxProviderEnv: Record<string, string>,
): AgentProvider => {
  const entries = Object.entries(agent.env);
  if (entries.length === 0) {
    return agent;
  }
  mergeProviderEnv({
    resolvedEnv: {},
    agentProviderEnv: agent.env,
    sandboxProviderEnv,
  });
  const invalid = entries
    .map(([key]) => key)
    .filter((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key));
  if (invalid.length > 0) {
    throw new Error(
      `Invalid agent provider env key(s): ${invalid.join(", ")}. Keys must match [A-Za-z_][A-Za-z0-9_]*.`,
    );
  }
  const exports = entries
    .map(([key, value]) => `export ${key}=${shellEscape(value)}; `)
    .join("");
  return {
    ...agent,
    buildPrintCommand: (options) => {
      const printCommand = agent.buildPrintCommand(options);
      return { ...printCommand, command: exports + printCommand.command };
    },
  };
};

/**
 * @internal Rejects run options that can't work before any setup happens:
 * bad timeouts, `resumeSession` with more than one iteration, `forkSession`
 * without `resumeSession` or on an agent that can't fork, and a
 * `resumeSession` whose file is missing on the host.
 */
const assertRunOptionsValid = async (
  runOptions: SandboxRunOptions,
  provider: AgentProvider,
  ctx: SandboxHandleContext,
): Promise<void> => {
  validateTimeoutOptions(runOptions);

  const isResuming =
    runOptions.resumeSession !== undefined && runOptions.resumeSession !== "";

  // Validate: resumeSession + maxIterations > 1 is not allowed.
  if (isResuming && (runOptions.maxIterations ?? 1) > 1) {
    throw new Error(
      "resumeSession cannot be combined with maxIterations > 1. " +
        "Resume applies to iteration 1 only; multi-iteration resume semantics are not supported.",
    );
  }

  // Validate: forkSession only makes sense alongside resumeSession.
  if (runOptions.forkSession === true && !isResuming) {
    throw new Error(
      "forkSession requires resumeSession. " +
        "Use sandboxRunResult.fork(prompt) to fork the most recent captured session.",
    );
  }
  if (runOptions.forkSession === true) {
    assertForkSupported(provider);
  }

  // Validate: resumeSession file must exist on the host before launching.
  if (isResuming) {
    await assertResumeSessionExists({
      provider,
      sandboxTag: ctx.providerTag,
      hostRepoDir: ctx.hostRepoDir,
      resumeSession: runOptions.resumeSession,
    });
  }
};

/** @internal A run's logging option; defaults to a file under `.sandcastle/logs/`. */
const resolveRunLogging = (
  runOptions: SandboxRunOptions,
  hostRepoDir: string,
  branch: string,
): LoggingOption =>
  runOptions.logging ?? {
    type: "file",
    path: join(
      hostRepoDir,
      ".sandcastle",
      "logs",
      buildLogFilename(branch, undefined, runOptions.name),
    ),
  };

/**
 * @internal The display for a run: file logging prints the startup banner
 * and writes to the log file; stdout logging renders to the terminal, as
 * run() does.
 */
const buildRunDisplayLayer = (
  logging: LoggingOption,
  banner: { readonly agentName: string | undefined; readonly branch: string },
): Layer.Layer<Display> => {
  if (logging.type !== "file") {
    return ClackDisplay.layer;
  }
  printFileDisplayStartup({ logPath: logging.path, ...banner });
  return Layer.provide(FileDisplay.layer(logging.path), NodeFileSystem.layer);
};

/**
 * @internal Adds `.resume()` / `.fork()` to a run result, only when the
 * agent supports session capture and the last iteration captured a session
 * id. Both re-enter the same long-lived sandbox through `rerun`, which
 * repeats the original run's options with the given overrides, so the
 * container and worktree stay warm.
 */
const withResumeAndFork = (
  baseResult: SandboxRunResult,
  provider: AgentProvider,
  rerun: (overrides: Partial<SandboxRunOptions>) => Promise<SandboxRunResult>,
): SandboxRunResult => {
  const lastIteration = baseResult.iterations.at(-1);
  if (
    !provider.sessionStorage ||
    lastIteration?.sessionId === undefined ||
    lastIteration.sessionId === ""
  ) {
    return baseResult;
  }
  const capturedSessionId = lastIteration.sessionId;
  return {
    ...baseResult,
    resume: async (
      nextPrompt: string,
      resumeOptions?: ResumeSandboxRunResultOptions,
    ): Promise<SandboxRunResult> =>
      rerun({
        // The follow-up prompt is inline: drop the template's arguments.
        promptArgs: undefined,
        ...resumeOptions,
        prompt: nextPrompt,
        promptFile: undefined,
        maxIterations: 1,
        resumeSession: capturedSessionId,
      }),
    fork: async (
      nextPrompt: string,
      forkOptions?: ResumeSandboxRunResultOptions,
    ): Promise<SandboxRunResult> =>
      rerun({
        // The follow-up prompt is inline: drop the template's arguments.
        promptArgs: undefined,
        ...forkOptions,
        prompt: nextPrompt,
        promptFile: undefined,
        maxIterations: 1,
        resumeSession: capturedSessionId,
        forkSession: true,
      }),
  };
};

/**
 * @internal Builds a Sandbox handle with run() and interactive() methods.
 * The close callback controls teardown behavior — top-level createSandbox()
 * cleans up both container and worktree, while worktree-backed sandboxes
 * only tear down the container.
 */
const buildSandboxHandle = (
  ctx: SandboxHandleContext,
  close: () => Promise<CloseResult>,
): Sandbox => {
  const {
    branch,
    worktreePath,
    hostRepoDir,
    sandboxRepoDir,
    sandbox,
    providerHandle,
    bindMountHandle,
    applyToHost,
    timeouts,
    branchStrategy,
  } = ctx;
  // Routing for the lifecycle: in merge-to-head mode pass `branch: undefined`
  // (so the lifecycle records host's current branch and merges back) and keep
  // the worktree's source branch alive for subsequent calls. In all other
  // cases (top-level createSandbox, named-branch worktree) forward `branch`
  // as-is and let the lifecycle delete the temp branch normally.
  const mergeToHead = branchStrategy?.type === "merge-to-head";

  const sandboxHandle: Sandbox = {
    branch,
    worktreePath,
    sandboxId:
      providerHandle !== undefined && "sandboxId" in providerHandle
        ? providerHandle.sandboxId
        : undefined,

    run: async (runOptions: SandboxRunOptions): Promise<SandboxRunResult> => {
      // If signal is already aborted, reject immediately without any setup
      runOptions.signal?.throwIfAborted();

      const { prompt, promptFile, maxIterations = 1 } = runOptions;
      // The container was started before this agent was chosen, so the
      // agent's env is applied to its own process instead (see withAgentEnv).
      const provider = withAgentEnv(runOptions.agent, ctx.sandboxProviderEnv);

      await assertRunOptionsValid(runOptions, provider, ctx);

      const displayRef = Ref.unsafeMake<readonly DisplayEntry[]>([]);
      const silentDisplayLayer = SilentDisplay.layer(displayRef);

      const resolvedPrompt = await Effect.runPromise(
        resolveSandboxPrompt({
          prompt,
          promptFile,
          promptArgs: runOptions.promptArgs,
          branch,
          hostRepoDir,
        }).pipe(
          Effect.provide(Layer.mergeAll(NodeContext.layer, silentDisplayLayer)),
        ),
      );

      const resolvedLogging = resolveRunLogging(
        runOptions,
        hostRepoDir,
        branch,
      );

      const runDisplayLayer = buildRunDisplayLayer(resolvedLogging, {
        agentName: runOptions.name,
        branch,
      });

      const reuseFactoryLayer = reuseSandboxFactoryLayer(
        {
          hostWorktreePath: worktreePath,
          sandboxRepoPath: sandboxRepoDir,
          applyToHost,
          bindMountHandle,
        },
        sandbox,
      );

      const streamEmitterLayer = agentStreamEmitterLayer(
        buildAgentStreamHandler(resolvedLogging),
      );

      const runLayer = Layer.mergeAll(
        reuseFactoryLayer,
        runDisplayLayer,
        streamEmitterLayer,
      );

      let result;
      try {
        result = await Effect.runPromise(
          Effect.gen(function* () {
            const display = yield* Display;
            yield* display.intro(runOptions.name ?? "sandcastle");

            const orchestrateResult = yield* orchestrate({
              hostRepoDir,
              iterations: maxIterations,
              prompt: resolvedPrompt.text,
              branch: mergeToHead ? undefined : branch,
              provider,
              completionSignal: runOptions.completionSignal,
              idleTimeoutSeconds: runOptions.idleTimeoutSeconds,
              completionTimeoutSeconds: runOptions.completionTimeoutSeconds,
              name: runOptions.name,
              resumeSession: runOptions.resumeSession,
              forkSession: runOptions.forkSession,
              signal: runOptions.signal,
              skipPromptExpansion: resolvedPrompt.isInline,
              timeouts,
              keepSourceBranch: mergeToHead,
            });

            const completion = buildCompletionMessage(
              orchestrateResult.completionSignal,
              orchestrateResult.iterations.length,
            );
            yield* display.status(completion.message, completion.severity);

            for (const line of buildContextWindowLines(
              orchestrateResult.iterations,
            )) {
              yield* display.text(line);
            }

            return orchestrateResult;
          }).pipe(Effect.provide(runLayer)),
        );
      } catch (error: unknown) {
        // If the signal was aborted, surface its reason verbatim
        runOptions.signal?.throwIfAborted();
        throw error;
      }

      return withResumeAndFork(
        {
          iterations: result.iterations,
          completionSignal: result.completionSignal,
          stdout: result.stdout,
          commits: result.commits,
          logFilePath:
            resolvedLogging.type === "file" ? resolvedLogging.path : undefined,
        },
        provider,
        async (overrides) => sandboxHandle.run({ ...runOptions, ...overrides }),
      );
    },

    interactive: async (
      interactiveOptions: SandboxInteractiveOptions,
    ): Promise<SandboxInteractiveResult> => {
      // If signal is already aborted, reject immediately without any setup
      interactiveOptions.signal?.throwIfAborted();
      assertInteractiveSupported(ctx.sandboxProvider);

      const { agent: provider, prompt, promptFile } = interactiveOptions;

      const buildInteractiveArgs =
        provider.buildInteractiveArgs?.bind(provider);
      if (!buildInteractiveArgs) {
        throw new Error(
          `Agent provider "${provider.name}" does not support buildInteractiveArgs, required for interactive sessions.`,
        );
      }

      if (!providerHandle?.interactiveExec) {
        throw new Error(
          `Sandbox provider does not support interactiveExec. ` +
            `The provider must implement the optional interactiveExec method to use interactive().`,
        );
      }
      const interactiveExecFn =
        providerHandle.interactiveExec.bind(providerHandle);

      let lifecycleResult;
      try {
        lifecycleResult = await Effect.runPromise(
          Effect.gen(function* () {
            const resolvedPrompt = yield* resolveSandboxPrompt({
              prompt,
              promptFile,
              promptArgs: interactiveOptions.promptArgs,
              branch,
              hostRepoDir,
            });

            return yield* withSandboxLifecycle(
              {
                hostRepoDir,
                sandboxRepoDir,
                branch: mergeToHead ? undefined : branch,
                hostWorktreePath: worktreePath,
                applyToHost,
                timeouts,
                keepSourceBranch: mergeToHead,
              },
              sandbox,
              (ctx) =>
                Effect.gen(function* () {
                  const fullPrompt = resolvedPrompt.isInline
                    ? resolvedPrompt.text
                    : yield* preprocessPrompt(
                        resolvedPrompt.text,
                        ctx.sandbox,
                        ctx.sandboxRepoDir,
                      );

                  const interactiveArgs = buildInteractiveArgs({
                    prompt: fullPrompt,
                    dangerouslySkipPermissions: true,
                  });
                  const execPromise = interactiveExecFn(interactiveArgs, {
                    stdin: process.stdin,
                    stdout: process.stdout,
                    stderr: process.stderr,
                    cwd: sandboxRepoDir,
                  });

                  const result = yield* raceAbortSignal(
                    Effect.promise(() => execPromise),
                    interactiveOptions.signal,
                  );

                  return result.exitCode;
                }),
            );
          }).pipe(
            Effect.provide(
              Layer.mergeAll(ClackDisplay.layer, NodeContext.layer),
            ),
          ),
        );
      } catch (error: unknown) {
        // If the signal was aborted, surface its reason verbatim
        interactiveOptions.signal?.throwIfAborted();
        throw error;
      }

      return {
        commits: lifecycleResult.commits,
        exitCode: lifecycleResult.result,
      };
    },

    exec: async (
      command: string,
      options?: SandboxExecOptions,
    ): Promise<ExecResult> => {
      const mergedOptions = { cwd: sandboxRepoDir, ...options };
      if (providerHandle) {
        return providerHandle.exec(command, mergedOptions);
      }
      // Test-mode fallback: no providerHandle, only the Effect SandboxService.
      return Effect.runPromise(sandbox.exec(command, mergedOptions));
    },

    close: async (): Promise<CloseResult> => close(),

    [Symbol.asyncDispose]: async (): Promise<void> => {
      await sandboxHandle.close();
    },
  };

  return sandboxHandle;
};

/** @internal Options for createSandboxFromWorktree — used by worktree.createSandbox(). */
export interface CreateSandboxFromWorktreeOptions {
  readonly branch: string;
  readonly worktreePath: string;
  readonly hostRepoDir: string;
  readonly sandbox: SandboxProvider;
  readonly hooks?: SandboxHooks;
  readonly copyToWorktree?: string[];
  readonly timeouts?: Timeouts;
  /** Forwarded to the Sandbox handle. Set by `createWorktree` so the handle
   *  can route run()/interactive() correctly: for `merge-to-head`, each call
   *  merges back to the host's current branch and the worktree's source
   *  branch is preserved; for `branch`, the lifecycle is driven as
   *  explicit-branch mode. Absent for top-level `createSandbox()`. */
  readonly branchStrategy?: MergeToHeadBranchStrategy | NamedBranchStrategy;
  readonly _test?: {
    readonly buildSandbox?: (sandboxDir: string) => SandboxService;
    /**
     * Fake bind-mount handle exposed to the orchestrator's session-capture path.
     * Only honored when `sandbox.tag === "bind-mount"`.
     */
    readonly bindMountHandle?: BindMountSandboxHandle;
  };
}

type ProviderHandle =
  | BindMountSandboxHandle
  | IsolatedSandboxHandle
  | NoSandboxHandle;

interface StartProviderSandboxOptions {
  readonly provider: SandboxProvider;
  readonly hostRepoDir: string;
  readonly worktreePath: string;
  readonly env: Record<string, string>;
  readonly copyToWorktree: string[] | undefined;
  /** Temp dirs behind the git mounts get pushed here, for the caller to remove. */
  readonly mountsToClean: MountEntry[];
}

/**
 * Starts a bind-mount provider's sandbox on `worktreePath`, after resolving
 * the host repo's git mounts and patching them for Windows.
 */
const startBindMountWithGitMounts = (
  provider: BindMountSandboxProvider,
  {
    hostRepoDir,
    worktreePath,
    env,
    mountsToClean,
  }: StartProviderSandboxOptions,
) =>
  resolveGitMounts(join(hostRepoDir, ".git")).pipe(
    Effect.provide(NodeFileSystem.layer),
    Effect.catchAll(() => Effect.succeed([])),
    // Patch git mounts for Windows worktree compatibility (ADR-0006)
    Effect.flatMap((gitMounts) =>
      patchGitMountsForWindows(gitMounts, worktreePath, SANDBOX_REPO_DIR),
    ),
    Effect.tap((gitMounts) => {
      mountsToClean.push(...gitMounts);
    }),
    Effect.flatMap((gitMounts) =>
      startSandbox({
        provider,
        hostRepoDir,
        env,
        worktreeOrRepoPath: worktreePath,
        gitMounts,
        repoDir: SANDBOX_REPO_DIR,
      }),
    ),
  );

/** Starts `provider`'s sandbox on `worktreePath`, whatever its tag. */
const startProviderSandbox = (options: StartProviderSandboxOptions) => {
  const { provider, hostRepoDir, worktreePath, env } = options;
  if (provider.tag === "isolated") {
    return startSandbox({
      provider,
      hostRepoDir: worktreePath,
      env,
      copyPaths: options.copyToWorktree,
      copySourceDir: hostRepoDir,
    });
  }
  if (provider.tag === "none") {
    return startSandbox({
      provider,
      hostRepoDir,
      env,
      worktreeOrRepoPath: worktreePath,
    });
  }
  return startBindMountWithGitMounts(provider, options);
};

/**
 * Copies `copyToWorktree` paths from the host repo into the worktree.
 * Isolated providers skip this: startSandbox copies their paths in.
 */
const copyIntoWorktree = (
  options: Pick<
    CreateSandboxOptions,
    "copyToWorktree" | "sandbox" | "timeouts"
  >,
  hostRepoDir: string,
  worktreePath: string,
) =>
  options.copyToWorktree &&
  options.copyToWorktree.length > 0 &&
  options.sandbox.tag !== "isolated"
    ? copyToWorktree(
        options.copyToWorktree,
        hostRepoDir,
        worktreePath,
        options.timeouts?.copyToWorktreeMs,
      )
    : Effect.void;

/** The `buildSandboxHandle` fields that come from the provider and its handle. */
const providerHandleFields = (
  provider: SandboxProvider,
  providerHandle: ProviderHandle | undefined,
  worktreePath: string,
) => ({
  providerHandle,
  // Pre-narrow the bind-mount handle for the orchestrator's session-capture
  // path. Gating on the provider tag avoids handing a NoSandbox/Isolated
  // handle (which lack copyFileIn/copyFileOut) to AgentSessionStorage and
  // turning a missing-feature into a runtime SessionCaptureError.
  bindMountHandle:
    provider.tag === "bind-mount"
      ? (providerHandle as BindMountSandboxHandle | undefined)
      : undefined,
  providerTag: provider.tag,
  sandboxProvider: provider,
  sandboxProviderEnv: provider.env,
  // Syncs an isolated sandbox's changes back to the host worktree.
  applyToHost:
    provider.tag === "isolated" && providerHandle
      ? () => syncOut(worktreePath, providerHandle as IsolatedSandboxHandle)
      : () => Effect.void,
});

/**
 * Starts the sandbox on `worktreePath`: the provider's, or the local sandbox
 * layer in test mode.
 */
const startSandboxOnWorktree = ({
  options,
  hostRepoDir,
  worktreePath,
  mountsToClean,
}: {
  readonly options: Pick<
    CreateSandboxOptions,
    "sandbox" | "_test" | "copyToWorktree"
  >;
  readonly hostRepoDir: string;
  readonly worktreePath: string;
  readonly mountsToClean: MountEntry[];
}) =>
  Effect.gen(function* () {
    if (options._test?.buildSandbox) {
      return {
        sandbox: options._test.buildSandbox(worktreePath),
        sandboxRepoDir: worktreePath,
        providerHandle: options._test.bindMountHandle,
      };
    }
    const resolvedEnv = yield* resolveEnv(hostRepoDir);
    const env = mergeProviderEnv({
      resolvedEnv,
      agentProviderEnv: {},
      sandboxProviderEnv: options.sandbox.env,
    });
    const startResult = yield* startProviderSandbox({
      provider: options.sandbox,
      hostRepoDir,
      worktreePath,
      env,
      copyToWorktree: options.copyToWorktree,
      mountsToClean,
    });
    return {
      providerHandle: startResult.handle,
      sandbox: startResult.sandbox,
      sandboxRepoDir: startResult.worktreePath,
    };
  });

/**
 * Runs the onSandboxReady hooks, sandbox-side and host-side in parallel,
 * after marking the sandbox repo a git safe.directory. A no-op without hooks.
 */
const runOnSandboxReadyHooks = ({
  sandbox,
  sandboxRepoDir,
  worktreePath,
  hooks,
}: {
  readonly sandbox: SandboxService;
  readonly sandboxRepoDir: string;
  readonly worktreePath: string;
  readonly hooks: SandboxHooks | undefined;
}) => {
  const sandboxOnReady = hooks?.sandbox?.onSandboxReady ?? [];
  const hostOnReady = hooks?.host?.onSandboxReady ?? [];
  if (sandboxOnReady.length === 0 && hostOnReady.length === 0) {
    return Effect.void;
  }
  return Effect.gen(function* () {
    yield* sandbox.exec(
      `git config --global --add safe.directory "${sandboxRepoDir}"`,
    );
    const sandboxEffects = sandboxOnReady.map((hook) =>
      execOk(sandbox, hook.command, {
        cwd: sandboxRepoDir,
        sudo: hook.sudo,
      }),
    );
    const allEffects = [
      ...sandboxEffects,
      ...(hostOnReady.length > 0
        ? [runHostHooks(hostOnReady, worktreePath)]
        : []),
    ];
    yield* Effect.all(allEffects, { concurrency: "unbounded" });
  });
};

/**
 * Tears down a sandbox whose setup failed after it started: closes the
 * container, ignoring close errors, and removes its mount temp dirs.
 */
const tearDownStartedSandbox = (
  providerHandle: ProviderHandle | undefined,
  mountsToClean: readonly MountEntry[],
): Effect.Effect<void> =>
  (providerHandle
    ? Effect.promise(() => providerHandle.close().catch(() => {}))
    : Effect.void
  ).pipe(Effect.andThen(removeMountTempDirs(mountsToClean)));

/** A close() that tears down the container only, once, and its mount temp dirs. */
const closeContainerOnly = (
  providerHandle: ProviderHandle | undefined,
  mountsToClean: readonly MountEntry[],
): (() => Promise<CloseResult>) => {
  let closed = false;
  return async () => {
    if (closed) {
      return { preservedWorktreePath: undefined };
    }
    closed = true;
    if (providerHandle) {
      await providerHandle.close();
    }
    await Effect.runPromise(removeMountTempDirs(mountsToClean));
    return { preservedWorktreePath: undefined };
  };
};

/**
 * @internal Creates a sandbox backed by an existing worktree.
 * Split ownership: close() tears down the container only, leaving the worktree intact.
 * Used by Worktree.createSandbox().
 */
export const createSandboxFromWorktree = async (
  options: CreateSandboxFromWorktreeOptions,
): Promise<Sandbox> => {
  const { branch, worktreePath, hostRepoDir } = options;
  validateTimeoutOptions(options);

  // 1. Copy files if requested (bind-mount only)
  await Effect.runPromise(copyIntoWorktree(options, hostRepoDir, worktreePath));

  // 2. Start sandbox via provider or local sandbox layer (test mode)
  // Temp dirs behind the git mounts, removed once the sandbox is closed.
  const mountsToClean: MountEntry[] = [];
  const { providerHandle, sandbox, sandboxRepoDir } = await Effect.runPromise(
    startSandboxOnWorktree({
      options,
      hostRepoDir,
      worktreePath,
      mountsToClean,
    }).pipe(
      Effect.onError(() => removeMountTempDirs(mountsToClean)),
      Effect.provide(NodeContext.layer),
    ),
  );

  // 3. Run onSandboxReady hooks (sandbox-side and host-side in parallel). If
  // they fail, tear down the container that just started; the worktree stays.
  await Effect.runPromise(
    runOnSandboxReadyHooks({
      sandbox,
      sandboxRepoDir,
      worktreePath,
      hooks: options.hooks,
    }).pipe(
      Effect.onError(() =>
        tearDownStartedSandbox(providerHandle, mountsToClean),
      ),
    ),
  );

  // 4. Build and return sandbox handle — container-only close (worktree owns worktree)
  return buildSandboxHandle(
    {
      branch,
      worktreePath,
      hostRepoDir,
      sandboxRepoDir,
      sandbox,
      ...providerHandleFields(options.sandbox, providerHandle, worktreePath),
      timeouts: options.timeouts,
      branchStrategy: options.branchStrategy,
    },
    closeContainerOnly(providerHandle, mountsToClean),
  );
};

/**
 * @internal Copies files into the new worktree, runs host `onWorktreeReady`
 * hooks, starts the sandbox, then runs `onSandboxReady` hooks. If those
 * hooks fail, the sandbox that just started is torn down.
 */
const prepareSandboxOnWorktree = (
  options: CreateSandboxOptions,
  target: {
    readonly hostRepoDir: string;
    readonly worktreePath: string;
    readonly mountsToClean: MountEntry[];
  },
) =>
  Effect.gen(function* () {
    const { hostRepoDir, worktreePath, mountsToClean } = target;
    // Copy files (bind-mount/no-sandbox only; isolated copies in startSandbox).
    yield* copyIntoWorktree(options, hostRepoDir, worktreePath);

    // Run host.onWorktreeReady hooks (after copy, before sandbox creation).
    const onWorktreeReady = options.hooks?.host?.onWorktreeReady;
    if (onWorktreeReady !== undefined && onWorktreeReady.length > 0) {
      yield* runHostHooks(onWorktreeReady, worktreePath);
    }

    // Start the sandbox via the test layer or the shared startSandbox helper.
    const { providerHandle, sandbox, sandboxRepoDir } =
      yield* startSandboxOnWorktree({
        options,
        hostRepoDir,
        worktreePath,
        mountsToClean,
      });

    // Run onSandboxReady hooks (sandbox-side and host-side in parallel). If
    // they fail, tear down the container that just started before the outer
    // handler removes the worktree.
    yield* runOnSandboxReadyHooks({
      sandbox,
      sandboxRepoDir,
      worktreePath,
      hooks: options.hooks,
    }).pipe(
      Effect.onError(() =>
        tearDownStartedSandbox(providerHandle, mountsToClean),
      ),
    );

    return { providerHandle, sandbox, sandboxRepoDir };
  });

/**
 * @internal Resolves the host repo, creates the worktree on `options.branch`
 * and prepares the sandbox on it. Once the worktree exists, any later
 * failure (e.g. a missing image surfacing when the provider creates the
 * container) tears down the container — if it started — and removes the
 * worktree so it is not orphaned on disk.
 */
const setUpWorktreeSandbox = (
  options: CreateSandboxOptions,
  mountsToClean: MountEntry[],
) =>
  Effect.gen(function* () {
    const hostRepoDir = yield* resolveCwd(options.cwd);

    const worktreeMs = options.timeouts?.worktreeMs;
    yield* WorktreeManager.pruneStale(hostRepoDir, worktreeMs).pipe(
      Effect.catchAll(() => Effect.void),
    );
    const { path: worktreePath } = yield* WorktreeManager.create(hostRepoDir, {
      branch: options.branch,
      baseBranch: options.baseBranch,
      timeoutMs: worktreeMs,
    });

    const prepared = yield* prepareSandboxOnWorktree(options, {
      hostRepoDir,
      worktreePath,
      mountsToClean,
    }).pipe(
      Effect.onError(() =>
        WorktreeManager.remove(worktreePath).pipe(
          Effect.catchAll(() => Effect.void),
          Effect.andThen(removeMountTempDirs(mountsToClean)),
        ),
      ),
    );

    return { hostRepoDir, worktreePath, ...prepared };
  });

/** @internal Tells the user where a worktree left behind by a shutdown is. */
const printWorktreePreserved = (worktreePath: string): void => {
  console.error(`\nWorktree preserved at ${worktreePath}`);
  console.error(`  To review: cd ${worktreePath}`);
  console.error(`  To clean up: git worktree remove --force ${worktreePath}`);
};

/**
 * @internal Closes a top-level `createSandbox()`: the container, the git
 * mounts' temp dirs, then the worktree unless it has uncommitted changes.
 */
const closeSandboxAndWorktree = (target: {
  readonly providerHandle: ProviderHandle | undefined;
  readonly mountsToClean: readonly MountEntry[];
  readonly worktreePath: string;
}): Effect.Effect<CloseResult> =>
  Effect.gen(function* () {
    const { providerHandle, mountsToClean, worktreePath } = target;
    if (providerHandle) {
      yield* Effect.promise(() => providerHandle.close());
    }
    yield* removeMountTempDirs(mountsToClean);

    // Preserve the worktree when it has uncommitted changes; otherwise remove it.
    const isDirty = yield* WorktreeManager.hasUncommittedChanges(
      worktreePath,
    ).pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (isDirty) {
      return { preservedWorktreePath: worktreePath };
    }

    yield* WorktreeManager.remove(worktreePath).pipe(
      Effect.catchAll(() => Effect.void),
    );
    return { preservedWorktreePath: undefined };
  });

/**
 * Eagerly creates a git worktree on the provided explicit branch and starts
 * a sandbox with the worktree bind-mounted. Returns a Sandbox handle that
 * can be reused across multiple `run()` calls.
 */
export const createSandbox = async (
  options: CreateSandboxOptions,
): Promise<Sandbox> => {
  const { branch } = options;
  validateTimeoutOptions(options);
  // Temp dirs behind the git mounts, removed once the sandbox is closed.
  const mountsToClean: MountEntry[] = [];

  // Resolve cwd, create the worktree, and set up the sandbox in a single Effect.
  const { hostRepoDir, worktreePath, providerHandle, sandbox, sandboxRepoDir } =
    await Effect.runPromise(
      setUpWorktreeSandbox(options, mountsToClean).pipe(
        Effect.provide(NodeContext.layer),
      ),
    );

  // Route cleanup through the shared registry so concurrent sandboxes share one
  // SIGINT/SIGTERM/exit listener instead of tripping MaxListenersExceededWarning.
  const unregisterShutdown = registerShutdown(() => {
    printWorktreePreserved(worktreePath);
  });

  let closed = false;
  const doClose = async (): Promise<CloseResult> => {
    if (closed) {
      return { preservedWorktreePath: undefined };
    }
    closed = true;
    return Effect.runPromise(
      closeSandboxAndWorktree({ providerHandle, mountsToClean, worktreePath }),
    );
  };

  return buildSandboxHandle(
    {
      branch,
      worktreePath,
      hostRepoDir,
      sandboxRepoDir,
      sandbox,
      // applyToHost is built once, reused across runs.
      ...providerHandleFields(options.sandbox, providerHandle, worktreePath),
      timeouts: options.timeouts,
    },
    async () => {
      unregisterShutdown();
      return doClose();
    },
  );
};
