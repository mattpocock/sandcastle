import type { SessionExitReason, SessionUsage } from "./Session.js";

/** The formats a session's native transcript comes in. */
export type NativeSessionFormat = "claude-code-jsonl";

/** The agent's own transcript of a session, exactly as the agent wrote it, redacted. */
export interface NativeSessionFile {
  /** Which agent wrote it, and how. */
  readonly format: NativeSessionFormat;
  /** Its file name in the sandbox, e.g. `<sessionId>.jsonl`. */
  readonly fileName: string;
  /** Its content, base64. */
  readonly content: string;
}

/**
 * Something the agent did, with when the supervisor saw it. Version 1 of the
 * normalised event stream: what the session's `events` show, timestamped.
 */
export type RecordedEvent =
  | { readonly type: "text"; readonly text: string; readonly at: string }
  | {
      readonly type: "toolCall";
      readonly name: string;
      /** The tool's main argument (a command, a URL, a query). */
      readonly args: string;
      readonly at: string;
    };

/**
 * What a session leaves behind for later reading: the agent's native
 * transcript (the main payload) plus a small versioned stream of normalised
 * events, with the labels you set. Built by the session supervisor inside
 * the sandbox when the session ends, and redacted there before it leaves.
 */
export interface SessionRecord {
  /** Always `"sandcastle.session-record"`. */
  readonly type: "sandcastle.session-record";
  /** The record format's version. */
  readonly version: 1;
  /** Made fresh per record. Also the webhook sink's `webhook-id`. */
  readonly id: string;
  /** The provider's sandbox id. */
  readonly sandboxId: string;
  /** Set when the session ended carried on past a detach. */
  readonly detachId?: string;
  /** The session's name. */
  readonly name: string;
  /** The built-in agent's id, e.g. `"claude-code"`. */
  readonly agent: string;
  /** The model the agent ran. */
  readonly model: string;
  /** The agent's own session id, when it reported one. */
  readonly sessionId?: string;
  /** When the session started, ISO 8601. */
  readonly startedAt: string;
  /** When the session ended, ISO 8601. */
  readonly endedAt: string;
  /** How the session ended. */
  readonly exitReason: SessionExitReason;
  /** Token counts for its last model call, when it succeeded and the agent reported them. */
  readonly usage?: SessionUsage;
  /** The labels you set on `record`. */
  readonly labels: Readonly<Record<string, string>>;
  /** The version of `events`' shape. */
  readonly eventsVersion: 1;
  /** What the agent did, in order. */
  readonly events: readonly RecordedEvent[];
  /** The agent's transcript. Absent when the agent keeps none Sandcastle can read (only Claude Code's, for now). */
  readonly native?: NativeSessionFile;
}

/**
 * What to mask in a record before it leaves the sandbox: every occurrence of
 * each string is replaced with `[REDACTED]`. Data, not a function, so it
 * works inside a detached sandbox.
 */
export interface RecordRedaction {
  /** Literal strings to mask (not regular expressions). */
  readonly patterns?: readonly string[];
  /** Env var names whose values, as the session saw them, are masked. */
  readonly envVars?: readonly string[];
}

/** Where a session's record goes, and what it carries. Set on a session's `record`. */
export interface SessionRecordOptions {
  /**
   * PUT the record (JSON) to this URL from inside the sandbox, e.g. an S3
   * presigned PUT URL, so no storage credential enters the sandbox. Works
   * held or detached. The URL travels sealed, like the finish report secret.
   */
  readonly upload?: {
    /** An `http:` or `https:` URL the sandbox can reach. */
    readonly url: string;
    /** Extra request headers, e.g. ones the presigned URL was signed with. */
    readonly headers?: Readonly<Record<string, string>>;
  };
  /**
   * POST the record from inside the sandbox as a Standard Webhook, signed like
   * the finish report, with the record's `id` as `webhook-id`. Works held or
   * detached. The secret travels sealed and stays in the supervisor's memory.
   */
  readonly webhook?: {
    /** An `http:` or `https:` URL the sandbox can reach. */
    readonly url: string;
    /** A Standard Webhooks secret: `whsec_` plus base64, or bare base64. */
    readonly secret: string;
  };
  /**
   * Write the record to `<path>/<sandboxId>/<name>.json`, and the native
   * transcript beside it, on your machine. Only while you hold the handle: a
   * session that ends after a detach doesn't write here. A later session with
   * the same name in the same sandbox replaces the files.
   */
  readonly directory?: {
    /** An absolute path on your machine. */
    readonly path: string;
  };
  /**
   * Called with the record on your machine. Only while you hold the handle.
   * If it throws, the session's result rejects with that error.
   */
  readonly onRecord?: (record: SessionRecord) => void | Promise<void>;
  /** Labels the record carries, e.g. a run id and a task. */
  readonly labels?: Readonly<Record<string, string>>;
  /** What to mask before the record leaves the sandbox. */
  readonly redact?: RecordRedaction;
}

/** How sending a record to a sink from inside the sandbox went. */
export type RecordDeliveryStatus = "delivered" | "gone" | "gave-up";

/** Where a session's record went. The finish report carries one per recorded session. */
export interface SessionRecordPointer {
  /** The record's `id`: the webhook sink's `webhook-id`. */
  readonly id: string;
  /** The upload URL, without its query string, and how the PUT went. */
  readonly upload?: {
    readonly url: string;
    readonly status: RecordDeliveryStatus;
  };
  /** The webhook URL, without its query string, and how the POST went. */
  readonly webhook?: {
    readonly url: string;
    readonly status: RecordDeliveryStatus;
  };
}
