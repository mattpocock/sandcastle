import type { Redact } from "./redaction.js";
import type { RecordedEvent, SessionRecord } from "./SessionRecord.js";
import type { RecordRequest } from "./sessionRecordSchema.js";
import type { SessionOutcome, SessionRequest } from "./supervisorProtocol.js";

// Inside the sandbox, once a session has ended: its record, redacted. Pure:
// the supervisor gathers the parts and sends what this returns.

/** Everything a record is made of. */
export interface RecordParts {
  readonly request: SessionRequest;
  /** The request's `record` part. */
  readonly record: RecordRequest;
  readonly outcome: SessionOutcome;
  readonly events: readonly RecordedEvent[];
  readonly startedAt: string;
  readonly endedAt: string;
  /** The detach the session ended under, if it was carried on past one. */
  readonly detachId: string | undefined;
  /** The agent's transcript, when it keeps one the supervisor can read. */
  readonly native:
    | { readonly fileName: string; readonly text: string }
    | undefined;
}

const redactEvent = (event: RecordedEvent, redact: Redact): RecordedEvent =>
  event.type === "text"
    ? { ...event, text: redact(event.text) }
    : { ...event, args: redact(event.args) };

/** The session's record, with every secret masked. */
export const buildSessionRecord = (
  parts: RecordParts,
  redact: Redact,
): SessionRecord => {
  const { request, record, outcome, native, detachId } = parts;
  return {
    type: "sandcastle.session-record",
    version: 1,
    id: record.id,
    sandboxId: record.sandboxId,
    ...(detachId === undefined ? {} : { detachId }),
    name: request.name,
    agent: request.agent.id,
    model: request.agent.model,
    ...(outcome.sessionId === undefined
      ? {}
      : { sessionId: outcome.sessionId }),
    startedAt: parts.startedAt,
    endedAt: parts.endedAt,
    exitReason: outcome.exitReason,
    ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
    labels: { ...record.labels },
    eventsVersion: 1,
    events: parts.events.map((event) => redactEvent(event, redact)),
    ...(native === undefined
      ? {}
      : {
          native: {
            format: "claude-code-jsonl",
            fileName: native.fileName,
            content: Buffer.from(redact(native.text), "utf8").toString(
              "base64",
            ),
          },
        }),
  };
};
