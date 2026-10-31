import { Context, Effect, Layer } from "effect";

/**
 * A single event in the agent's output stream, surfaced to callers of `run()`
 * so they can forward it to their own observability system.
 *
 * Emitted only in log-to-file mode when an `onAgentStreamEvent` callback is
 * provided via `logging`. See `run()`.
 *
 * The `"raw"` variant carries every stdout line the agent emits, verbatim and
 * before parsing — including lines that the provider's stream parser would
 * otherwise drop (e.g. tool-use blocks for unrecognised tools). Intended for
 * debugging when the typed `"text"` / `"toolCall"` events don't surface
 * enough detail.
 */
export type AgentStreamEvent =
  | {
      readonly type: "text";
      readonly message: string;
      readonly iteration: number;
      readonly timestamp: Date;
    }
  | {
      readonly type: "toolCall";
      readonly name: string;
      readonly formattedArgs: string;
      readonly iteration: number;
      readonly timestamp: Date;
    }
  | {
      readonly type: "raw";
      readonly line: string;
      readonly iteration: number;
      readonly timestamp: Date;
    };

export interface AgentStreamEmitterService {
  readonly emit: (event: AgentStreamEvent) => Effect.Effect<void>;
}

export class AgentStreamEmitter extends Context.Tag(
  "@ai-hero/sandcastle/AgentStreamEmitter",
)<AgentStreamEmitter, AgentStreamEmitterService>() {}

/**
 * Build a layer for the AgentStreamEmitter service.
 *
 * Called with no argument, returns a no-op layer that discards events.
 * Called with a callback, returns a layer that forwards each event to it.
 * The callback is invoked synchronously inside an `Effect.sync`; any error
 * thrown by the callback is caught and discarded so observability failures
 * cannot kill the run.
 */
export const agentStreamEmitterLayer = (
  onEvent?: (event: AgentStreamEvent) => void,
): Layer.Layer<AgentStreamEmitter> =>
  Layer.succeed(AgentStreamEmitter, {
    emit: onEvent
      ? (event) =>
          Effect.sync(() => {
            try {
              onEvent(event);
            } catch {
              // Swallow callback errors — a broken forwarder must not kill the run.
            }
          })
      : () => Effect.void,
  });
