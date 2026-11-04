import { Effect } from "effect";
import type { AgentProvider } from "../AgentProvider.js";
import type { StreamState } from "./sessionStream.js";
import { extractOutput, finalMessage } from "./sessionStream.js";
import { sessionUsage } from "./sessionUsage.js";
import type { SessionOutcome, SessionRequest } from "./supervisorProtocol.js";

// Inside the sandbox: turns how a session's stream ended into the outcome
// the host gets, with the agent's final message, usage and structured output.

/** How the agent's stream stopped. */
export type StreamEnd =
  | { readonly reason: "exit"; readonly code: number; readonly error?: string }
  | { readonly reason: "idle-timeout" | "closing-tag" | "aborted" };

/** What watching the stream found. */
export interface Watched {
  readonly stream: StreamState;
  readonly started: boolean;
  readonly end: StreamEnd;
}

interface Ended {
  readonly request: SessionRequest;
  readonly agent: AgentProvider;
  /** The last of what the agent printed. */
  readonly tail: () => string;
}

const seconds = (ms: number): string => `${ms / 1000} seconds`;

const lastLines = (text: string): string =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-20)
    .join("\n");

/** The exit reason and message for how the stream ended. */
const verdict = (
  ended: Ended,
  watched: Watched,
): Pick<SessionOutcome, "exitReason" | "message" | "exitCode"> => {
  const { end, stream } = watched;
  const { name } = ended.agent;
  switch (end.reason) {
    case "idle-timeout": {
      return {
        exitReason: "idle-timeout",
        message: `Agent idle for ${seconds(ended.request.idleTimeoutMs)}: no output received. Increase idleTimeoutSeconds to allow longer silences.`,
      };
    }
    case "closing-tag": {
      return {
        exitReason: "closing-tag",
        message: `The agent printed its closing tag, then nothing for ${seconds(ended.request.completionTimeoutMs)}, so its process was stopped.`,
      };
    }
    case "aborted": {
      return { exitReason: "aborted", message: "The session was stopped." };
    }
    case "exit": {
      if (end.code !== 0) {
        const detail =
          end.error ?? stream.streamError ?? lastLines(ended.tail());
        return {
          exitReason: "failed",
          exitCode: end.code,
          message: `${name} exited with code ${end.code}:\n${detail}`,
        };
      }
      return stream.streamError === undefined
        ? { exitReason: "completed", exitCode: 0, message: "" }
        : {
            exitReason: "failed",
            exitCode: 0,
            message: `${name} reported an error:\n${stream.streamError}`,
          };
    }
  }
};

/** Everything the host gets about a session that has ended. */
export const sessionOutcome = (
  ended: Ended,
  watched: Watched,
): Effect.Effect<SessionOutcome> =>
  Effect.gen(function* () {
    const { request } = ended;
    const { stream } = watched;
    const result = verdict(ended, watched);
    const succeeded =
      result.exitReason === "completed" || result.exitReason === "closing-tag";
    const usage = succeeded
      ? yield* sessionUsage(ended.agent, request.workingDirectory, stream)
      : undefined;
    return {
      ...result,
      started: watched.started,
      finalMessage: finalMessage(stream),
      outputTail: ended.tail(),
      ...(stream.sessionId === undefined
        ? {}
        : { sessionId: stream.sessionId }),
      ...(usage === undefined ? {} : { usage }),
      ...(stream.contextWindow === undefined
        ? {}
        : { contextWindow: stream.contextWindow }),
      ...(succeeded && request.output !== undefined
        ? { output: extractOutput(stream.text, request.output) }
        : {}),
    };
  });
