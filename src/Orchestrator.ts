import { join } from "node:path";
import { Deferred, Effect } from "effect";
import { Display } from "./Display.js";
import { preprocessPrompt } from "./PromptPreprocessor.js";
import {
  AgentError,
  AgentIdleTimeoutError,
  SessionCaptureError,
} from "./errors.js";
import type { SandboxError } from "./errors.js";
import type { SandboxService } from "./SandboxFactory.js";
import { SandboxFactory, SANDBOX_REPO_DIR } from "./SandboxFactory.js";
import { withSandboxLifecycle, type SandboxHooks } from "./SandboxLifecycle.js";
import type { AgentProvider } from "./AgentProvider.js";
import { TextDeltaBuffer } from "./TextDeltaBuffer.js";
import {
  hostSessionStore,
  sandboxSessionStore,
  transferSession,
} from "./SessionStore.js";

export type { ParsedStreamEvent } from "./AgentProvider.js";

const IDLE_WARNING_INTERVAL_MS = 60_000;

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
  resumeSession?: string,
): Effect.Effect<{ result: string; sessionId?: string }, SandboxError> =>
  Effect.gen(function* () {
    let resultText = "";
    let sessionId: string | undefined;

    // Deferred that will be failed when the idle timer fires
    const timeoutSignal = yield* Deferred.make<never, AgentIdleTimeoutError>();
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

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
            new AgentIdleTimeoutError({
              message: `Agent idle for ${idleTimeoutMs / 1000} seconds — no output received. Consider increasing the idle timeout with --idle-timeout.`,
              timeoutMs: idleTimeoutMs,
            }),
          ),
        ).catch(() => {});
      }, idleTimeoutMs);
      // Reset warning interval on activity
      startWarningInterval();
    };

    resetIdleTimer();

    // Prefer stdin-based invocation when both the agent provider and the
    // sandbox support it — this keeps the prompt out of argv and avoids the
    // per-argv-string kernel limit (`MAX_ARG_STRLEN`, 128 KB on Linux) that
    // otherwise caps how large a prompt can be.
    const useStdinPath =
      sandbox.supportsStdinExec && provider.buildPrintInvocation !== undefined;
    const invocation = useStdinPath
      ? provider.buildPrintInvocation!({
          prompt,
          dangerouslySkipPermissions: true,
          resumeSession,
        })
      : {
          command: provider.buildPrintCommand({
            prompt,
            dangerouslySkipPermissions: true,
            resumeSession,
          }),
          stdin: undefined as string | undefined,
        };

    const execEffect = Effect.gen(function* () {
      const execResult = yield* sandbox.exec(invocation.command, {
        onLine: (line) => {
          resetIdleTimer();
          for (const parsed of provider.parseStreamLine(line)) {
            if (parsed.type === "text") {
              onText(parsed.text);
            } else if (parsed.type === "result") {
              resultText = parsed.result;
            } else if (parsed.type === "tool_call") {
              onToolCall(parsed.name, parsed.args);
            } else if (parsed.type === "session_id") {
              sessionId = parsed.sessionId;
            }
          }
        },
        cwd: sandboxRepoDir,
        stdin: invocation.stdin,
      });

      if (execResult.exitCode !== 0) {
        return yield* Effect.fail(
          new AgentError({
            message: `${provider.name} exited with code ${execResult.exitCode}:\n${execResult.stderr}`,
          }),
        );
      }

      return { result: resultText || execResult.stdout, sessionId };
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
  readonly iterations: number;
  readonly hooks?: SandboxHooks;
  readonly prompt: string;
  readonly branch?: string;
  readonly provider: AgentProvider;
  readonly completionSignal?: string | string[];
  /** Idle timeout in seconds. If the agent produces no output for this long, it fails with AgentIdleTimeoutError. Default: 600 (10 minutes) */
  readonly idleTimeoutSeconds?: number;
  /** Optional name for the run, prepended to status messages as [name] */
  readonly name?: string;
  /** @internal Test-only override for the idle warning interval in milliseconds. Default: 60000 (1 minute). */
  readonly _idleWarningIntervalMs?: number;
  /** @internal Override for the host projects directory (for testing). */
  readonly _hostProjectsDir?: string;
  /** Resume a prior Claude Code session by ID. Applied to iteration 1 only. */
  readonly resumeSession?: string;
}

/** Per-iteration result carrying an optional session ID. */
export interface IterationResult {
  /** Claude Code session ID extracted from the init line, or undefined for non-Claude agents. */
  readonly sessionId?: string;
  /** Absolute host path to the captured session JSONL, or undefined when capture is disabled or provider is non-Claude. */
  readonly sessionFilePath?: string;
}

export interface OrchestrateResult {
  /** Per-iteration results (use `iterations.length` for the count). */
  readonly iterations: IterationResult[];
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
    const { hostRepoDir, iterations, hooks, prompt, branch, provider } =
      options;
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
    const allIterations: IterationResult[] = [];
    let allStdout = "";
    let resolvedBranch = "";
    let iterationPreservedPath: string | undefined;

    for (let i = 1; i <= iterations; i++) {
      yield* display.status(label(`Iteration ${i}/${iterations}`), "info");

      const sandboxResult = yield* factory.withSandbox(
        ({ hostWorktreePath, sandboxRepoPath, applyToHost, bindMountHandle }) =>
          withSandboxLifecycle(
            {
              hostRepoDir,
              sandboxRepoDir: sandboxRepoPath,
              hooks,
              branch,
              hostWorktreePath,
              applyToHost,
            },
            (ctx) =>
              Effect.gen(function* () {
                // Shared sandbox session infrastructure for resume + capture
                const sandboxProjectsDir = join(
                  "/home/agent",
                  ".claude",
                  "projects",
                );

                // Resume session: transfer JSONL from host to sandbox before iteration 1
                const iterationResumeSession =
                  i === 1 ? options.resumeSession : undefined;
                if (iterationResumeSession && bindMountHandle) {
                  yield* display.status(label("Resuming session"), "info");
                  const sbStore = sandboxSessionStore(
                    ctx.sandboxRepoDir,
                    bindMountHandle,
                    sandboxProjectsDir,
                  );
                  const hStore = hostSessionStore(
                    hostRepoDir,
                    options._hostProjectsDir,
                  );
                  yield* Effect.tryPromise({
                    try: () =>
                      transferSession(hStore, sbStore, iterationResumeSession),
                    catch: (e) =>
                      new SessionCaptureError({
                        message: `Session resume failed: ${e instanceof Error ? e.message : String(e)}`,
                        sessionId: iterationResumeSession,
                      }),
                  });
                }

                // Preprocess prompt (run !`command` expressions inside sandbox)
                const fullPrompt = yield* preprocessPrompt(
                  prompt,
                  ctx.sandbox,
                  ctx.sandboxRepoDir,
                );

                yield* display.status(label("Agent started"), "success");

                // Invoke the agent — buffer text deltas so Pi's single-token
                // chunks are displayed as readable multi-word lines.
                const textBuffer = new TextDeltaBuffer((chunk) => {
                  Effect.runPromise(display.text(chunk));
                });
                const onText = (text: string) => {
                  textBuffer.write(text);
                };
                const onToolCall = (name: string, formattedArgs: string) => {
                  textBuffer.flush();
                  Effect.runPromise(display.toolCall(name, formattedArgs));
                };
                const onIdleWarning = (minutes: number) => {
                  const msg =
                    minutes === 1
                      ? "Agent idle for 1 minute"
                      : `Agent idle for ${minutes} minutes`;
                  Effect.runPromise(display.status(label(msg), "warn"));
                };
                const { result: agentOutput, sessionId } = yield* invokeAgent(
                  ctx.sandbox,
                  ctx.sandboxRepoDir,
                  fullPrompt,
                  provider,
                  idleTimeoutMs,
                  onText,
                  onToolCall,
                  onIdleWarning,
                  options._idleWarningIntervalMs,
                  iterationResumeSession,
                );

                // Flush any remaining buffered text deltas
                textBuffer.dispose();

                yield* display.status(label("Agent stopped"), "info");

                // Capture session while sandbox is still alive
                let sessionFilePath: string | undefined;
                if (provider.captureSessions && sessionId && bindMountHandle) {
                  yield* display.status(label("Capturing session"), "info");
                  const sbStore = sandboxSessionStore(
                    ctx.sandboxRepoDir,
                    bindMountHandle,
                    sandboxProjectsDir,
                  );
                  const hStore = hostSessionStore(
                    hostRepoDir,
                    options._hostProjectsDir,
                  );
                  yield* Effect.tryPromise({
                    try: () => transferSession(sbStore, hStore, sessionId),
                    catch: (e) =>
                      new SessionCaptureError({
                        message: `Session capture failed: ${e instanceof Error ? e.message : String(e)}`,
                        sessionId,
                      }),
                  });
                  sessionFilePath = hStore.sessionFilePath(sessionId);
                }

                // Check completion signal
                const matchedSignal = completionSignals.find((sig) =>
                  agentOutput.includes(sig),
                );
                return {
                  completionSignal: matchedSignal,
                  stdout: agentOutput,
                  sessionId,
                  sessionFilePath,
                } as const;
              }),
          ),
      );

      const lifecycleResult = sandboxResult.value;
      iterationPreservedPath = sandboxResult.preservedWorktreePath;

      allCommits.push(...lifecycleResult.commits);
      allStdout += lifecycleResult.result.stdout;
      resolvedBranch = lifecycleResult.branch;

      allIterations.push({
        sessionId: lifecycleResult.result.sessionId,
        sessionFilePath: lifecycleResult.result.sessionFilePath,
      });

      if (lifecycleResult.result.completionSignal !== undefined) {
        yield* display.status(
          label(`Agent signaled completion after ${i} iteration(s).`),
          "success",
        );
        return {
          iterations: allIterations,
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
      iterations: allIterations,
      completionSignal: undefined,
      stdout: allStdout,
      commits: allCommits,
      branch: resolvedBranch,
      preservedWorktreePath: iterationPreservedPath,
    };
  });
};
