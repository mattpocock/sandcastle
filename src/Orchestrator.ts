import { Deferred, Effect } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Display } from "./Display.js";
import { preprocessPrompt } from "./PromptPreprocessor.js";
import { AgentError, TimeoutError } from "./errors.js";
import type { SandboxError } from "./errors.js";
import type { SandboxService } from "./SandboxFactory.js";
import { SandboxFactory } from "./SandboxFactory.js";
import { withSandboxLifecycle, type SandboxHooks } from "./SandboxLifecycle.js";
import type { AgentProvider } from "./AgentProvider.js";

export type { ParsedStreamEvent } from "./AgentProvider.js";

const IDLE_WARNING_INTERVAL_MS = 60_000;
const shellEscape = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

const invokeAgent = (
  sandbox: SandboxService,
  sandboxRepoDir: string,
  prompt: string,
  provider: AgentProvider,
  idleTimeoutMs: number,
  onText: (text: string) => void,
  onToolCall: (name: string, formattedArgs: string) => void,
  onIdleWarning: (minutes: number) => void,
  idleWarningIntervalMs: number = IDLE_WARNING_INTERVAL_MS,
): Effect.Effect<{ result: string }, SandboxError> =>
  Effect.gen(function* () {
    let resultText = "";

    // Deferred that will be failed when the idle timer fires
    const timeoutSignal = yield* Deferred.make<never, TimeoutError>();
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const idleTimeoutSeconds = idleTimeoutMs / 1000;

    // Periodic idle warning state
    let warningHandle: ReturnType<typeof setInterval> | null = null;
    let idleMinuteCounter = 0;

    const startWarningInterval = () => {
      if (warningHandle !== null) clearInterval(warningHandle);
      idleMinuteCounter = 0;
      warningHandle = setInterval(() => {
        idleMinuteCounter++;
        onIdleWarning(idleMinuteCounter);
      }, idleWarningIntervalMs);
    };

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
      // Reset warning interval on activity
      startWarningInterval();
    };

    resetIdleTimer();

    const execEffect = Effect.gen(function* () {
      let command = provider.buildPrintCommand(prompt);
      let tempDir: string | null = null;

      if (provider.buildPrintCommandFromStdin) {
        tempDir = mkdtempSync(join(tmpdir(), "sandcastle-prompt-"));
        const hostPromptPath = join(tempDir, "prompt.txt");
        const sandboxPromptPath = "/tmp/sandcastle-prompt.txt";

        writeFileSync(hostPromptPath, prompt, "utf8");
        yield* sandbox.copyIn(hostPromptPath, sandboxPromptPath);

        command = `cat ${shellEscape(sandboxPromptPath)} | ${provider.buildPrintCommandFromStdin()}`;
      }

      const execResult = yield* sandbox.execStreaming(
        command,
        (line) => {
          for (const parsed of provider.parseStreamLine(line)) {
            if (parsed.type === "text") {
              resetIdleTimer();
              onText(parsed.text);
            } else if (parsed.type === "result") {
              resultText = parsed.result;
            } else if (parsed.type === "tool_call") {
              resetIdleTimer();
              onToolCall(parsed.name, parsed.args);
            }
          }
        },
        { cwd: sandboxRepoDir },
      );

      if (tempDir !== null) {
        rmSync(tempDir, { recursive: true, force: true });
      }

      if (execResult.exitCode !== 0) {
        const stdout = execResult.stdout.trim();
        const stderr = execResult.stderr.trim();
        const details = [stderr, stdout].filter(Boolean).join("\n");
        return yield* Effect.fail(
          new AgentError({
            message: `${provider.name} exited with code ${execResult.exitCode}${details ? `:\n${details}` : ""}`,
          }),
        );
      }

      return { result: resultText || execResult.stdout };
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (timeoutHandle !== null) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
          }
          if (warningHandle !== null) {
            clearInterval(warningHandle);
            warningHandle = null;
          }
        }),
      ),
    );

    return yield* Effect.raceFirst(execEffect, Deferred.await(timeoutSignal));
  });

const DEFAULT_COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";
const DEFAULT_IDLE_TIMEOUT_SECONDS = 10 * 60; // 600 seconds

export interface OrchestrateOptions {
  readonly hostRepoDir: string;
  readonly sandboxRepoDir: string;
  readonly iterations: number;
  readonly hooks?: SandboxHooks;
  readonly prompt: string;
  readonly branch?: string;
  readonly provider: AgentProvider;
  readonly completionSignal?: string | string[];
  /** Idle timeout in seconds. If the agent produces no output for this long, it fails with TimeoutError. Default: 600 (10 minutes) */
  readonly idleTimeoutSeconds?: number;
  /** Optional name for the run, prepended to status messages as [name] */
  readonly name?: string;
  /** @internal Test-only override for the idle warning interval in milliseconds. Default: 60000 (1 minute). */
  readonly _idleWarningIntervalMs?: number;
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
    const {
      hostRepoDir,
      sandboxRepoDir,
      iterations,
      hooks,
      prompt,
      branch,
      provider,
    } = options;
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
              const onIdleWarning = (minutes: number) => {
                const msg =
                  minutes === 1
                    ? "Agent idle for 1 minute"
                    : `Agent idle for ${minutes} minutes`;
                Effect.runPromise(display.status(label(msg), "warn"));
              };
              const { result: agentOutput } = yield* invokeAgent(
                ctx.sandbox,
                ctx.sandboxRepoDir,
                fullPrompt,
                provider,
                idleTimeoutMs,
                onText,
                onToolCall,
                onIdleWarning,
                options._idleWarningIntervalMs,
              );

              yield* display.status(label("Agent stopped"), "info");

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
