import { Schema } from "effect";
import { ExitReason, RecordPointer } from "./sessionRecordSchema.js";

// The session supervisor's status file, shared by both sides. The supervisor
// rewrites it (whole, by rename) whenever its work changes; the host's
// `status()` reads it through the provider, so it works after a detach, from
// a reattached handle, and after the supervisor has exited.

/** The status file, relative to the supervisor's directory. */
export const STATUS_FILE = "status.json";

/**
 * A session's events file, relative to the supervisor's directory: one
 * redacted event (JSON) per line, appended as the agent goes and closed
 * before the session shows as ended in the status file, so a reader that
 * sees it ended and then reads this file has every event.
 */
export const eventsFile = (sessionId: string): string =>
  `sessions/${sessionId}.events.jsonl`;

/** How the last detach's finish report is getting on. */
export const FinishReportDelivery = Schema.Literal(
  "not-finished",
  "delivering",
  "delivered",
  "gone",
  "gave-up",
  "no-destination",
);

/** How the last detach's finish report is getting on. */
export type FinishReportDelivery = typeof FinishReportDelivery.Type;

/** A session: its request id names its files under `sessions/`. */
const Work = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  agent: Schema.String,
});

/** What the supervisor writes to its status file. */
export const SupervisorStatus = Schema.Struct({
  /** `exited` once it has stopped: after its detached work was reported, or a shutdown. */
  supervisor: Schema.Literal("running", "exited"),
  running: Schema.Array(Work),
  ended: Schema.Array(
    Schema.Struct({
      ...Work.fields,
      exitReason: ExitReason,
      record: Schema.optional(RecordPointer),
    }),
  ),
  detached: Schema.optional(
    Schema.Struct({
      detachId: Schema.String,
      /** ISO 8601, by the sandbox's clock. */
      detachedAt: Schema.String,
      /** ISO 8601, by the sandbox's clock. */
      deadline: Schema.String,
      reportsTo: Schema.Union(Schema.String, Schema.Literal(false)),
      delivery: FinishReportDelivery,
    }),
  ),
});

/** What the supervisor writes to its status file. */
export type SupervisorStatus = typeof SupervisorStatus.Type;

/** SupervisorStatus <-> the file's JSON text. */
export const SupervisorStatusJson = Schema.parseJson(SupervisorStatus);
