import type { WriteStream } from "node:fs";
import { Duration, Effect, Option, Queue } from "effect";
import type { AgentProvider } from "../AgentProvider.js";
import { shellEscape } from "../AgentProvider.js";
import type { AgentProcess } from "./agentProcess.js";
import { startAgentProcess } from "./agentProcess.js";
import type { StreamState } from "./sessionStream.js";
import { applyEvents, emptyStream } from "./sessionStream.js";
import type { StreamEnd, Watched } from "./sessionOutcome.js";
import { sessionOutcome } from "./sessionOutcome.js";
import type {
  Reply,
  SessionOutcome,
  SessionRequest,
} from "./supervisorProtocol.js";

// One agent session inside the sandbox: start the agent, read its stream,
// and end it on exit, on kill, on the idle timeout, or, once the output's
// closing tag has appeared, when it goes quiet for the completion timeout
// (ADR 0019 and 0021: a process that printed its result and hangs succeeds).

/** A session the supervisor is running. */
export interface RunningSession {
  /** Stops the agent; the outcome's exit reason is then `reason`. */
  readonly kill: (reason: "aborted" | "time-limit") => Effect.Effect<void>;
  /** Resolves once the session has ended. */
  readonly outcome: Effect.Effect<SessionOutcome>;
}

interface Context {
  readonly request: SessionRequest;
  readonly agent: AgentProvider;
  readonly process: AgentProcess;
  readonly emit: (reply: Reply) => void;
  /** The output's closing tag, which arms the completion timeout. */
  readonly trigger: string | undefined;
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
  const applied = applyEvents(stream, context.agent.parseStreamLine(line));
  for (const event of applied.visible) {
    context.emit({ type: "event", event });
  }
  return applied.state;
};

/** Reads the agent's stream until it ends, one way or another. */
const watch = (context: Context): Effect.Effect<Watched> =>
  Effect.gen(function* () {
    let stream = emptyStream;
    let started = false;
    let triggered = false;
    while (true) {
      const waitMs = triggered
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
      if (item._tag === "kill") {
        return yield* stopped(
          context,
          { stream, started },
          { reason: item.reason },
        );
      }
      if (item._tag === "exit") {
        return { stream, started, end: { reason: "exit", ...item } };
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

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** `export K='v'; …` for the agent's and the session's env, then the command. */
const withEnv = (
  env: Readonly<Record<string, string>>,
  command: string,
): string =>
  Object.entries(env)
    .filter(([key]) => ENV_KEY.test(key))
    .map(([key, value]) => `export ${key}=${shellEscape(value)}; `)
    .join("") + command;

const agentEnv = (options: Readonly<Record<string, unknown>>) => {
  const { env } = options;
  if (typeof env !== "object" || env === null) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
};

/** Starts the session's agent; `outcome` resolves once it has ended. */
export const startSession = (options: {
  readonly request: SessionRequest;
  readonly agent: AgentProvider;
  /** Turns the agent's real command into the one to run (a fake agent replays instead). */
  readonly command: (realCommand: string) => string;
  readonly log: WriteStream;
  readonly emit: (reply: Reply) => void;
}): Effect.Effect<RunningSession> =>
  Effect.gen(function* () {
    const { request, agent } = options;
    const print = agent.buildPrintCommand({
      prompt: request.prompt,
      dangerouslySkipPermissions: true,
      ...(request.resumeSessionId === undefined
        ? {}
        : { resumeSession: request.resumeSessionId }),
    });
    const env = { ...agentEnv(request.agent.options), ...request.env };
    const process = yield* startAgentProcess({
      command: withEnv(env, options.command(print.command)),
      workingDirectory: request.workingDirectory,
      stdin: print.stdin,
      log: options.log,
    });
    const context: Context = {
      request,
      agent,
      process,
      emit: options.emit,
      trigger:
        request.output === undefined ? undefined : `</${request.output.tag}>`,
    };
    const outcome = yield* watch(context).pipe(
      Effect.flatMap((watched) =>
        sessionOutcome({ request, agent, tail: process.tail }, watched),
      ),
      Effect.cached,
    );
    return {
      kill: (reason) =>
        Queue.offer(process.items, { _tag: "kill", reason }).pipe(
          Effect.asVoid,
        ),
      outcome,
    };
  });
