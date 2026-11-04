import type {
  FailedDetachedWork,
  FinishReport,
  SessionReport,
} from "./FinishReport.js";
import type {
  DetachRequest,
  SessionOutcome,
  SessionRequest,
} from "./supervisorProtocol.js";

// Inside the sandbox, once the last carried-on session has ended: the finish
// report, built from each session's outcome in the order they ended.

/** A carried-on session that has ended. */
export interface EndedSession {
  readonly request: SessionRequest;
  readonly outcome: SessionOutcome;
}

type Failure = FailedDetachedWork["failure"];

const sessionReport = ({ request, outcome }: EndedSession): SessionReport => ({
  name: request.name,
  agent: request.agent.id,
  ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }),
  exitReason: outcome.exitReason,
  ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
  ...(outcome.contextWindow === undefined
    ? {}
    : { contextWindow: outcome.contextWindow }),
  output: outcome.output?.found === true ? outcome.output.value : undefined,
  finalMessage: outcome.finalMessage,
  outputTail: outcome.outputTail,
  ...(outcome.record === undefined ? {} : { record: outcome.record }),
});

const REASONS = {
  failed: "session-failed",
  aborted: "session-failed",
  "idle-timeout": "idle-timeout",
  "time-limit": "time-limit",
} as const;

/** How a session failed, if it did. */
const failureOf = ({ request, outcome }: EndedSession): Failure | undefined => {
  const { exitReason } = outcome;
  const { name } = request;
  if (exitReason === "completed" || exitReason === "closing-tag") {
    return outcome.output?.found === false
      ? {
          reason: "structured-output-invalid",
          message: `Session "${name}": ${outcome.output.problem}`,
          name,
        }
      : undefined;
  }
  return {
    reason: REASONS[exitReason],
    message: `Session "${name}": ${outcome.message}`,
    name,
  };
};

/** The finish report for a detach whose sessions have all ended, in the order given. */
export const buildFinishReport = (
  request: DetachRequest,
  ended: readonly EndedSession[],
  timestamp: string,
): FinishReport => {
  const base = {
    sandboxId: request.sandboxId,
    detachId: request.detachId,
    sessions: Object.fromEntries(
      ended.map((session) => [session.request.name, sessionReport(session)]),
    ),
    processes: [],
  };
  const failure = ended
    .map((session) => failureOf(session))
    .find((found) => found !== undefined);
  return {
    type: "sandcastle.detached.finished",
    timestamp,
    data:
      failure === undefined
        ? { ...base, status: "succeeded" }
        : { ...base, status: "failed", failure },
  };
};
