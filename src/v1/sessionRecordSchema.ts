import { Schema } from "effect";

// The session record's wire shapes, shared by the host and the supervisor:
// the record itself (supervisor to host, for the host's own sinks), the
// pointer the finish report carries, and the `record` part of a session
// request.

/** How a session ended. */
export const ExitReason = Schema.Literal(
  "completed",
  "closing-tag",
  "failed",
  "idle-timeout",
  "aborted",
  "time-limit",
);

/** Token counts for a session's last model call. */
export const Usage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadInputTokens: Schema.Number,
  cacheCreationInputTokens: Schema.Number,
});

const RecordedEvent = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String,
    at: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("toolCall"),
    name: Schema.String,
    args: Schema.String,
    at: Schema.String,
  }),
);

const Labels = Schema.Record({ key: Schema.String, value: Schema.String });

/** A session record (`SessionRecord`). */
export const SessionRecordSchema = Schema.Struct({
  type: Schema.Literal("sandcastle.session-record"),
  version: Schema.Literal(1),
  id: Schema.String,
  sandboxId: Schema.String,
  detachId: Schema.optional(Schema.String),
  name: Schema.String,
  agent: Schema.String,
  model: Schema.String,
  sessionId: Schema.optional(Schema.String),
  startedAt: Schema.String,
  endedAt: Schema.String,
  exitReason: ExitReason,
  usage: Schema.optional(Usage),
  labels: Labels,
  eventsVersion: Schema.Literal(1),
  events: Schema.Array(RecordedEvent),
  native: Schema.optional(
    Schema.Struct({
      format: Schema.Literal("claude-code-jsonl"),
      fileName: Schema.String,
      content: Schema.String,
    }),
  ),
});

const Delivered = Schema.Struct({
  url: Schema.String,
  status: Schema.Literal("delivered", "gone", "gave-up"),
});

/** Where a record went (`SessionRecordPointer`). */
export const RecordPointer = Schema.Struct({
  id: Schema.String,
  upload: Schema.optional(Delivered),
  webhook: Schema.optional(Delivered),
});

/** What the supervisor sends a record to, opened from `RecordRequest.sealed`. */
export const RecordSecrets = Schema.Struct({
  upload: Schema.optional(
    Schema.Struct({
      url: Schema.String,
      headers: Schema.Record({ key: Schema.String, value: Schema.String }),
    }),
  ),
  webhookSecret: Schema.optional(Schema.String),
});

/** What the supervisor sends a record to. */
export type RecordSecrets = typeof RecordSecrets.Type;

/** RecordSecrets <-> JSON text, sealed to the supervisor's key. */
export const RecordSecretsJson = Schema.parseJson(RecordSecrets);

/** The `record` part of a session request. */
export const RecordRequest = Schema.Struct({
  id: Schema.String,
  sandboxId: Schema.String,
  labels: Labels,
  redact: Schema.Struct({
    patterns: Schema.Array(Schema.String),
    envVars: Schema.Array(Schema.String),
  }),
  webhookUrl: Schema.optional(Schema.String),
  /** The upload URL and the webhook secret, sealed like the finish report secret. */
  sealed: Schema.optional(Schema.String),
  /** Send the record back to the host too, for its own sinks. */
  toHost: Schema.Boolean,
  /** Until the sandbox's kill time, from when the supervisor gets the request. */
  killInMs: Schema.Number,
});

/** The `record` part of a session request. */
export type RecordRequest = typeof RecordRequest.Type;
