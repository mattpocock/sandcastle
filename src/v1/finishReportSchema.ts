import { Schema } from "effect";
import { ExitReason, RecordPointer, Usage } from "./sessionRecordSchema.js";

// The finish report's wire shape, as verifyFinishReport reads it back. The
// supervisor builds it from the public `FinishReport` type
// (finishReportBuild.ts); this schema checks a body that claims to be one.

const SessionReport = Schema.Struct({
  name: Schema.String,
  agent: Schema.String,
  sessionId: Schema.optional(Schema.String),
  exitReason: ExitReason,
  usage: Schema.optional(Usage),
  contextWindow: Schema.optional(
    Schema.Struct({
      tokens: Schema.Number,
      limit: Schema.optional(Schema.Number),
    }),
  ),
  output: Schema.optional(Schema.Unknown),
  finalMessage: Schema.String,
  outputTail: Schema.String,
  record: Schema.optional(RecordPointer),
});

const ProcessReport = Schema.Struct({
  name: Schema.String,
  exitCode: Schema.NullOr(Schema.Number),
  outputTail: Schema.String,
});

const work = {
  sandboxId: Schema.String,
  detachId: Schema.String,
  sessions: Schema.Record({ key: Schema.String, value: SessionReport }),
  processes: Schema.Array(ProcessReport),
};

/** A finish report body, as JSON text. */
export const FinishReportJson = Schema.parseJson(
  Schema.Struct({
    type: Schema.Literal("sandcastle.detached.finished"),
    version: Schema.Literal(1),
    timestamp: Schema.String,
    data: Schema.Union(
      Schema.Struct({ ...work, status: Schema.Literal("succeeded") }),
      Schema.Struct({
        ...work,
        status: Schema.Literal("failed"),
        failure: Schema.Struct({
          reason: Schema.Literal(
            "session-failed",
            "idle-timeout",
            "structured-output-invalid",
            "process-failed",
            "time-limit",
          ),
          message: Schema.String,
          name: Schema.optional(Schema.String),
        }),
      }),
    ),
  }),
);
