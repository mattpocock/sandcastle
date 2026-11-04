import type { OutputDefinition } from "../Output.js";
import type {
  OutputType,
  SessionContextWindow,
  SessionExitReason,
  SessionUsage,
} from "./Session.js";
import type { SessionRecordPointer } from "./SessionRecord.js";

/**
 * Where the session supervisor POSTs the finish report for detached work, as
 * a Standard Webhook. Optional on `detach()`: leave it out for fire-and-forget.
 */
export interface FinishReportDestination {
  /** An `http:` or `https:` URL the sandbox can reach. */
  readonly url: string;
  /**
   * The signing secret for this one detach, in Standard Webhooks form
   * (`whsec_` plus base64, or bare base64). Make a fresh one per detach. It
   * reaches the supervisor sealed and is held in its memory only: never in a
   * session's env, a file or a log.
   */
  readonly secret: string;
}

/** Why detached work failed. */
export type FailureReason =
  | "session-failed"
  | "idle-timeout"
  | "structured-output-invalid"
  | "process-failed"
  | "time-limit";

/** What one detached session did. `O` is its structured output's type. */
export interface SessionReport<O = unknown> {
  /** The session's name. */
  readonly name: string;
  /** The built-in agent's id, e.g. `"claude-code"`. */
  readonly agent: string;
  /** The agent's own session id, when it reports one. */
  readonly sessionId?: string;
  /** How it ended. `time-limit`: the detach deadline stopped it. */
  readonly exitReason: SessionExitReason;
  readonly usage?: SessionUsage;
  readonly contextWindow?: SessionContextWindow;
  /**
   * The structured output, parsed. `verifyFinishReport` validates it against
   * the `outputs` you pass; otherwise it's unchecked. `undefined` when the
   * session declared none or didn't produce it.
   */
  readonly output: O;
  /** The agent's final message. */
  readonly finalMessage: string;
  /** The last few KB the agent printed. */
  readonly outputTail: string;
  /** Where the session's record went, when it had a `record` with a webhook or upload sink. */
  readonly record?: SessionRecordPointer;
}

/** A spawned process carried on past a detach. */
export interface ProcessReport {
  readonly name: string;
  /** `null` when the deadline killed it. */
  readonly exitCode: number | null;
  readonly outputTail: string;
}

/** `Output` definitions by session name, for typing a finish report. */
export type OutputMap = Readonly<Record<string, OutputDefinition>>;

/** Session reports by name, typed for the sessions named in `O`. */
export type SessionReports<O extends OutputMap = OutputMap> = {
  readonly [K in keyof O]: SessionReport<OutputType<O[K]>>;
} & Readonly<Record<string, SessionReport>>;

interface DetachedWorkBase<O extends OutputMap> {
  /** The provider's sandbox id. */
  readonly sandboxId: string;
  /** From the `DetachReceipt`. Also the `webhook-id`: dedupe deliveries on it. */
  readonly detachId: string;
  /** Every session carried on past the detach, by name. */
  readonly sessions: SessionReports<O>;
  /** Every process carried on past the detach. */
  readonly processes: readonly ProcessReport[];
}

/** Every carried-on session ended well. */
export interface SucceededDetachedWork<O extends OutputMap = OutputMap>
  extends DetachedWorkBase<O> {
  readonly status: "succeeded";
}

/** Something carried on past the detach failed. The rest still ran to its end. */
export interface FailedDetachedWork extends DetachedWorkBase<OutputMap> {
  readonly status: "failed";
  readonly failure: {
    readonly reason: FailureReason;
    readonly message: string;
    /** The session that failed first, when one did. */
    readonly name?: string;
  };
}

/**
 * The one message detached work sends when it ends: the final result, no
 * progress. Written to a file in the sandbox, then POSTed as a signed
 * Standard Webhook when `detach()` was given a destination.
 */
export interface FinishReport<O extends OutputMap = OutputMap> {
  readonly type: "sandcastle.detached.finished";
  /**
   * The report's format. `verifyFinishReport` rejects a report of any version
   * it doesn't read.
   */
  readonly version: 1;
  /** When the work finished, ISO 8601. */
  readonly timestamp: string;
  readonly data: SucceededDetachedWork<O> | FailedDetachedWork;
}

/** Options for `verifyFinishReport`. */
export interface VerifyFinishReportOptions {
  /** The raw request body, exactly as received. Don't parse it first. */
  readonly body: string;
  /** The request headers: `webhook-id`, `webhook-timestamp` and `webhook-signature`. */
  readonly headers:
    | Headers
    | Readonly<Record<string, string | readonly string[] | undefined>>;
  /** The secret you passed to `detach()` for this run. */
  readonly secret: string;
  /** Reject reports signed further than this from now, in seconds. Default 300. */
  readonly toleranceSeconds?: number;
}
