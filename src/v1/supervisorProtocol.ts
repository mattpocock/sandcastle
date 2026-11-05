import { Schema } from "effect";
import {
  ExitReason,
  RecordPointer,
  RecordRequest,
  SessionRecordSchema,
  Usage,
} from "./sessionRecordSchema.js";

export { ExitReason } from "./sessionRecordSchema.js";
export type { FinishReportDelivery } from "./supervisorStatusSchema.js";
export { eventsFile } from "./supervisorStatusSchema.js";

// The messages between the host and the session supervisor, shared by both
// sides. The host writes one request as a JSON file into the supervisor's
// directory and runs `node supervisor.mjs call <file>`, a short-lived client
// that hands it to the supervisor over a Unix socket and prints each reply as
// one JSON line on stdout, which the host reads through the provider's exec
// stream. Nothing here needs stdin or per-command env from the provider.

/** The ids of the built-in agents a session can run. */
export const AgentId = Schema.Literal(
  "claude-code",
  "codex",
  "cursor",
  "opencode",
  "copilot",
  "pi",
);

/** A recorded stream a fake agent replays instead of running the real CLI. */
export const ReplayScript = Schema.Struct({
  lines: Schema.Array(Schema.String),
  exitCode: Schema.Number,
  hang: Schema.Boolean,
});

/** What a fake agent replays. */
export type ReplayScript = typeof ReplayScript.Type;

/** A built-in agent, by id plus options, so it can cross into the sandbox. */
export const AgentDescriptor = Schema.Struct({
  id: AgentId,
  model: Schema.String,
  options: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  replay: Schema.optional(ReplayScript),
});

/** A built-in agent, by id plus options. */
export type AgentDescriptor = typeof AgentDescriptor.Type;

const Env = Schema.Record({ key: Schema.String, value: Schema.String });

/** Start one agent session. Its replies stream until it ends. */
export const SessionRequest = Schema.Struct({
  type: Schema.Literal("session"),
  id: Schema.String,
  name: Schema.String,
  agent: AgentDescriptor,
  prompt: Schema.String,
  workingDirectory: Schema.String,
  env: Env,
  idleTimeoutMs: Schema.Number,
  completionTimeoutMs: Schema.Number,
  output: Schema.optional(
    Schema.Struct({
      kind: Schema.Literal("object", "string"),
      tag: Schema.String,
    }),
  ),
  resumeSessionId: Schema.optional(Schema.String),
  record: Schema.optional(RecordRequest),
});

/** Start one agent session. */
export type SessionRequest = typeof SessionRequest.Type;

/**
 * Let go: carry the running sessions on, stop them at the deadline, then
 * write the finish report and deliver it. The secret is sealed to the key the
 * supervisor made in memory at start, so only it can open it.
 */
export const DetachRequest = Schema.Struct({
  type: Schema.Literal("detach"),
  detachId: Schema.String,
  sandboxId: Schema.String,
  /** From when the supervisor gets the request, so host and sandbox clocks needn't agree. */
  deadlineMs: Schema.Number,
  /** How long delivery may keep retrying: until the sandbox's kill time. */
  giveUpMs: Schema.Number,
  finishReport: Schema.optional(
    Schema.Struct({ url: Schema.String, sealedSecret: Schema.String }),
  ),
});

/** Let go of the running sessions. */
export type DetachRequest = typeof DetachRequest.Type;

/** Everything the host can ask the supervisor. */
export const Request = Schema.Union(
  Schema.Struct({ type: Schema.Literal("hello") }),
  SessionRequest,
  DetachRequest,
  Schema.Struct({ type: Schema.Literal("kill"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("shutdown") }),
);

/** Everything the host can ask the supervisor. */
export type Request = typeof Request.Type;

/** What the agent does, as it does it. */
export const StreamEvent = Schema.Union(
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("toolCall"),
    name: Schema.String,
    args: Schema.String,
  }),
);

/** The structured output the supervisor found: parsed, or why not. */
export const ExtractedOutput = Schema.Union(
  Schema.Struct({
    found: Schema.Literal(true),
    raw: Schema.String,
    value: Schema.Unknown,
  }),
  Schema.Struct({
    found: Schema.Literal(false),
    raw: Schema.optional(Schema.String),
    problem: Schema.String,
  }),
);

/** The structured output the supervisor found: parsed, or why not. */
export type ExtractedOutput = typeof ExtractedOutput.Type;

/** Everything the supervisor knows about a session once it has ended. */
export const SessionOutcome = Schema.Struct({
  exitReason: ExitReason,
  started: Schema.Boolean,
  message: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  sessionId: Schema.optional(Schema.String),
  finalMessage: Schema.String,
  outputTail: Schema.String,
  usage: Schema.optional(Usage),
  contextWindow: Schema.optional(
    Schema.Struct({
      tokens: Schema.Number,
      limit: Schema.optional(Schema.Number),
    }),
  ),
  output: Schema.optional(ExtractedOutput),
  /** Where its record went from inside the sandbox, when it had one. */
  record: Schema.optional(RecordPointer),
});

/** Everything the supervisor knows about a session once it has ended. */
export type SessionOutcome = typeof SessionOutcome.Type;

/** One line the supervisor sends back. */
export const Reply = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("hello"),
    pid: Schema.Number,
    /** The public half of the key pair the supervisor made in memory at start (PEM). */
    publicKey: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("detached"),
    /** The sessions it now holds; empty when nothing was running, and then nothing changed. */
    carriedOn: Schema.Array(
      Schema.Struct({ name: Schema.String, agent: Schema.String }),
    ),
  }),
  Schema.Struct({ type: Schema.Literal("ok") }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("started") }),
  Schema.Struct({ type: Schema.Literal("event"), event: StreamEvent }),
  /** The session's record, before `ended`, when the host has sinks of its own. */
  Schema.Struct({
    type: Schema.Literal("record"),
    record: SessionRecordSchema,
  }),
  Schema.Struct({ type: Schema.Literal("ended"), outcome: SessionOutcome }),
);

/** One line the supervisor sends back. */
export type Reply = typeof Reply.Type;

/** Request <-> one line of JSON. */
export const RequestJson = Schema.parseJson(Request);

/** Reply <-> one line of JSON. */
export const ReplyJson = Schema.parseJson(Reply);
