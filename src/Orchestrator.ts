import { Deferred, Effect } from "effect";
import { Display } from "./Display.js";
import { preprocessPrompt } from "./PromptPreprocessor.js";
import { AgentError, TimeoutError } from "./errors.js";
import type { SandboxError } from "./errors.js";
import type { SandboxService } from "./SandboxFactory.js";
import { SandboxFactory } from "./SandboxFactory.js";
import { withSandboxLifecycle, type SandboxHooks } from "./SandboxLifecycle.js";

export interface TokenUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly total_cost_usd: number;
  readonly num_turns: number;
  readonly duration_ms: number;
}

export const DEFAULT_MODEL = "claude-opus-4-6";

const extractUsage = (obj: Record<string, unknown>): TokenUsage | null => {
  const usage = obj.usage as Record<string, unknown> | undefined;
  if (
    !usage ||
    typeof usage.input_tokens !== "number" ||
    typeof usage.output_tokens !== "number"
  ) {
    return null;
  }
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_input_tokens:
      typeof usage.cache_read_input_tokens === "number"
        ? usage.cache_read_input_tokens
        : 0,
    cache_creation_input_tokens:
      typeof usage.cache_creation_input_tokens === "number"
        ? usage.cache_creation_input_tokens
        : 0,
    total_cost_usd:
      typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : 0,
    num_turns: typeof obj.num_turns === "number" ? obj.num_turns : 0,
    duration_ms: typeof obj.duration_ms === "number" ? obj.duration_ms : 0,
  };
};

export type ParsedStreamEvent =
  | { type: "text"; text: string }
  | { type: "result"; result: string; usage: TokenUsage | null }
  | { type: "tool_call"; name: string; args: string };

/** Maps allowlisted tool names to the input field containing the display arg */
const TOOL_ARG_FIELDS: Record<string, string> = {
  Bash: "command",
  WebSearch: "query",
  WebFetch: "url",
  Agent: "description",
};

/** Extract displayable events from a stream-json line */
export const parseStreamJsonLine = (line: string): ParsedStreamEvent[] => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line);
    if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
      const events: ParsedStreamEvent[] = [];
      const texts: string[] = [];
      for (const block of obj.message.content as {
        type: string;
        text?: string;
        name?: string;
        input?: Record<string, unknown>;
      }[]) {
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (
          block.type === "tool_use" &&
          typeof block.name === "string" &&
          block.input !== undefined
        ) {
          const argField = TOOL_ARG_FIELDS[block.name];
          if (argField === undefined) continue; // not allowlisted
          const argValue = block.input[argField];
          if (typeof argValue !== "string") continue; // missing/wrong arg field
          if (texts.length > 0) {
            events.push({ type: "text", text: texts.join("") });
            texts.length = 0;
          }
          events.push({
            type: "tool_call",
            name: block.name,
            args: argValue,
          });
        }
      }
      if (texts.length > 0) {
        events.push({ type: "text", text: texts.join("") });
      }
      return events;
    }
    if (obj.type === "result" && typeof obj.result === "string") {
      return [{ type: "result", result: obj.result, usage: extractUsage(obj) }];
    }
  } catch {
    // Not valid JSON — skip
  }
  return [];
};

const TOOL_ARG_EXTRACTORS: Record<
  string,
  (input: Record<string, unknown>) => string | undefined
> = {
  Bash: (input) =>
    typeof input.command === "string" ? input.command : undefined,
  WebSearch: (input) =>
    typeof input.query === "string" ? input.query : undefined,
  WebFetch: (input) => (typeof input.url === "string" ? input.url : undefined),
  Agent: (input) =>
    typeof input.description === "string" ? input.description : undefined,
};

/**
 * Format a tool call for display. Returns null if the tool is not in the
 * allowlist or the required arg field is missing.
 */
export const formatToolCall = (
  name: string,
  input: Record<string, unknown>,
): { name: string; formattedArgs: string } | null => {
  const extractor = TOOL_ARG_EXTRACTORS[name];
  if (!extractor) return null;
  const arg = extractor(input);
  if (arg === undefined) return null;
  return { name, formattedArgs: arg };
};

const invokeAgent = (
  sandbox: SandboxService,
  sandboxRepoDir: string,
  prompt: string,
  model: string,
  idleTimeoutMs: number,
  onText: (text: string) => void,
  onToolCall: (name: string, formattedArgs: string) => void,
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

    const execEffect = Effect.gen(function* () {
      const execResult = yield* sandbox.execStreaming(
        `claude --print --verbose --dangerously-skip-permissions --output-format stream-json --model ${shellEscape(model)} -p ${shellEscape(prompt)}`,
        (line) => {
          for (const parsed of parseStreamJsonLine(line)) {
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
            message: `Claude exited with code ${execResult.exitCode}:\n${execResult.stderr}`,
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

const shellEscape = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

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
  const idleTimeoutMs =
    (options.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS) * 1000;
  return Effect.gen(function* () {
    const factory = yield* SandboxFactory;
    const display = yield* Display;
    const { hostRepoDir, sandboxRepoDir, iterations, hooks, prompt, branch } =
      options;
    const resolvedModel = options.model ?? DEFAULT_MODEL;
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
