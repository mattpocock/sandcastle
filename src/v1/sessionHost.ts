import { Data, Deferred, Effect, Exit, FiberId, Queue, Stream } from "effect";
import type { OutputDefinition } from "../Output.js";
import type {
  AgentStreamEvent,
  SessionOptions,
  SessionProcess,
  SessionResult,
} from "./Session.js";
import type { SandboxDetachedError } from "./SandboxDetachedError.js";
import { SessionFailedError } from "./SessionFailedError.js";
import { sessionRequest } from "./sessionRequest.js";
import { lostSession, sessionResult } from "./sessionResult.js";
import type { SupervisorLink } from "./supervisorHost.js";
import type {
  Reply,
  SessionOutcome,
  SessionRequest,
} from "./supervisorProtocol.js";

// Host side of `session()` and `spawnSession()`: one supervisor request per
// session, whose replies say when the agent has started, what it does, and
// how it ended.

/** The supervisor stopped answering before the session ended. */
class SupervisorLost extends Data.TaggedError("SupervisorLost")<{
  readonly cause: unknown;
}> {}

const END = Symbol("end");

/** One session as the host follows it. */
interface Live {
  readonly request: SessionRequest;
  readonly queue: Queue.Queue<AgentStreamEvent | typeof END>;
  readonly started: Deferred.Deferred<true>;
  readonly ended: Deferred.Deferred<
    SessionOutcome,
    SupervisorLost | SandboxDetachedError
  >;
}

/** What the host shares across a sandbox's sessions. */
interface Shared {
  readonly link: SupervisorLink;
  /** Aborted at a detach, ending every session's reply stream. */
  readonly letGo: AbortController;
  /** Set once the handle has detached. */
  detached?: SandboxDetachedError;
}

const onReply =
  (live: Live) =>
  (reply: Reply): void => {
    if (reply.type === "started") {
      Deferred.unsafeDone(live.started, Exit.succeed(true));
    } else if (reply.type === "event") {
      Queue.unsafeOffer(live.queue, reply.event);
    } else if (reply.type === "ended") {
      Deferred.unsafeDone(live.ended, Exit.succeed(reply.outcome));
    } else if (reply.type === "error") {
      const cause = new Error(reply.message);
      Deferred.unsafeDone(live.ended, Exit.fail(new SupervisorLost({ cause })));
    }
  };

/** Sends the session's request; resolves once the supervisor's answer is over. */
const follow = async (shared: Shared, live: Live): Promise<void> => {
  let cause: unknown = new Error(
    "the session supervisor ended the session without a result",
  );
  try {
    await shared.link.call(live.request, onReply(live), shared.letGo.signal);
  } catch (error) {
    cause = error;
  }
  // A no-op when the session has already ended.
  Deferred.unsafeDone(live.ended, Exit.fail(new SupervisorLost({ cause })));
  Queue.unsafeOffer(live.queue, END);
};

const start = async (request: SessionRequest): Promise<Live> => ({
  request,
  queue: await Effect.runPromise(
    Queue.unbounded<AgentStreamEvent | typeof END>(),
  ),
  started: Deferred.unsafeMake<true>(FiberId.none),
  ended: Deferred.unsafeMake<
    SessionOutcome,
    SupervisorLost | SandboxDetachedError
  >(FiberId.none),
});

/** Resolves once the agent has started, or once it ended without starting. */
const startedOrEnded = async (live: Live): Promise<"started" | "ended"> =>
  Effect.runPromise(
    Effect.raceFirst(
      Effect.as(Deferred.await(live.started), "started" as const),
      Effect.as(Effect.either(Deferred.await(live.ended)), "ended" as const),
    ),
  );

/** The process handle for a session that's following `live`. */
const sessionProcess = (
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
  };
};

const abortedBeforeStart = (name: string): SessionFailedError =>
  new SessionFailedError({
    message: `Session "${name}" was aborted before it started`,
    sessionName: name,
    exitReason: "aborted",
    started: false,
    outputTail: "",
  });

/**
 * Lets go of every session after a detach: their `wait()` and `kill()`
 * reject with `error`, their events end, and their reply streams close.
 * The supervisor carries them on.
 */
const letGo = (
  shared: Shared,
  running: ReadonlyMap<string, Live>,
  error: SandboxDetachedError,
): void => {
  shared.detached = error;
  for (const live of running.values()) {
    Deferred.unsafeDone(live.ended, Exit.fail(error));
    Queue.unsafeOffer(live.queue, END);
  }
  shared.letGo.abort();
};

/** Stops the session when `signal` aborts; after a detach, there's nothing to stop. */
const killOnAbort = (
  spawned: SessionProcess,
  signal: AbortSignal | undefined,
): void => {
  signal?.addEventListener(
    "abort",
    () => {
      void spawned.kill().catch(() => undefined);
    },
    { once: true },
  );
};

/** `session()` and `spawnSession()` for one sandbox. */
export const sessionHost = (link: SupervisorLink, workingDirectory: string) => {
  let count = 0;
  const running = new Map<string, Live>();
  const shared: Shared = { link, letGo: new AbortController() };

  const spawnSession = async (
    options: SessionOptions,
  ): Promise<SessionProcess> => {
    count += 1;
    const name = options.name ?? `session-${count}`;
    if (running.has(name)) {
      throw new TypeError(
        `session: a session named "${name}" is already running`,
      );
    }
    const request = sessionRequest(options, { name, workingDirectory });
    if (options.abortSignal?.aborted === true) {
      throw abortedBeforeStart(name);
    }
    const live = await start(request);
    running.set(name, live);
    void follow(shared, live).finally(() => {
      running.delete(name);
    });
    const spawned = sessionProcess(shared, live, options.output);
    killOnAbort(spawned, options.abortSignal);
    if ((await startedOrEnded(live)) === "ended") {
      // It ended before printing anything: if it failed, it couldn't start.
      await spawned.wait();
    }
    return spawned;
  };

  const session = async (options: SessionOptions): Promise<SessionResult> =>
    spawnSession(options).then(async (spawned) => spawned.wait());

  return {
    spawnSession,
    session,
    letGo: (error: SandboxDetachedError) => {
      letGo(shared, running, error);
    },
    /** How many sessions the host is following. */
    runningCount: () => running.size,
  };
};
