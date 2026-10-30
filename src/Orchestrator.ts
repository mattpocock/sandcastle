import { Deferred, Duration, Effect, Either, Fiber, Option } from "effect";
import { AgentStreamEmitter } from "./AgentStreamEmitter.js";
import { Display } from "./Display.js";
import { preprocessPrompt } from "./PromptPreprocessor.js";
import {
  AgentError,
  AgentIdleTimeoutError,
  SessionCaptureError,
  PromptError,
} from "./errors.js";
import type { SandboxError } from "./errors.js";
import type { SandboxService } from "./SandboxFactory.js";
import { SandboxFactory, SANDBOX_REPO_DIR } from "./SandboxFactory.js";
import { withSandboxLifecycle, type SandboxHooks } from "./SandboxLifecycle.js";
import type { AgentProvider, IterationUsage } from "./AgentProvider.js";
import type { Timeouts } from "./run.js";
import { TextDeltaBuffer } from "./TextDeltaBuffer.js";
import { credentialsToUnset, scopeCommand } from "./CredentialScope.js";
import {
  agentChainOf,
  classifyProviderFailure,
  type ProviderAttempt,
  type ProviderFailureKind,
} from "./AgentFallback.js";

export type { ParsedStreamEvent, IterationUsage } from "./AgentProvider.js";

const IDLE_WARNING_INTERVAL_MS = 60_000;

const invokeAgent = (
  sandbox: SandboxService,
  sandboxRepoDir: string,
  prompt: string,
  provider: AgentProvider,
  idleTimeoutMs: number,
  completionTimeoutMs: number,
  completionSignals: readonly string[],
  onText: (text: string) => void,
  onToolCall: (name: string, formattedArgs: string) => void,
  onRawLine: (line: string) => void,
  onIdleWarning: (minutes: number) => void,
  onCompletionTimeout: (timeoutMs: number) => void,
  idleWarningIntervalMs: number = IDLE_WARNING_INTERVAL_MS,
  resumeSession?: string,
  forkSession?: boolean,
  signal?: AbortSignal,
): Effect.Effect<
  { result: string; sessionId?: string; usage?: IterationUsage },
  SandboxError
> =>
  Effect.gen(function* () {
    if (
      provider.maxPromptCharacters !== undefined &&
      prompt.length > provider.maxPromptCharacters
    ) {
      return yield* Effect.fail(
        new PromptError({
          message: `Resolved ${provider.name} prompt has ${prompt.length} characters; limit is ${provider.maxPromptCharacters}. Inspect shell-expansion sizes in the run log. Send an inventory/artifact reference and read full diffs in bounded chunks; input was not truncated and the agent was not invoked.`,
        }),
      );
    }
    let resultText = "";
    let sessionId: string | undefined;
    let usage: IterationUsage | undefined;
    // Accumulated text/result output, scanned for the completion signal so a
    // hanging process can be force-completed once the signal is in the buffer
    // (see ADR 0019).
    let accumulatedOutput = "";

    // Deferred that fails when the idle timer fires (no signal seen).
    const timeoutSignal = yield* Deferred.make<never, AgentIdleTimeoutError>();
    // Deferred that resolves successfully when the completion-grace timer
    // fires (signal seen but process hasn't exited). Resolving lets the race
    // hand control back to the orchestrator with the buffered output, which
    // still contains the signal so the existing completionSignal check works.
    const completionTimeoutDeferred = yield* Deferred.make<
      { result: string; sessionId?: string; usage?: IterationUsage },
      never
    >();
    let timeoutFiber: Fiber.RuntimeFiber<unknown, unknown> | null = null;
    let completionDetected = false;

    // Periodic idle warning state
    let warningFiber: Fiber.RuntimeFiber<unknown, unknown> | null = null;
    let idleMinuteCounter = 0;

    const interruptFiber = (
      fiber: Fiber.RuntimeFiber<unknown, unknown> | null,
    ) => {
      if (fiber !== null) Effect.runFork(Fiber.interrupt(fiber));
    };

    const startWarningInterval = () => {
      interruptFiber(warningFiber);
      idleMinuteCounter = 0;
      warningFiber = Effect.runFork(
        Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(Duration.millis(idleWarningIntervalMs));
            idleMinuteCounter++;
            onIdleWarning(idleMinuteCounter);
          }
        }),
      );
    };

    const resetTimer = () => {
      interruptFiber(timeoutFiber);
      if (completionDetected) {
        // Post-signal grace window — successful resolution on expiry.
        timeoutFiber = Effect.runFork(
          Effect.gen(function* () {
            yield* Effect.sleep(Duration.millis(completionTimeoutMs));
            onCompletionTimeout(completionTimeoutMs);
            yield* Deferred.succeed(completionTimeoutDeferred, {
              result: resultText || accumulatedOutput,
              sessionId,
              usage,
            });
          }),
        );
      } else {
        // Pre-signal idle window — failure on expiry.
        timeoutFiber = Effect.runFork(
          Effect.gen(function* () {
            yield* Effect.sleep(Duration.millis(idleTimeoutMs));
            yield* Deferred.fail(
              timeoutSignal,
              new AgentIdleTimeoutError({
                message: `Agent idle for ${idleTimeoutMs / 1000} seconds — no stdout or tracked session activity received. Consider increasing the idle timeout with --idle-timeout.`,
                timeoutMs: idleTimeoutMs,
              }),
            );
          }),
        );
        // Reset warning interval on activity, idle-phase only.
        startWarningInterval();
      }
    };

    // Deferred that will be resolved (as a defect) when the AbortSignal fires.
    // Uses Effect.die so the abort reason propagates as-is to run().
    const abortDeferred = yield* Deferred.make<never, never>();
    let abortCleanup: (() => void) | null = null;
    if (signal) {
      if (signal.aborted) {
        return yield* Effect.die(signal.reason);
      }
      const onAbort = () => {
        Effect.runFork(Deferred.die(abortDeferred, signal.reason));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      abortCleanup = () => signal.removeEventListener("abort", onAbort);
    }

    resetTimer();

    // Some Codex versions persist activity that exec --json does not forward.
    // Only growth in this invocation's session is evidence of activity. A live
    // PID, static rollout, unrelated session or a failed probe is not a heartbeat.
    let activitySessionId: string | undefined;
    let activityBytes: number | undefined;
    const activityPollMs = Math.min(5_000, idleTimeoutMs / 4);
    if (provider.buildActivityCommand) {
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(Duration.millis(activityPollMs));
            const observedId = sessionId;
            if (!observedId || completionDetected) continue;
            const sample = yield* sandbox
              .exec(provider.buildActivityCommand!(observedId), {
                cwd: sandboxRepoDir,
              })
              .pipe(
                Effect.timeoutOption(Duration.millis(activityPollMs)),
                Effect.catchAll(() => Effect.succeed(Option.none())),
              );
            // Do not accumulate detached SDK execs if a probe itself hangs.
            // Fall back to stdout-only detection for the rest of this invocation.
            if (Option.isNone(sample)) return;
            if (sessionId !== observedId || completionDetected) continue;
            const result = sample.value;
            const output = result.stdout.trim();
            if (result.exitCode !== 0 || !/^\d+$/.test(output)) continue;
            const bytes = Number(output);
            if (!Number.isSafeInteger(bytes)) continue;
            if (activitySessionId !== observedId) {
              activitySessionId = observedId;
              activityBytes = bytes;
            } else if (activityBytes !== undefined && bytes > activityBytes) {
              activityBytes = bytes;
              resetTimer();
            }
          }
        }),
      );
    }

    const execEffect = Effect.gen(function* () {
      const printCmd = provider.buildPrintCommand({
        prompt,
        dangerouslySkipPermissions: true,
        resumeSession,
        forkSession,
      });
      const execResult = yield* sandbox.exec(
        scopeCommand(printCmd.command, credentialsToUnset(provider)),
        {
          onLine: (line) => {
            // Surface the raw line FIRST so verbose mode/forwarders see every
            // stdout line the agent produced, including ones parseStreamLine
            // drops. Errors thrown by the callback are caught by the emitter
            // layer; isolate the parser path here so a broken forwarder cannot
            // skip parsing.
            try {
              onRawLine(line);
            } catch {
              // Swallow — must not skip parsing/timer logic below.
            }
            for (const parsed of provider.parseStreamLine(line)) {
              if (parsed.type === "text") {
                onText(parsed.text);
                accumulatedOutput += parsed.text;
              } else if (parsed.type === "result") {
                resultText = parsed.result;
                accumulatedOutput += parsed.result;
              } else if (parsed.type === "tool_call") {
                onToolCall(parsed.name, parsed.args);
              } else if (parsed.type === "session_id") {
                sessionId = parsed.sessionId;
              } else if (parsed.type === "usage") {
                usage = parsed.usage;
              }
            }
            // Check for the completion signal AFTER parsing this line so the
            // accumulator contains everything seen so far. Flip to the
            // completion-grace timer the first time the signal appears.
            if (
              !completionDetected &&
              completionSignals.some((sig) => accumulatedOutput.includes(sig))
            ) {
              completionDetected = true;
              interruptFiber(warningFiber);
              warningFiber = null;
            }
            resetTimer();
          },
          cwd: sandboxRepoDir,
          stdin: printCmd.stdin,
        },
      );

      if (execResult.exitCode !== 0) {
        // Prefer stderr; fall back to resultText (from parsed stream events),
        // then to the tail of raw stdout (last 20 non-empty lines).
        let errorDetail = execResult.stderr;
        if (!errorDetail.trim()) {
          errorDetail = resultText;
        }
        if (!errorDetail.trim()) {
          const lines = execResult.stdout.split("\n").filter((l) => l.trim());
          errorDetail = lines.slice(-20).join("\n");
        }
        return yield* Effect.fail(
          new AgentError({
            message: `${provider.name} exited with code ${execResult.exitCode}:\n${errorDetail}`,
          }),
        );
      }

      return { result: resultText || execResult.stdout, sessionId, usage };
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          interruptFiber(timeoutFiber);
          timeoutFiber = null;
          interruptFiber(warningFiber);
          warningFiber = null;
        }),
      ),
    );

    let raced: Effect.Effect<
      { result: string; sessionId?: string; usage?: IterationUsage },
      AgentIdleTimeoutError | SandboxError
    > = Effect.raceFirst(execEffect, Deferred.await(timeoutSignal));
    raced = Effect.raceFirst(raced, Deferred.await(completionTimeoutDeferred));
    if (signal) {
      raced = Effect.raceFirst(
        raced,
        Deferred.await(abortDeferred) as Effect.Effect<never, never>,
      );
    }

    return yield* raced.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          abortCleanup?.();
          interruptFiber(timeoutFiber);
          timeoutFiber = null;
          interruptFiber(warningFiber);
          warningFiber = null;
        }),
      ),
    );
  }).pipe(Effect.scoped);

const DEFAULT_COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";
const DEFAULT_IDLE_TIMEOUT_SECONDS = 10 * 60; // 600 seconds
const DEFAULT_COMPLETION_TIMEOUT_SECONDS = 60;

export interface OrchestrateOptions {
  readonly hostRepoDir: string;
  readonly iterations: number;
  readonly hooks?: SandboxHooks;
  readonly prompt: string;
  readonly branch?: string;
  readonly provider: AgentProvider;
  readonly completionSignal?: string | string[];
  /** Idle timeout in seconds without stdout or provider-reported session growth. Fails with AgentIdleTimeoutError. Default: 600 (10 minutes). */
  readonly idleTimeoutSeconds?: number;
  /**
   * Grace window in seconds after a completion signal is observed in the
   * agent's output. The agent process is expected to exit shortly after
   * emitting the signal; if it does not (because a spawned child is keeping
   * stdout open — see ADR 0019), this timer fires and the iteration resolves
   * successfully with the buffered output. Resets on every subsequent output
   * line, so trailing data (token-usage events, terminal `result` events,
   * structured-output tags) is still captured. Default: 60 seconds.
   */
  readonly completionTimeoutSeconds?: number;
  /** Optional name for the run, prepended to status messages as [name] */
  readonly name?: string;
  /** @internal Test-only override for the idle warning interval in milliseconds. Default: 60000 (1 minute). */
  readonly _idleWarningIntervalMs?: number;
  /** Resume a prior Claude Code session by ID. Applied to iteration 1 only. */
  readonly resumeSession?: string;
  /**
   * When true alongside `resumeSession`, fork the session instead of mutating
   * it — the parent JSONL stays intact and the agent writes a new session
   * under a fresh id. Applied to iteration 1 only. See ADR 0018.
   */
  readonly forkSession?: boolean;
  /** An AbortSignal that cancels the orchestration when aborted. */
  readonly signal?: AbortSignal;
  /** When true, skip prompt expansion (shell expression evaluation). Set for dynamic inline prompts. */
  readonly skipPromptExpansion?: boolean;
  /** Override default timeouts for built-in lifecycle steps. Unset keys keep their defaults. */
  readonly timeouts?: Timeouts;
  /** Forwarded to `withSandboxLifecycle` — see `SandboxLifecycleOptions.keepSourceBranch`. */
  readonly keepSourceBranch?: boolean;
}

/** Per-iteration result carrying an optional session ID. */
export interface IterationResult {
  /** Claude Code session ID extracted from the init line, or undefined for non-Claude agents. */
  readonly sessionId?: string;
  /** Absolute host path to the captured session JSONL, or undefined when capture is disabled or provider is non-Claude. */
  readonly sessionFilePath?: string;
  /** Token usage snapshot from the last assistant message in the session, or undefined when capture is disabled or provider does not support usage parsing. */
  readonly usage?: IterationUsage;
  /** Name of the provider that completed this iteration. */
  readonly provider?: string;
  /** Ordered provider attempts; more than one entry means a fallback was used. */
  readonly providerAttempts?: readonly ProviderAttempt[];
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
): Effect.Effect<
  OrchestrateResult,
  SandboxError,
  SandboxFactory | Display | AgentStreamEmitter
> => {
  const idleTimeoutMs =
    (options.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS) * 1000;
  const completionTimeoutMs =
    (options.completionTimeoutSeconds ?? DEFAULT_COMPLETION_TIMEOUT_SECONDS) *
    1000;
  return Effect.gen(function* () {
    const factory = yield* SandboxFactory;
    const display = yield* Display;
    const streamEmitter = yield* AgentStreamEmitter;
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

    // Helper: check abort signal and bail via defect so run() can
    // re-throw the signal's reason verbatim (no Sandcastle wrapping).
    const checkAbort = (): Effect.Effect<void> =>
      options.signal?.aborted ? Effect.die(options.signal.reason) : Effect.void;

    for (let i = 1; i <= iterations; i++) {
      yield* checkAbort();
      yield* display.status(label(`Iteration ${i}/${iterations}`), "info");

      const sandboxResult = yield* factory.withSandbox(
        (
          { hostWorktreePath, sandboxRepoPath, applyToHost, bindMountHandle },
          sandbox,
        ) =>
          withSandboxLifecycle(
            {
              hostRepoDir,
              sandboxRepoDir: sandboxRepoPath,
              hooks,
              branch,
              hostWorktreePath,
              applyToHost,
              signal: options.signal,
              timeouts: options.timeouts,
              keepSourceBranch: options.keepSourceBranch,
            },
            sandbox,
            (ctx) =>
              Effect.gen(function* () {
                // Resume session: transfer JSONL from host to sandbox before iteration 1
                const iterationResumeSession =
                  i === 1 ? options.resumeSession : undefined;
                const iterationForkSession =
                  i === 1 ? options.forkSession : undefined;
                if (
                  iterationResumeSession &&
                  bindMountHandle &&
                  provider.sessionStorage
                ) {
                  yield* display.status(label("Resuming session"), "info");
                  yield* Effect.tryPromise({
                    try: () =>
                      provider.sessionStorage!.resumeIntoSandbox({
                        hostCwd: hostRepoDir,
                        sandboxCwd: ctx.sandboxRepoDir,
                        sessionId: iterationResumeSession,
                        handle: bindMountHandle,
                      }),
                    catch: (e) =>
                      new SessionCaptureError({
                        message: `Session resume failed: ${e instanceof Error ? e.message : String(e)}`,
                        sessionId: iterationResumeSession,
                      }),
                  });
                }

                // Preprocess prompt (run !`command` expressions inside sandbox).
                // Inline prompts pass through literally — skip expansion.
                const fullPrompt = options.skipPromptExpansion
                  ? prompt
                  : yield* preprocessPrompt(
                      prompt,
                      ctx.sandbox,
                      ctx.sandboxRepoDir,
                    );

                yield* display.status(label("Agent started"), "success");

                // Invoke the agent — buffer text deltas so Pi's single-token
                // chunks are displayed as readable multi-word lines.
                const textBuffer = new TextDeltaBuffer((chunk) => {
                  Effect.runPromise(display.textChunk(chunk));
                  Effect.runPromise(
                    streamEmitter.emit({
                      type: "text",
                      message: chunk,
                      iteration: i,
                      timestamp: new Date(),
                    }),
                  );
                });
                const onText = (text: string) => {
                  textBuffer.write(text);
                };
                const onToolCall = (name: string, formattedArgs: string) => {
                  textBuffer.flush();
                  Effect.runPromise(display.toolCall(name, formattedArgs));
                  Effect.runPromise(
                    streamEmitter.emit({
                      type: "toolCall",
                      name,
                      formattedArgs,
                      iteration: i,
                      timestamp: new Date(),
                    }),
                  );
                };
                const onRawLine = (line: string) => {
                  Effect.runPromise(
                    streamEmitter.emit({
                      type: "raw",
                      line,
                      iteration: i,
                      timestamp: new Date(),
                    }),
                  );
                };
                const onIdleWarning = (minutes: number) => {
                  const msg =
                    minutes === 1
                      ? "Agent idle for 1 minute"
                      : `Agent idle for ${minutes} minutes`;
                  Effect.runPromise(display.status(label(msg), "warn"));
                };
                const onCompletionTimeout = (timeoutMs: number) => {
                  Effect.runPromise(
                    display.status(
                      label(
                        `Completion signal seen but agent process is hanging — force-completing after ${timeoutMs / 1000}s grace window.`,
                      ),
                      "warn",
                    ),
                  );
                };
                // Try the provider chain in order. A fallback is used only for
                // a classified provider failure before any tool call, so no
                // agent effect (file edit, commit) can precede a switch.
                const chain = agentChainOf(provider);
                const providerAttempts: ProviderAttempt[] = [];
                let activeProvider: AgentProvider = provider;
                let invocation:
                  | {
                      result: string;
                      sessionId?: string;
                      usage?: IterationUsage;
                    }
                  | undefined;
                for (let index = 0; index < chain.length; index++) {
                  const entry = chain[index]!;
                  const attemptProvider = index === 0 ? provider : entry.agent;
                  let toolCalls = 0;
                  let rawLines = 0;
                  const attempt = yield* Effect.either(
                    invokeAgent(
                      ctx.sandbox,
                      ctx.sandboxRepoDir,
                      fullPrompt,
                      attemptProvider,
                      idleTimeoutMs,
                      completionTimeoutMs,
                      completionSignals,
                      onText,
                      (name, formattedArgs) => {
                        toolCalls++;
                        onToolCall(name, formattedArgs);
                      },
                      (line) => {
                        rawLines++;
                        onRawLine(line);
                      },
                      onIdleWarning,
                      onCompletionTimeout,
                      options._idleWarningIntervalMs,
                      // Sessions are provider-specific: only the primary resumes.
                      index === 0 ? iterationResumeSession : undefined,
                      index === 0 ? iterationForkSession : undefined,
                      options.signal,
                    ),
                  );
                  if (Either.isRight(attempt)) {
                    providerAttempts.push({
                      ...entry.target,
                      outcome: "succeeded",
                    });
                    activeProvider = attemptProvider;
                    invocation = attempt.right;
                    break;
                  }
                  const failure = attempt.left;
                  const kind: ProviderFailureKind | null =
                    failure instanceof AgentError
                      ? classifyProviderFailure(failure.message)
                      : failure instanceof AgentIdleTimeoutError &&
                          rawLines === 0
                        ? "startup-timeout"
                        : null;
                  const next = chain[index + 1];
                  if (kind === null || toolCalls > 0 || !next) {
                    providerAttempts.push({
                      ...entry.target,
                      outcome: "failed",
                      ...(kind === null ? {} : { reason: kind }),
                    });
                    if (
                      providerAttempts.length > 1 &&
                      failure instanceof AgentError
                    )
                      return yield* Effect.fail(
                        new AgentError({
                          ...failure,
                          message: `${failure.message}\nProvider attempts: ${providerAttempts
                            .map(
                              (a) =>
                                `${a.provider}${a.model ? `/${a.model}` : ""} ${a.outcome}${a.reason ? ` (${a.reason})` : ""}`,
                            )
                            .join(" -> ")}`,
                        }),
                      );
                    return yield* Effect.fail(failure);
                  }
                  providerAttempts.push({
                    ...entry.target,
                    outcome: "fell-back",
                    reason: kind,
                  });
                  textBuffer.flush();
                  yield* display.status(
                    label(
                      `${entry.target.provider} failed before any tool call (${kind}); falling back to ${next.target.provider}${next.target.model ? `/${next.target.model}` : ""}`,
                    ),
                    "warn",
                  );
                }
                const {
                  result: agentOutput,
                  sessionId,
                  usage: streamUsage,
                } = invocation!;

                // Flush any remaining buffered text deltas
                textBuffer.dispose();

                yield* display.status(label("Agent stopped"), "info");

                // Capture session while sandbox is still alive. Usage from the
                // stream (e.g. Codex's turn.completed) is the baseline; a
                // session-parsed value below overrides it when available.
                let sessionFilePath: string | undefined;
                let usage: IterationUsage | undefined = streamUsage;
                if (
                  activeProvider.captureSessions &&
                  activeProvider.sessionStorage &&
                  sessionId &&
                  bindMountHandle
                ) {
                  yield* display.status(label("Capturing session"), "info");
                  yield* Effect.tryPromise({
                    try: () =>
                      activeProvider.sessionStorage!.captureToHost({
                        hostCwd: hostRepoDir,
                        sandboxCwd: ctx.sandboxRepoDir,
                        sessionId,
                        handle: bindMountHandle,
                      }),
                    catch: (e) =>
                      new SessionCaptureError({
                        message: `Session capture failed: ${e instanceof Error ? e.message : String(e)}`,
                        sessionId,
                      }),
                  });
                  sessionFilePath =
                    activeProvider.sessionStorage.hostSessionFilePath(
                      hostRepoDir,
                      sessionId,
                    );

                  // Parse token usage from the captured session JSONL
                  if (activeProvider.parseSessionUsage) {
                    const content = yield* Effect.promise(() =>
                      activeProvider
                        .sessionStorage!.readHostSession(hostRepoDir, sessionId)
                        .catch(() => undefined as string | undefined),
                    );
                    if (content) {
                      const parsedUsage =
                        activeProvider.parseSessionUsage(content);
                      if (parsedUsage) usage = parsedUsage;
                    }
                  }
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
                  usage,
                  provider: activeProvider.name,
                  providerAttempts,
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
        usage: lifecycleResult.result.usage,
        provider: lifecycleResult.result.provider,
        providerAttempts: lifecycleResult.result.providerAttempts,
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
