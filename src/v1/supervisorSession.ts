import { Clock, DateTime, Duration, Effect, Option, Queue } from "effect";
import type { AgentProvider } from "../AgentProvider.js";
import type { AgentItem, AgentProcess } from "./agentProcess.js";
import type { RecordedEvent } from "./SessionRecord.js";
import type { StreamState } from "./sessionStream.js";
import { applyEvents, emptyStream } from "./sessionStream.js";
import type { StreamEnd, Watched } from "./sessionOutcome.js";
import { sessionOutcome } from "./sessionOutcome.js";
import type { Recording } from "./supervisorRecord.js";
import { liveRedactor, recordSession } from "./supervisorRecord.js";
import type { InputState } from "./supervisorInput.js";
import {
  closeInput,
  inputState,
  inputTo,
  observeInput,
  unread,
} from "./supervisorInput.js";
import type { LaunchOptions } from "./supervisorLaunch.js";
import { launchAgent } from "./supervisorLaunch.js";
import type {
  InputRequest,
  Reply,
  SessionOutcome,
  SessionRequest,
} from "./supervisorProtocol.js";

// One agent session inside the sandbox: start the agent, read its stream,
// and end it on exit, on kill, on the idle timeout, or, once the output's
// closing tag has appeared, when it goes quiet for the completion timeout
// (ADR 0019 and 0021: a process that printed its result and hangs succeeds).
// An agent that takes input keeps its stdin open for messages (ADR 0032).

/** A session the supervisor is running. */
export interface RunningSession {
  /** Stops the agent; the outcome's exit reason is then `reason`. */
  readonly kill: (reason: "aborted" | "time-limit") => Effect.Effect<void>;
  /** Resolves once the session has ended. */
  readonly outcome: Effect.Effect<SessionOutcome>;
  /** Hands the agent a message; the reply says whether it went. */
  readonly input: (request: InputRequest) => Effect.Effect<Reply>;
}

interface Context {
  readonly request: SessionRequest;
  readonly agent: AgentProvider;
  readonly process: AgentProcess;
  readonly emit: (reply: Reply) => void;
  /** The output's closing tag, which arms the completion timeout. */
  readonly trigger: string | undefined;
  /** Every event the user sees, timestamped, for the session's record. */
  readonly events: RecordedEvent[];
  /** Appends an event to the session's events file, redacted, for `follow()`. */
  readonly follow: (event: RecordedEvent) => void;
  /** The messages written to the agent and read by it. */
  readonly input: InputState;
}

const stopped = (
  context: Context,
  watched: Omit<Watched, "end">,
  end: StreamEnd,
): Effect.Effect<Watched> =>
  Effect.as(context.process.killGroup, { ...watched, end });

/** Folds one stdout line into the stream, sending the events the user sees. */
const readLine = (
  context: Context,
  stream: StreamState,
  line: string,
): StreamState => {
  observeInput(context.input, context.process, line);
  const applied = applyEvents(stream, context.agent.parseStreamLine(line));
  const at = DateTime.formatIso(DateTime.unsafeNow());
  for (const event of applied.visible) {
    context.emit({ type: "event", event });
    context.events.push({ ...event, at });
    context.follow({ ...event, at });
  }
  return applied.state;
};

/** How the stream ends on the agent's exit, or on a kill. */
const endedBy = (
  context: Context,
  watched: Omit<Watched, "end">,
  item: Extract<AgentItem, { _tag: "exit" | "kill" }>,
): Effect.Effect<Watched> =>
  item._tag === "kill"
    ? stopped(context, watched, { reason: item.reason })
    : Effect.succeed({ ...watched, end: { reason: "exit", ...item } });

/** Reads the agent's stream until it ends, one way or another. */
const watch = (context: Context): Effect.Effect<Watched> =>
  Effect.gen(function* () {
    let stream = emptyStream;
    let started = false;
    let triggered = false;
    while (true) {
      // A message the agent hasn't read yet holds the completion timeout off:
      // it may well start more work.
      const waitMs =
        triggered && unread(context.input) <= 0
          ? context.request.completionTimeoutMs
          : context.request.idleTimeoutMs;
      const next = yield* Queue.take(context.process.items).pipe(
        Effect.timeoutOption(Duration.millis(waitMs)),
      );
      if (Option.isNone(next)) {
        const reason = triggered ? "closing-tag" : "idle-timeout";
        return yield* stopped(context, { stream, started }, { reason });
      }
      const item = next.value;
      if (item._tag === "input") {
        continue;
      }
      if (item._tag !== "line") {
        return yield* endedBy(context, { stream, started }, item);
      }
      if (!started) {
        started = true;
        context.emit({ type: "started" });
      }
      stream = readLine(context, stream, item.line);
      triggered ||=
        context.trigger !== undefined && stream.text.includes(context.trigger);
    }
  });

/** What starting a session needs. */
export interface StartOptions extends LaunchOptions {
  /** The session's events file, one redacted event per line. */
  readonly eventsLog: LaunchOptions["log"];
  readonly emit: (reply: Reply) => void;
  /** The record's upload URL and webhook secret, opened. */
  readonly secrets: Recording["secrets"];
  /** The detach the session is carried on under, if any. */
  readonly detachId: () => string | undefined;
}

/** What reading a just-started agent's stream needs. */
const sessionContext = (
  options: StartOptions,
  process: AgentProcess,
  env: Readonly<Record<string, string>>,
): Effect.Effect<Context> =>
  Effect.gen(function* () {
    const { request } = options;
    const redact = yield* liveRedactor(request, env);
    return {
      request,
      agent: options.agent,
      process,
      emit: options.emit,
      trigger:
        request.output === undefined ? undefined : `</${request.output.tag}>`,
      events: [],
      follow: (event) => {
        options.eventsLog.write(`${JSON.stringify(redact(event))}\n`);
      },
      input: yield* inputState(request.agent.id),
    };
  });

/** Starts the session's agent; `outcome` resolves once it has ended. */
export const startSession = (
  options: StartOptions,
): Effect.Effect<RunningSession> =>
  Effect.gen(function* () {
    const { request, agent } = options;
    const startedMs = yield* Clock.currentTimeMillis;
    const { process, env } = yield* launchAgent(options);
    const context = yield* sessionContext(options, process, env);
    const { input } = context;
    const recording: Recording = {
      request,
      secrets: options.secrets,
      events: context.events,
      startedAt: DateTime.formatIso(DateTime.unsafeMake(startedMs)),
      killAtMs: startedMs + (request.record?.killInMs ?? 0),
      sessionEnv: env,
      detachId: options.detachId,
      emit: options.emit,
    };
    const outcome = yield* watch(context).pipe(
      Effect.tap(() => {
        closeInput(input);
      }),
      Effect.flatMap((watched) =>
        sessionOutcome({ request, agent, tail: process.tail }, watched),
      ),
      Effect.flatMap((ended) => recordSession(recording, ended)),
      Effect.cached,
    );
    return {
      kill: (reason) =>
        Queue.offer(process.items, { _tag: "kill", reason }).pipe(
          Effect.asVoid,
        ),
      outcome,
      input: inputTo({
        state: input,
        process,
        request,
        record: (event) => {
          context.events.push(event);
          context.follow(event);
        },
      }),
    };
  });
