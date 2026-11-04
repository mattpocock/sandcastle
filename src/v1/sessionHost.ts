import { Data, Deferred, Effect, Exit, FiberId, Queue, Stream } from "effect";
import type { OutputDefinition } from "../Output.js";
import type {
  AgentStreamEvent,
  SessionOptions,
  SessionProcess,
  SessionResult,
} from "./Session.js";
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
  readonly ended: Deferred.Deferred<SessionOutcome, SupervisorLost>;
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
const follow = async (link: SupervisorLink, live: Live): Promise<void> => {
  let cause: unknown = new Error(
    "the session supervisor ended the session without a result",
  );
  try {
    await link.call(live.request, onReply(live));
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
  ended: Deferred.unsafeMake<SessionOutcome, SupervisorLost>(FiberId.none),
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
  link: SupervisorLink,
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
      result ??= Effect.runPromise(
        Deferred.await(live.ended).pipe(
          Effect.mapError((lost) => lostSession(request, lost.cause)),
        ),
      ).then(async (outcome) => sessionResult(request, outcome, output));
      return result;
    },
    kill: async () => {
      killing ??= link
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

/** `session()` and `spawnSession()` for one sandbox. */
export const sessionHost = (link: SupervisorLink, workingDirectory: string) => {
  let count = 0;
  const running = new Set<string>();

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
    running.add(name);
    const live = await start(request);
    void follow(link, live).finally(() => {
      running.delete(name);
    });
    const spawned = sessionProcess(link, live, options.output);
    options.abortSignal?.addEventListener(
      "abort",
      () => {
        void spawned.kill();
      },
      { once: true },
    );
    if ((await startedOrEnded(live)) === "ended") {
      // It ended before printing anything: if it failed, it couldn't start.
      await spawned.wait();
    }
    return spawned;
  };

  const session = async (options: SessionOptions): Promise<SessionResult> =>
    spawnSession(options).then(async (spawned) => spawned.wait());

  return { spawnSession, session };
};
