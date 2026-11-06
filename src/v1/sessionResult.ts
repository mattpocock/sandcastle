import type { OutputDefinition } from "./Output.js";
import type { SessionResult } from "./Session.js";
import { SessionFailedError } from "./SessionFailedError.js";
import { StructuredOutputError } from "./StructuredOutputError.js";
import type { SessionOutcome, SessionRequest } from "./supervisorProtocol.js";

// Host side, once a session has ended: its result, or the error to reject
// with. Structured output is validated here, where the schema lives.

/** The error for a session that didn't succeed. */
export const sessionFailure = (
  request: SessionRequest,
  outcome: SessionOutcome,
): SessionFailedError | undefined => {
  const { exitReason } = outcome;
  if (exitReason === "completed" || exitReason === "closing-tag") {
    return undefined;
  }
  return new SessionFailedError({
    message: `Session "${request.name}" ${outcome.started ? "failed" : "could not start"}: ${outcome.message}`,
    sessionName: request.name,
    // Only work carried on past a detach meets its deadline, and the handle
    // that held it has let go by then.
    exitReason: exitReason === "time-limit" ? "aborted" : exitReason,
    started: outcome.started,
    outputTail: outcome.outputTail,
    ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
    ...(outcome.sessionId === undefined
      ? {}
      : { sessionId: outcome.sessionId }),
  });
};

/** The error for a session whose supervisor stopped answering. */
export const lostSession = (
  request: SessionRequest,
  cause: unknown,
): SessionFailedError =>
  new SessionFailedError({
    message: `Session "${request.name}" lost its session supervisor: ${cause instanceof Error ? cause.message : String(cause)}`,
    sessionName: request.name,
    exitReason: "failed",
    started: false,
    outputTail: "",
    cause,
  });

const structuredOutput = async (
  request: SessionRequest,
  outcome: SessionOutcome,
  definition: OutputDefinition | undefined,
): Promise<unknown> => {
  const extracted = outcome.output;
  if (definition === undefined || extracted === undefined) {
    return undefined;
  }
  const context = {
    sessionName: request.name,
    tag: definition.tag,
    ...(outcome.sessionId === undefined
      ? {}
      : { sessionId: outcome.sessionId }),
  };
  if (!extracted.found) {
    throw new StructuredOutputError({
      message: extracted.problem,
      ...context,
      ...(extracted.raw === undefined ? {} : { rawMatched: extracted.raw }),
    });
  }
  if (definition._tag === "string") {
    return extracted.value;
  }
  const validated = await definition.schema["~standard"].validate(
    extracted.value,
  );
  if (validated.issues !== undefined) {
    throw new StructuredOutputError({
      message: `Structured output tag <${definition.tag}> failed schema validation`,
      ...context,
      rawMatched: extracted.raw,
      cause: validated.issues,
    });
  }
  return validated.value;
};

/** The session's result; rejects with `SessionFailedError` or `StructuredOutputError`. */
export const sessionResult = async (
  request: SessionRequest,
  outcome: SessionOutcome,
  definition: OutputDefinition | undefined,
): Promise<SessionResult> => {
  const failure = sessionFailure(request, outcome);
  if (failure !== undefined) {
    throw failure;
  }
  const output = await structuredOutput(request, outcome, definition);
  return {
    name: request.name,
    agent: request.agent.id,
    workingDirectory: request.workingDirectory,
    exitReason:
      outcome.exitReason === "closing-tag" ? "closing-tag" : "completed",
    finalMessage: outcome.finalMessage,
    output,
    outputTail: outcome.outputTail,
    ...(outcome.sessionId === undefined
      ? {}
      : { sessionId: outcome.sessionId }),
    ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
    ...(outcome.contextWindow === undefined
      ? {}
      : { contextWindow: outcome.contextWindow }),
  };
};

/** A session whose abort signal fired before it was spawned. */
export const abortedBeforeStart = (name: string): SessionFailedError =>
  new SessionFailedError({
    message: `Session "${name}" was aborted before it started`,
    sessionName: name,
    exitReason: "aborted",
    started: false,
    outputTail: "",
  });
