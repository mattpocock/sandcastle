import { Data, Deferred, Effect, Exit, FiberId, Queue, Stream } from "effect";
import type { OutputDefinition } from "./Output.js";
import type {
  AgentStreamEvent,
  SessionOptions,
  SessionProcess,
  SessionResult,
} from "./Session.js";
import type { SandboxDetachedError } from "./SandboxDetachedError.js";
import { SessionFailedError } from "./SessionFailedError.js";
import { startHostSinks, whenSunk } from "./recordHostSinks.js";
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

/** A host sink (directory or function) failed on the session's record. */
class RecordSinkFailed extends Data.TaggedError("RecordSinkFailed")<{
  readonly cause: unknown;
}> {}

type Ended = SupervisorLost | RecordSinkFailed | SandboxDetachedError;

const END = Symbol("end");

/** One session as the host follows it. */
interface Live {
  readonly request: SessionRequest;
  readonly options: SessionOptions;
  readonly queue: Queue.Queue<AgentStreamEvent | typeof END>;
  readonly started: Deferred.Deferred<true>;
  readonly ended: Deferred.Deferred<SessionOutcome, Ended>;
  /** The host sinks running on the session's record, once it has arrived. */
  sinking?: Promise<void>;
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
    } else if (reply.type === "record") {
      live.sinking = startHostSinks(live.options.record, reply.record);
    } else if (reply.type === "ended") {
      // The session ends for the host once its host sinks are done.
      const { outcome } = reply;
      whenSunk(live.sinking, (failure) => {
        Deferred.unsafeDone(
          live.ended,
          failure === undefined
            ? Exit.succeed(outcome)
            : Exit.fail(new RecordSinkFailed(failure)),
        );
      });
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
  // The host sinks settle `ended` themselves.
  await live.sinking?.catch(() => undefined);
  // A no-op when the session has already ended.
  Deferred.unsafeDone(live.ended, Exit.fail(new SupervisorLost({ cause })));
  Queue.unsafeOffer(live.queue, END);
};

const start = (
  request: SessionRequest,
  options: SessionOptions,
): Effect.Effect<Live> =>
  Effect.map(Queue.unbounded<AgentStreamEvent | typeof END>(), (queue) => ({
    request,
    options,
    queue,
    started: Deferred.unsafeMake<true>(FiberId.none),
    ended: Deferred.unsafeMake<SessionOutcome, Ended>(FiberId.none),
  }));

/** Succeeds once the agent has started, or once it ended without starting. */
const startedOrEnded = (live: Live): Effect.Effect<"started" | "ended"> =>
  Effect.raceFirst(
    Effect.as(Deferred.await(live.started), "started" as const),
    Effect.as(Effect.either(Deferred.await(live.ended)), "ended" as const),
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
  running: Running,
  error: SandboxDetachedError,
): void => {
  shared.detached = error;
  for (const live of running.values()) {
    if (live === "starting") {
      continue;
    }
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

/** A session's name is taken from the moment its spawn is accepted ("starting") until the supervisor's answer for it is over, or its spawn fails. */
type Running = Map<string, Live | "starting">;

const free = (running: Running, name: string, slot: Live | "starting") => {
  if (running.get(name) === slot) {
    running.delete(name);
  }
};

/** `spawnSession()` for one sandbox. */
const spawner = (
  shared: Shared,
  running: Running,
  context: Omit<Parameters<typeof sessionRequest>[1], "name">,
) => {
  let count = 0;
  return async (options: SessionOptions): Promise<SessionProcess> => {
    count += 1;
    const name = options.name ?? `session-${count}`;
    if (running.has(name)) {
      throw new TypeError(
        `session: a session named "${name}" is already running`,
      );
    }
    const request = sessionRequest(options, { ...context, name });
    if (options.abortSignal?.aborted === true) {
      throw abortedBeforeStart(name);
    }
    // Taken before the first await, so a second spawn of the name is refused.
    let slot: Live | "starting" = "starting";
    running.set(name, slot);
    try {
      const { spawned, how } = await Effect.gen(function* () {
        const live = yield* start(request, options);
        slot = live;
        running.set(name, live);
        void follow(shared, live).finally(() => {
          free(running, name, live);
        });
        const process = sessionProcess(shared, live, options.output);
        killOnAbort(process, options.abortSignal);
        return { spawned: process, how: yield* startedOrEnded(live) };
      }).pipe(Effect.runPromise);
      if (how === "ended") {
        // It ended before printing anything: if it failed, it couldn't start.
        await spawned.wait();
      }
      return spawned;
    } catch (error) {
      free(running, name, slot);
      throw error;
    }
  };
};

/** `session()` and `spawnSession()` for one sandbox. */
export const sessionHost = (
  link: SupervisorLink,
  context: Omit<Parameters<typeof sessionRequest>[1], "name">,
) => {
  const running: Running = new Map();
  const shared: Shared = { link, letGo: new AbortController() };
  const spawnSession = spawner(shared, running, context);

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
