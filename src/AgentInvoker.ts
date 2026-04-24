import { Context, Effect, Layer, Deferred } from "effect";
import type { SandboxService } from "./SandboxFactory.js";
import type { AgentProvider } from "./AgentProvider.js";
import {
  AgentError,
  AgentIdleTimeoutError,
  type SandboxError,
} from "./errors.js";

const IDLE_WARNING_INTERVAL_MS = 60_000;

export interface AgentInvocation {
  readonly sandbox: SandboxService;
  readonly sandboxRepoDir: string;
  readonly prompt: string;
  readonly provider: AgentProvider;
  readonly idleTimeoutMs: number;
  readonly onText: (text: string) => void;
  readonly onToolCall: (name: string, formattedArgs: string) => void;
  readonly onIdleWarning: (minutes: number) => void;
  readonly idleWarningIntervalMs?: number;
  readonly resumeSession?: string;
  readonly signal?: AbortSignal;
}

export interface AgentInvokerService {
  readonly invoke: (
    invocation: AgentInvocation,
  ) => Effect.Effect<{ result: string; sessionId?: string }, SandboxError>;
}

export class AgentInvoker extends Context.Tag("AgentInvoker")<
  AgentInvoker,
  AgentInvokerService
>() {}

/**
 * Production implementation of AgentInvoker — preserves the original
 * inline behaviour from the orchestrator.
 */
const invokeAgentProduction = (
  invocation: AgentInvocation,
): Effect.Effect<{ result: string; sessionId?: string }, SandboxError> =>
  Effect.gen(function* () {
    const {
      sandbox,
      sandboxRepoDir,
      prompt,
      provider,
      idleTimeoutMs,
      onText,
      onToolCall,
      onIdleWarning,
      idleWarningIntervalMs = IDLE_WARNING_INTERVAL_MS,
      resumeSession,
      signal,
    } = invocation;

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

    // Deferred that will be resolved (as a defect) when the AbortSignal fires.
    // Uses Effect.die so the abort reason propagates as-is to run().
    const abortDeferred = yield* Deferred.make<never, never>();
    let abortCleanup: (() => void) | null = null;
    if (signal) {
      if (signal.aborted) {
        return yield* Effect.die(signal.reason);
      }
      const onAbort = () => {
        Effect.runPromise(Deferred.die(abortDeferred, signal.reason)).catch(
          () => {},
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
      abortCleanup = () => signal.removeEventListener("abort", onAbort);
    }

    resetIdleTimer();

    const execEffect = Effect.gen(function* () {
      const printCmd = provider.buildPrintCommand({
        prompt,
        dangerouslySkipPermissions: true,
        resumeSession,
      });
      const execResult = yield* sandbox.exec(printCmd.command, {
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
        stdin: printCmd.stdin,
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

    let raced = Effect.raceFirst(execEffect, Deferred.await(timeoutSignal));
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
        }),
      ),
    );
  });

/** Production layer — preserves the original inline orchestrator behaviour. */
export const ProductionAgentInvokerLayer: Layer.Layer<AgentInvoker> =
  Layer.succeed(AgentInvoker, {
    invoke: invokeAgentProduction,
  });
