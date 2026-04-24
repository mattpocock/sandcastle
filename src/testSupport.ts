/**
 * Internal test-support module for init-template e2e tests.
 *
 * NOT a published subpath of @ai-hero/sandcastle.
 * Exports: runForTest, recording agent-invoker layer, identity preprocessor
 * layer, and a recorder accessor.
 */
import { NodeContext } from "@effect/platform-node";
import { Effect, Layer, Ref } from "effect";
import { resolveCwd } from "./resolveCwd.js";
import type { AgentProvider } from "./AgentProvider.js";
import { SilentDisplay, type DisplayEntry } from "./Display.js";
import {
  orchestrate,
  type OrchestrateResult,
} from "./Orchestrator.js";
import { resolvePrompt } from "./PromptResolver.js";
import { defaultSessionPathsLayer } from "./SessionPaths.js";
import { getCurrentBranch, generateTempBranchName } from "./WorktreeManager.js";
import {
  type PromptArgs,
  substitutePromptArgs,
  validateNoBuiltInArgOverride,
  BUILT_IN_PROMPT_ARG_KEYS,
} from "./PromptArgumentSubstitution.js";
import { AgentInvoker, type AgentInvocation } from "./AgentInvoker.js";
import { PromptPreprocessor } from "./PromptPreprocessorTag.js";
import { makeLocalSandboxFactoryLayer } from "./LocalSandboxFactory.js";
import type { BranchStrategy } from "./SandboxProvider.js";
import type { RunOptions, RunResult } from "./run.js";
import { DEFAULT_MAX_ITERATIONS } from "./run.js";

// -----------------------------------------------------------------------
// Recorded invocation type
// -----------------------------------------------------------------------

export interface RecordedInvocation {
  readonly prompt: string;
  readonly promptArgs: PromptArgs;
  readonly agentProvider: string;
  readonly model: string;
  readonly branchStrategy: BranchStrategy;
  readonly maxIterations: number;
  readonly runName: string | undefined;
  readonly iterationIndex: number;
}

// -----------------------------------------------------------------------
// Recorder — shared mutable state for recording invocations
// -----------------------------------------------------------------------

let _invocations: RecordedInvocation[] = [];

export const getRecordedInvocations = (): ReadonlyArray<RecordedInvocation> =>
  _invocations;

export const clearRecordedInvocations = (): void => {
  _invocations = [];
};

// -----------------------------------------------------------------------
// Recording AgentInvoker layer
// -----------------------------------------------------------------------

const DEFAULT_COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";

/**
 * Extract the --model value from the provider's print command.
 */
const extractModelFromProvider = (provider: AgentProvider): string => {
  try {
    const cmd = provider.buildPrintCommand({
      prompt: "",
      dangerouslySkipPermissions: false,
    });
    // Match --model 'quoted' or -m 'quoted'
    const match = cmd.command.match(/(?:--model|-m)\s+'([^']+)'/);
    if (match) return match[1]!;
    // Match --model unquoted or -m unquoted
    const match2 = cmd.command.match(/(?:--model|-m)\s+(\S+)/);
    if (match2) return match2[1]!;
  } catch {}
  return "unknown";
};

export const makeRecordingAgentInvokerLayer = (
  context: {
    promptArgs: PromptArgs;
    branchStrategy: BranchStrategy;
    maxIterations: number;
    runName: string | undefined;
  },
): Layer.Layer<AgentInvoker> => {
  let iterationCounter = 0;

  return Layer.succeed(AgentInvoker, {
    invoke: (
      invocation: AgentInvocation,
    ) =>
      Effect.sync(() => {
        iterationCounter++;
        _invocations.push({
          prompt: invocation.prompt,
          promptArgs: context.promptArgs,
          agentProvider: invocation.provider.name,
          model: extractModelFromProvider(invocation.provider),
          branchStrategy: context.branchStrategy,
          maxIterations: context.maxIterations,
          runName: context.runName,
          iterationIndex: iterationCounter,
        });

        return {
          result: `Agent completed. ${DEFAULT_COMPLETION_SIGNAL}`,
          sessionId: undefined,
        };
      }),
  });
};

// -----------------------------------------------------------------------
// Identity PromptPreprocessor layer
// -----------------------------------------------------------------------

/**
 * A test PromptPreprocessor that returns the prompt unchanged (no shell
 * expression expansion). This ensures the recorded prompt is
 * post-argument-substitution but pre-shell-expression-expansion.
 */
export const IdentityPromptPreprocessorLayer: Layer.Layer<PromptPreprocessor> =
  Layer.succeed(PromptPreprocessor, {
    preprocess: (prompt, _sandbox, _cwd) => Effect.succeed(prompt),
  });

// -----------------------------------------------------------------------
// runForTest — same signature as run(), wired with test layers
// -----------------------------------------------------------------------

export const runForTest = async (options: RunOptions): Promise<RunResult> => {
  // If signal is already aborted, reject immediately
  options.signal?.throwIfAborted();

  const {
    prompt,
    promptFile,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    hooks,
    agent: provider,
  } = options;

  // Derive branch strategy: explicit option > default for test
  // In tests, default to "head" since LocalSandboxFactory supports all modes
  const branchStrategy: BranchStrategy =
    options.branchStrategy ?? { type: "head" };

  // Extract explicit branch when in branch mode
  const branch: string | undefined =
    branchStrategy.type === "branch" ? branchStrategy.branch : undefined;

  const hostRepoDir = await Effect.runPromise(
    resolveCwd(options.cwd).pipe(Effect.provide(NodeContext.layer)),
  );

  // Resolve prompt (production behaviour)
  const rawPrompt = await Effect.runPromise(
    resolvePrompt({ prompt, promptFile }).pipe(
      Effect.provide(NodeContext.layer),
    ),
  );

  // Get current branch from the host repo for prompt argument substitution
  const currentHostBranch = await Effect.runPromise(
    getCurrentBranch(hostRepoDir),
  );

  const effectiveBranchType = branchStrategy.type;
  const resolvedBranch =
    effectiveBranchType === "head"
      ? currentHostBranch
      : (branch ?? generateTempBranchName(options.name));

  // Test layers
  const displayLayer = SilentDisplay.layer(
    Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]),
  );

  const factoryLayer = makeLocalSandboxFactoryLayer({
    branchStrategy,
  });

  const userArgs = options.promptArgs ?? {};

  const agentInvokerLayer = makeRecordingAgentInvokerLayer({
    promptArgs: userArgs,
    branchStrategy,
    maxIterations,
    runName: options.name,
  });

  const runLayer = Layer.mergeAll(
    factoryLayer,
    displayLayer,
    defaultSessionPathsLayer,
    agentInvokerLayer,
    IdentityPromptPreprocessorLayer,
  );

  const baseEffect = Effect.gen(function* () {
    // Production prompt-arg substitution
    yield* validateNoBuiltInArgOverride(userArgs);

    const effectiveArgs = {
      SOURCE_BRANCH: resolvedBranch,
      TARGET_BRANCH: currentHostBranch,
      ...userArgs,
    };
    const builtInArgKeysSet = new Set<string>(BUILT_IN_PROMPT_ARG_KEYS);
    const resolvedPrompt = yield* substitutePromptArgs(
      rawPrompt,
      effectiveArgs,
      builtInArgKeysSet,
    );

    const orchestrateBranch =
      effectiveBranchType === "head" ? currentHostBranch : branch;

    const orchestrateResult = yield* orchestrate({
      hostRepoDir,
      iterations: maxIterations,
      hooks,
      prompt: resolvedPrompt,
      branch: orchestrateBranch,
      provider,
      completionSignal: options.completionSignal,
      idleTimeoutSeconds: options.idleTimeoutSeconds,
      name: options.name,
      signal: options.signal,
    });

    return orchestrateResult;
  });

  let result: OrchestrateResult;
  try {
    result = await Effect.runPromise(
      baseEffect.pipe(Effect.provide(runLayer)),
    );
  } catch (error: unknown) {
    options.signal?.throwIfAborted();
    throw error;
  }

  return {
    ...result,
    logFilePath: undefined,
  };
};

// Re-export everything from index so templates can import from the test alias.
// IMPORTANT: export runForTest AS run so the generated main.mts uses it unchanged.
export { runForTest as run };
export type {
  RunOptions,
  RunResult,
  LoggingOption,
  IterationResult,
  IterationUsage,
} from "./run.js";
export { interactive } from "./interactive.js";
export type { InteractiveOptions, InteractiveResult } from "./interactive.js";
export { createSandbox } from "./createSandbox.js";
export type {
  CreateSandboxOptions,
  Sandbox,
  SandboxRunOptions,
  SandboxRunResult,
  SandboxInteractiveOptions,
  SandboxInteractiveResult,
  CloseResult,
} from "./createSandbox.js";
export { createWorktree } from "./createWorktree.js";
export type {
  CreateWorktreeOptions,
  Worktree,
  WorktreeBranchStrategy,
  WorktreeInteractiveOptions,
  WorktreeRunOptions,
  WorktreeRunResult,
  WorktreeCreateSandboxOptions,
} from "./createWorktree.js";
export type { PromptArgs } from "./PromptArgumentSubstitution.js";
export {
  hostSessionStore,
  sandboxSessionStore,
  transferSession,
} from "./SessionStore.js";
export type { SessionStore } from "./SessionStore.js";
export {
  SessionPaths,
  sessionPathsLayer,
  defaultSessionPathsLayer,
} from "./SessionPaths.js";
export type { SandboxHooks } from "./SandboxLifecycle.js";
export type { MountConfig } from "./MountConfig.js";
export { CwdError } from "./resolveCwd.js";
export { claudeCode, codex, opencode, pi } from "./AgentProvider.js";
export type {
  AgentProvider,
  AgentCommandOptions,
  PrintCommand,
  ClaudeCodeOptions,
  CodexOptions,
  OpenCodeOptions,
  PiOptions,
} from "./AgentProvider.js";
export {
  createBindMountSandboxProvider,
  createIsolatedSandboxProvider,
} from "./SandboxProvider.js";
export type {
  SandboxProvider,
  AnySandboxProvider,
  BindMountSandboxProvider,
  IsolatedSandboxProvider,
  NoSandboxProvider,
  BindMountSandboxHandle,
  IsolatedSandboxHandle,
  NoSandboxHandle,
  InteractiveExecOptions,
  ExecResult,
  BindMountCreateOptions,
  BindMountSandboxProviderConfig,
  IsolatedCreateOptions,
  IsolatedSandboxProviderConfig,
  BranchStrategy,
  BindMountBranchStrategy,
  IsolatedBranchStrategy,
  NoSandboxBranchStrategy,
  HeadBranchStrategy,
  MergeToHeadBranchStrategy,
  NamedBranchStrategy,
} from "./SandboxProvider.js";
