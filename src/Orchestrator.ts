import { Deferred, Effect } from "effect";
import { Display } from "./Display.js";
import { preprocessPrompt } from "./PromptPreprocessor.js";
import { AgentError, TimeoutError } from "./errors.js";
import type { SandboxError } from "./errors.js";
import type { SandboxService } from "./SandboxFactory.js";
import { SandboxFactory } from "./SandboxFactory.js";
import { withSandboxLifecycle, type SandboxHooks } from "./SandboxLifecycle.js";
import type {
  AgentProvider,
  TokenUsage,
  ParsedStreamEvent,
} from "./AgentProvider.js";
import { claudeCodeProvider } from "./AgentProvider.js";

// Re-export types that were previously defined here for backward compatibility
export type { TokenUsage, ParsedStreamEvent } from "./AgentProvider.js";

/**
 * Default model for the claude-code provider.
 * Prefer `agentProvider.defaultModel` when a provider is available.
 */
export const DEFAULT_MODEL = claudeCodeProvider.defaultModel;

const invokeAgent = (
  sandbox: SandboxService,
  sandboxRepoDir: string,
  prompt: string,
  model: string,
  idleTimeoutMs: number,
  onText: (text: string) => void,
  onToolCall: (name: string, formattedArgs: string) => void,
  provider: AgentProvider,
): Effect.Effect<{ result: string; usage: TokenUsage | null }, SandboxError> =>
  Effect.gen(function* () {
    let resultText = "";
    let tokenUsage: TokenUsage | null = null;

    // Deferred that will be failed when the idle timer fires
    const timeoutSignal = yield* Deferred.make<never, TimeoutError>();
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const idleTimeoutSeconds = idleTimeoutMs / 1000;

    const resetIdleTimer = () => {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      timeoutHandle = setTimeout(() => {
        Effect.runPromise(
          Deferred.fail(
            timeoutSignal,
            new TimeoutError({
              message: `Agent idle for ${idleTimeoutSeconds} seconds — no output received. Consider increasing the idle timeout with --idle-timeout.`,
              idleTimeoutSeconds,
            }),
          ),
        ).catch(() => {});
      }, idleTimeoutMs);
    };

    resetIdleTimer();

    const command = provider.buildPrintCommand({ model, prompt });

    const execEffect = Effect.gen(function* () {
      const execResult = yield* sandbox.execStreaming(
        command,
        (line) => {
          for (const parsed of provider.parseStreamLine(line)) {
            if (parsed.type === "text") {
              resetIdleTimer();
              onText(parsed.text);
            } else if (parsed.type === "result") {
              resultText = parsed.result;
              tokenUsage = parsed.usage;
            } else if (parsed.type === "tool_call") {
              resetIdleTimer();
              onToolCall(parsed.name, parsed.args);
            }
          }
        },
        { cwd: sandboxRepoDir },
      );

      if (execResult.exitCode !== 0) {
        return yield* Effect.fail(
          new AgentError({
            message: `${provider.name} exited with code ${execResult.exitCode}:\n${execResult.stderr}`,
          }),
        );
      }

      return { result: resultText || execResult.stdout, usage: tokenUsage };
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (timeoutHandle !== null) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
          }
        }),
      ),
    );

    return yield* Effect.raceFirst(execEffect, Deferred.await(timeoutSignal));
  });

const formatNumber = (n: number): string => n.toLocaleString("en-US");

const formatUsageRows = (usage: TokenUsage): Record<string, string> => ({
  Tokens: `${formatNumber(usage.input_tokens)} in / ${formatNumber(usage.output_tokens)} out`,
  Turns: `${usage.num_turns}`,
});

const DEFAULT_COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";
const DEFAULT_IDLE_TIMEOUT_SECONDS = 5 * 60; // 300 seconds

export interface OrchestrateOptions {
  readonly hostRepoDir: string;
  readonly sandboxRepoDir: string;
  readonly iterations: number;
  readonly hooks?: SandboxHooks;
  readonly prompt: string;
  readonly branch?: string;
  readonly model?: string;
  readonly completionSignal?: string | string[];
  /** Idle timeout in seconds. If the agent produces no output for this long, it fails with TimeoutError. Default: 300 (5 minutes) */
  readonly idleTimeoutSeconds?: number;
  /** Optional name for the run, prepended to status messages as [name] */
  readonly name?: string;
  /** The agent provider to use. Defaults to claude-code when not specified. */
  readonly agentProvider?: AgentProvider;
}

export interface OrchestrateResult {
  readonly iterationsRun: number;
  /** The matched completion signal string, or undefined if none fired. */
  readonly completionSignal?: string;
  readonly stdout: string;
  readonly commits: { sha: string }[];
  readonly branch: string;
  /** Host path to the preserved worktree from the last iteration, set when the worktree was left behind due to uncommitted changes on a successful run. */
  readonly preservedWorktreePath?: string;
}

export const orchestrate = (
  options: OrchestrateOptions,
): Effect.Effect<OrchestrateResult, SandboxError, SandboxFactory | Display> => {
  const provider = options.agentProvider ?? claudeCodeProvider;
  const idleTimeoutMs =
    (options.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS) * 1000;
  return Effect.gen(function* () {
    const factory = yield* SandboxFactory;
    const display = yield* Display;
    const { hostRepoDir, sandboxRepoDir, iterations, hooks, prompt, branch } =
      options;
    const resolvedModel = options.model ?? provider.defaultModel;
    let completionSignals: string[];
    if (options.completionSignal === undefined) {
      completionSignals = [DEFAULT_COMPLETION_SIGNAL];
    } else if (Array.isArray(options.completionSignal)) {
      completionSignals = options.completionSignal;
    } else {
      completionSignals = [options.completionSignal];
    }

    const label = (msg: string): string =>
      options.name ? `[${options.name}] ${msg}` : msg;

    const allCommits: { sha: string }[] = [];
    let allStdout = "";
    let resolvedBranch = "";
    let iterationPreservedPath: string | undefined;

    for (let i = 1; i <= iterations; i++) {
      yield* display.status(label(`Iteration ${i}/${iterations}`), "info");

      const sandboxResult = yield* factory.withSandbox(({ hostWorktreePath }) =>
        withSandboxLifecycle(
          {
            hostRepoDir,
            sandboxRepoDir,
            hooks,
            branch,
            hostWorktreePath,
          },
          (ctx) =>
            Effect.gen(function* () {
              // Preprocess prompt (run !`command` expressions inside sandbox)
              const fullPrompt = yield* preprocessPrompt(
                prompt,
                ctx.sandbox,
                ctx.sandboxRepoDir,
              );

              yield* display.status(label("Agent started"), "success");

              // Invoke the agent
              const onText = (text: string) => {
                Effect.runPromise(display.text(text));
              };
              const onToolCall = (name: string, formattedArgs: string) => {
                Effect.runPromise(display.toolCall(name, formattedArgs));
              };
              const { result: agentOutput, usage } = yield* invokeAgent(
                ctx.sandbox,
                ctx.sandboxRepoDir,
                fullPrompt,
                resolvedModel,
                idleTimeoutMs,
                onText,
                onToolCall,
                provider,
              );

              yield* display.status(label("Agent stopped"), "info");

              // Log usage summary
              if (usage) {
                yield* display.summary("Token Usage", formatUsageRows(usage));
              }

              // Check completion signal
              const matchedSignal = completionSignals.find((sig) =>
                agentOutput.includes(sig),
              );
              return {
                completionSignal: matchedSignal,
                stdout: agentOutput,
              } as const;
            }),
        ),
      );

      const lifecycleResult = sandboxResult.value;
      iterationPreservedPath = sandboxResult.preservedWorktreePath;

      allCommits.push(...lifecycleResult.commits);
      allStdout += lifecycleResult.result.stdout;
      resolvedBranch = lifecycleResult.branch;

      if (lifecycleResult.result.completionSignal !== undefined) {
        yield* display.status(
          label(`Agent signaled completion after ${i} iteration(s).`),
          "success",
        );
        return {
          iterationsRun: i,
          completionSignal: lifecycleResult.result.completionSignal,
          stdout: allStdout,
          commits: allCommits,
          branch: resolvedBranch,
          preservedWorktreePath: iterationPreservedPath,
        };
      }
    }

    yield* display.status(
      label(`Reached max iterations (${iterations}).`),
      "info",
    );
    return {
      iterationsRun: iterations,
      completionSignal: undefined,
      stdout: allStdout,
      commits: allCommits,
      branch: resolvedBranch,
      preservedWorktreePath: iterationPreservedPath,
    };
  });
};
