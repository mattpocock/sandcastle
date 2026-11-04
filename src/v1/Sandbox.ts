import type { OutputDefinition } from "../Output.js";
import type { FinishReportDestination } from "./FinishReport.js";
import type { SandboxProvider } from "./SandboxProvider.js";
import type {
  OutputType,
  SessionOptions,
  SessionProcess,
  SessionResult,
} from "./Session.js";

/** Options for `createSandbox`. */
export interface CreateSandboxOptions<
  Native = unknown,
  CanDetach extends boolean = boolean,
> {
  /** Where the sandbox runs, e.g. `fakeSandbox()`. Vendor options go to the provider's factory, not here. */
  readonly provider: SandboxProvider<Native, CanDetach>;
  /**
   * Exactly the env every command in the sandbox gets: agent keys, a git
   * token, anything else. Nothing is read from disk for you. Default none.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Wall-clock limit for the sandbox's whole life, in minutes (fractions
   * allowed). The provider sets its own limit from it and the sandbox is
   * killed at `killTime`, whether or not anyone holds it. Default 60.
   */
  readonly timeLimitMinutes?: number;
  /** Aborts creation. Whatever was created so far is closed. */
  readonly abortSignal?: AbortSignal;
}

/** Options for `exec`. */
export interface ExecOptions {
  /** The shell command. */
  readonly command: string;
  /** Directory to run in. Relative paths resolve against `workingDirectory`. */
  readonly workingDirectory?: string;
  /** Extra env for this command only, on top of the sandbox's env. */
  readonly env?: Readonly<Record<string, string>>;
  /** Run it as root. */
  readonly sudo?: boolean;
  /** Resolve with a non-zero exit code instead of rejecting with `ExecFailedError`. */
  readonly allowFailure?: boolean;
  /** Kills the command. */
  readonly abortSignal?: AbortSignal;
}

/** The outcome of an `exec`. */
export interface ExecResult<Code extends number = number> {
  /** The command's exit code: always `0` unless you passed `allowFailure: true`. */
  readonly exitCode: Code;
  /** Everything the command printed to stdout. */
  readonly stdout: string;
  /** Everything the command printed to stderr. */
  readonly stderr: string;
}

/**
 * A live sandbox you hold. Every operation is a call on it, so setup is a list
 * of plain `await` lines. Close it when you're done, or use `await using`.
 */
export interface Sandbox<Native = unknown> extends AsyncDisposable {
  /** The provider's id for this sandbox. */
  readonly sandboxId: string;
  /** The directory every command starts in; relative paths resolve here. Never changes. */
  readonly workingDirectory: string;
  /** When the provider will kill the sandbox and everything in it. */
  readonly killTime: Date;
  /** The vendor's own object for this sandbox, for features Sandcastle doesn't wrap. */
  readonly native: Native;
  /** Whether this sandbox's provider can detach from it. */
  readonly canDetach: boolean;
  /**
   * Run a shell command and wait for it. Rejects with `ExecFailedError` on a
   * non-zero exit unless you pass `allowFailure: true`.
   */
  readonly exec: {
    (
      command: string | (ExecOptions & { readonly allowFailure?: false }),
    ): Promise<ExecResult<0>>;
    (
      options: ExecOptions & { readonly allowFailure: true },
    ): Promise<ExecResult>;
  };
  /** Read a text file. Resolves `null` when it doesn't exist. */
  readonly readTextFile: (options: {
    readonly path: string;
  }) => Promise<string | null>;
  /** Write a text file, creating parent directories. */
  readonly writeTextFile: (options: {
    readonly path: string;
    readonly content: string;
  }) => Promise<void>;
  /**
   * Run one agent session and wait for its result. Rejects with
   * `SessionFailedError`, or `StructuredOutputError` when its output is
   * missing or doesn't match the schema.
   */
  readonly session: <const O extends OutputDefinition | undefined = undefined>(
    options: SessionOptions<O>,
  ) => Promise<SessionResult<OutputType<O>>>;
  /**
   * Start one agent session and resolve once the agent is running. Rejects
   * with `SessionFailedError` when it can't start. Stream its `events`,
   * `wait()` for its result, or `kill()` it.
   */
  readonly spawnSession: <
    const O extends OutputDefinition | undefined = undefined,
  >(
    options: SessionOptions<O>,
  ) => Promise<SessionProcess<OutputType<O>>>;
  /** End the sandbox and kill everything in it. Safe to call twice. */
  readonly close: () => Promise<void>;
}

/** Options for `detach()`. */
export interface DetachOptions {
  /**
   * Where the session supervisor POSTs the signed finish report once the
   * carried-on work ends. Leave it out for fire-and-forget: the agent reports
   * for itself (opens the PR, comments on the ticket). Either way the report
   * is written to a file in the sandbox.
   */
  readonly finishReport?: FinishReportDestination;
  /**
   * Stop the carried-on work this many minutes from now (fractions allowed)
   * and report `time-limit`. Clamped to the default: the kill time minus a
   * margin of 5 minutes, or a quarter of the time limit when that's shorter,
   * which leaves room to deliver the report before the sandbox is killed.
   */
  readonly deadlineMinutes?: number;
  /** Aborts the detach itself. You keep the handle; `close()` still ends everything. */
  readonly abortSignal?: AbortSignal;
}

/** Spawned work still running in a sandbox. */
export interface RunningWork {
  readonly kind: "session";
  /** The session's name. */
  readonly name: string;
  /** The built-in agent's id, e.g. `"claude-code"`. */
  readonly agent: string;
}

/**
 * Proof that you've let go of a sandbox and its spawned work carries on
 * without you. It means "started", nothing more: the finish arrives at your
 * finish report destination, or nowhere (fire-and-forget).
 */
export interface DetachReceipt {
  /** The provider's sandbox id. */
  readonly sandboxId: string;
  /** Made fresh per detach. The finish report and its `webhook-id` carry it. */
  readonly detachId: string;
  /** When the session supervisor stops whatever is still running and reports `time-limit`. */
  readonly deadline: Date;
  /** The work carrying on: every spawned session still running at the detach. */
  readonly carriedOn: readonly RunningWork[];
  /** The URL the finish report goes to, or `false` for fire-and-forget. */
  readonly reportsTo: string | false;
}

/** A sandbox from a provider that can detach. */
export interface DetachableSandbox<Native = unknown> extends Sandbox<Native> {
  /** Always `true`. */
  readonly canDetach: true;
  /**
   * Let go of the sandbox while its spawned sessions carry on under the
   * session supervisor. Resolves once the supervisor holds them. Only work
   * spawned before the detach carries on. When the last of it ends, or the
   * deadline passes, the supervisor writes the finish report to a file in the
   * sandbox and POSTs it to `finishReport`, if given.
   *
   * Rejects with `DetachError` when nothing is running or an awaited call on
   * the handle is pending. After it resolves, every call on the handle
   * rejects with `SandboxDetachedError` and `close()` does nothing.
   */
  readonly detach: (options?: DetachOptions) => Promise<DetachReceipt>;
}
