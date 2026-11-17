import { Deferred, Effect, Exit, FiberId, Queue } from "effect";
import type {
  AgentStreamEvent,
  SessionOptions,
  SessionProcess,
  SessionResult,
} from "./Session.js";
import type { SandboxDetachedError } from "./SandboxDetachedError.js";
import { startHostSinks, whenSunk } from "./recordHostSinks.js";
import { sessionRequest } from "./sessionRequest.js";
import { abortedBeforeStart } from "./sessionResult.js";
import type { Ended, Live, Shared } from "./sessionLive.js";
import {
  END,
  endLive,
  RecordSinkFailed,
  sessionProcess,
  SupervisorLost,
} from "./sessionLive.js";
import type { SupervisorLink } from "./supervisorHost.js";
import type {
  Reply,
  SessionOutcome,
  SessionRequest,
} from "./supervisorProtocol.js";

// Host side of `session()` and `spawnSession()`: one supervisor request per
// session, whose replies say when the agent has started, what it does, and
// how it ended.

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
        endLive(
          live,
          failure === undefined
            ? Exit.succeed(outcome)
            : Exit.fail(new RecordSinkFailed(failure)),
        );
      });
    } else if (reply.type === "error") {
      const cause = new Error(reply.message);
      endLive(live, Exit.fail(new SupervisorLost({ cause })));
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
  endLive(live, Exit.fail(new SupervisorLost({ cause })));
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
    over: false,
  }));

/** Succeeds once the agent has started, or once it ended without starting. */
const startedOrEnded = (live: Live): Effect.Effect<"started" | "ended"> =>
  Effect.raceFirst(
    Effect.as(Deferred.await(live.started), "started" as const),
    Effect.as(Effect.either(Deferred.await(live.ended)), "ended" as const),
  );

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
    endLive(live, Exit.fail(error));
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

/** Where the sandbox's sessions run; the supervisor's key comes from its link. */
interface SessionContext {
  readonly workingDirectory: string;
  readonly record: Omit<
    Parameters<typeof sessionRequest>[1]["record"],
    "publicKey"
  >;
}

/** A session's name is taken from the moment its spawn is accepted ("starting") until the supervisor's answer for it is over, or its spawn fails. */
type Running = Map<string, Live | "starting">;

const free = (running: Running, name: string, slot: Live | "starting") => {
  if (running.get(name) === slot) {
    running.delete(name);
  }
};

/** `spawnSession()` for one sandbox. */
const spawner = (shared: Shared, running: Running, context: SessionContext) => {
  let count = 0;
  return async (options: SessionOptions): Promise<SessionProcess> => {
    count += 1;
    const name = options.name ?? `session-${count}`;
    // Before the name is checked and taken, so no await comes between them.
    const publicKey = await shared.link.publicKey();
    if (running.has(name)) {
      throw new TypeError(
        `session: a session named "${name}" is already running`,
      );
    }
    const request = sessionRequest(options, {
      ...context,
      name,
      record: { ...context.record, publicKey },
    });
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
export const sessionHost = (link: SupervisorLink, context: SessionContext) => {
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
    /** Whether a session of this name is starting, or hasn't ended for its caller. The host holds a name a little past its `wait()`, until the supervisor's answer is over. */
    isRunning: (name: string) => {
      const slot = running.get(name);
      return slot === "starting" || (slot !== undefined && !slot.over);
    },
  };
};
