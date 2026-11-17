import type { FinishReport } from "./FinishReport.js";
import type { SessionRecordPointer } from "./SessionRecord.js";

// What `status()` reads from a sandbox, and the work it lists.

/** Spawned work still running in a sandbox. */
export interface RunningWork {
  readonly kind: "session";
  /** The session's name. */
  readonly name: string;
  /** The built-in agent's id, e.g. `"claude-code"`. */
  readonly agent: string;
}

/**
 * How a detach's finish report is getting on: `not-finished` while its
 * work runs, `delivering` while it is being sent, then `delivered`, `gone`
 * (the receiver answered 410) or `gave-up` (out of time before the kill
 * time). `no-destination` when the detach had none: it was only written.
 */
export type FinishReportDelivery =
  | "not-finished"
  | "delivering"
  | "delivered"
  | "gone"
  | "gave-up"
  | "no-destination";

/** A session that has ended in the sandbox. */
export interface EndedWork {
  readonly kind: "session";
  /** The session's name. */
  readonly name: string;
  /** The built-in agent's id, e.g. `"claude-code"`. */
  readonly agent: string;
  /** How it ended, as its result or the finish report says. */
  readonly exitReason:
    | "completed"
    | "closing-tag"
    | "failed"
    | "idle-timeout"
    | "aborted"
    | "time-limit";
  /** Where its record went from inside the sandbox, and how delivery went, when it had in-sandbox sinks. */
  readonly record?: SessionRecordPointer;
}

/** Options for `status()`. */
export interface StatusOptions {
  /** How many trailing lines of the session supervisor's log to return. Default 50. */
  readonly logLines?: number;
}

/** One detach from a sandbox, as `status()` reads it. */
export interface DetachStatus {
  readonly detachId: string;
  /** When the supervisor took the work on, by the sandbox's clock. */
  readonly detachedAt: Date;
  /** When it stops whatever is still running and reports `time-limit`, by the sandbox's clock. */
  readonly deadline: Date;
  /** The URL the finish report goes to, or `false` for fire-and-forget. */
  readonly reportsTo: string | false;
  readonly delivery: FinishReportDelivery;
  /** The finish report, once written: read from its file in the sandbox, whether or not it was delivered. */
  readonly finishReport?: FinishReport;
}

/**
 * A look inside a sandbox, read from the session supervisor's files. It is
 * never a finish signal when a detach has a finish report destination: the
 * report that arrives there is the one source of truth, and `finishReport`
 * here is for finding one that never arrived.
 */
export interface SandboxStatus {
  /** The provider's sandbox id. */
  readonly sandboxId: string;
  /** When the provider will kill the sandbox and everything in it. */
  readonly killTime: Date;
  /** Spawned sessions still running, held or carried on past a detach. */
  readonly running: readonly RunningWork[];
  /** Sessions that have ended, in the order they ended. */
  readonly ended: readonly EndedWork[];
  /** The last detach, if there was one: the last of `detaches`. */
  readonly detached?: DetachStatus;
  /**
   * Every detach from this sandbox, oldest first, each with its finish
   * report once written. A sandbox reused after a detach keeps them all
   * across the restarts of its session supervisor.
   */
  readonly detaches: readonly DetachStatus[];
  /** The last lines of the session supervisor's log. */
  readonly logs: readonly string[];
}
