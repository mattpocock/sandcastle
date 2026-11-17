import { Data, Deferred, Effect, Stream } from "effect";
import type { Exit, Queue } from "effect";
import type { OutputDefinition } from "./Output.js";
import type {
  AgentStreamEvent,
  SessionOptions,
  SessionProcess,
  SessionResult,
} from "./Session.js";
import type { SandboxDetachedError } from "./SandboxDetachedError.js";
import { sendTo } from "./sessionSend.js";
import { lostSession, sessionResult } from "./sessionResult.js";
import type { SupervisorLink } from "./supervisorHost.js";
import type { SessionOutcome, SessionRequest } from "./supervisorProtocol.js";

// One session as the host follows it (`sessionHost`), and the process
// handle `spawnSession()` gives for it.

/** The supervisor stopped answering before the session ended. */
export class SupervisorLost extends Data.TaggedError("SupervisorLost")<{
  readonly cause: unknown;
}> {}

/** A host sink (directory or function) failed on the session's record. */
export class RecordSinkFailed extends Data.TaggedError("RecordSinkFailed")<{
  readonly cause: unknown;
}> {}

export type Ended = SupervisorLost | RecordSinkFailed | SandboxDetachedError;

export const END = Symbol("end");

/** One session as the host follows it. */
export interface Live {
  readonly request: SessionRequest;
  readonly options: SessionOptions;
  readonly queue: Queue.Queue<AgentStreamEvent | typeof END>;
  readonly started: Deferred.Deferred<true>;
  readonly ended: Deferred.Deferred<SessionOutcome, Ended>;
  /** The host sinks running on the session's record, once it has arrived. */
  sinking?: Promise<void>;
  /** Set once `ended` is: the session has ended for its caller. */
  over: boolean;
}

/** What the host shares across a sandbox's sessions. */
export interface Shared {
  readonly link: SupervisorLink;
  /** Aborted at a detach, ending every session's reply stream. */
  readonly letGo: AbortController;
  /** Set once the handle has detached. */
  detached?: SandboxDetachedError;
}

/** Ends the session for its caller; a no-op once it has ended. */
export const endLive = (
  live: Live,
  exit: Exit.Exit<SessionOutcome, Ended>,
): void => {
  live.over = true;
  Deferred.unsafeDone(live.ended, exit);
};

/** The process handle for a session that's following `live`. */
export const sessionProcess = (
  shared: Shared,
  live: Live,
  output: OutputDefinition | undefined,
): SessionProcess => {
  let killing: Promise<void> | undefined;
  let result: Promise<SessionResult> | undefined;
  const { request } = live;
  return {
    name: request.name,
    events: Stream.fromQueue(live.queue).pipe(
      Stream.takeWhile((item): item is AgentStreamEvent => item !== END),
      Stream.toAsyncIterable,
    ),
    wait: async () => {
      result ??= Effect.runPromise(Effect.either(Deferred.await(live.ended)))
        .then((ended) => {
          if (ended._tag === "Right") {
            return ended.right;
          }
          const error = ended.left;
          if (error._tag === "RecordSinkFailed") {
            throw error.cause;
          }
          throw error._tag === "SupervisorLost"
            ? lostSession(request, error.cause)
            : error;
        })
        .then(async (outcome) => sessionResult(request, outcome, output));
      return result;
    },
    kill: async () => {
      if (shared.detached !== undefined) {
        throw shared.detached;
      }
      killing ??= shared.link
        .call({ type: "kill", id: request.id }, () => undefined)
        .catch(() => undefined);
      await killing;
    },
    send: async (sendOptions) => {
      if (shared.detached !== undefined) {
        throw shared.detached;
      }
      return sendTo(shared.link, { id: request.id }, sendOptions);
    },
  };
};
