import { Data, Duration, Effect } from "effect";

/** Command execution failed in the sandbox */
export class ExecError extends Data.TaggedError("ExecError")<{
  readonly message: string;
  readonly command: string;
  /** Exit code of the failed command, when the command ran but returned non-zero.
   *  Absent when the failure was the exec itself (e.g. the SDK threw before a code was available). */
  readonly exitCode?: number;
}> {}

/** Command execution failed on the host */
export class ExecHostError extends Data.TaggedError("ExecHostError")<{
  readonly message: string;
  readonly command: string;
}> {}

/** File copy between host and sandbox failed */
export class CopyError extends Data.TaggedError("CopyError")<{
  readonly message: string;
}> {}

/** Docker infrastructure operation failed */
export class DockerError extends Data.TaggedError("DockerError")<{
  readonly message: string;
}> {}

/** Podman infrastructure operation failed */
export class PodmanError extends Data.TaggedError("PodmanError")<{
  readonly message: string;
}> {}

/** Apple Container infrastructure operation failed */
export class AppleContainerError extends Data.TaggedError(
  "AppleContainerError",
)<{
  readonly message: string;
}> {}

/** Git sync-in or sync-out operation failed */
export class SyncError extends Data.TaggedError("SyncError")<{
  readonly message: string;
}> {}

/** Git worktree operation failed */
export class WorktreeError extends Data.TaggedError("WorktreeError")<{
  readonly message: string;
}> {}

/** Prompt resolution or preprocessing failed */
export class PromptError extends Data.TaggedError("PromptError")<{
  readonly message: string;
  /** Exit code of the failing shell expression, set when the failure is a non-zero
   *  exit from a `` !`command` `` expansion. Absent for other prompt-resolution failures
   *  (missing template arg, file not readable, etc.). Mirrors the optional `exitCode` on `ExecError`. */
  readonly exitCode?: number;
}> {}

/** Agent invocation failed */
export class AgentError extends Data.TaggedError("AgentError")<{
  readonly message: string;
  /** Host path to the preserved worktree, set when the worktree was kept after failure. */
  readonly preservedWorktreePath?: string;
}> {}

/** .sandcastle/ config directory missing */
export class ConfigDirError extends Data.TaggedError("ConfigDirError")<{
  readonly message: string;
}> {}

/** Initialization or setup operation failed */
export class InitError extends Data.TaggedError("InitError")<{
  readonly message: string;
}> {}

/** Run exceeded the configured agent idle timeout */
export class AgentIdleTimeoutError extends Data.TaggedError(
  "AgentIdleTimeoutError",
)<{
  readonly message: string;
  readonly timeoutMs: number;
  /** Host path to the preserved worktree, set when the worktree was kept after failure. */
  readonly preservedWorktreePath?: string;
}> {}

/** Git worktree create or prune timed out */
export class WorktreeTimeoutError extends Data.TaggedError(
  "WorktreeTimeoutError",
)<{
  readonly message: string;
  readonly timeoutMs: number;
  readonly path: string;
  readonly operation: "create" | "prune";
}> {}

/** Sandbox container start timed out */
export class ContainerStartTimeoutError extends Data.TaggedError(
  "ContainerStartTimeoutError",
)<{
  readonly message: string;
  readonly timeoutMs: number;
}> {}

/** Copying files to worktree timed out */
export class CopyToWorktreeTimeoutError extends Data.TaggedError(
  "CopyToWorktreeTimeoutError",
)<{
  readonly message: string;
  readonly timeoutMs: number;
  readonly paths: string[];
}> {}

/** Fallback cp -R to worktree failed */
export class CopyToWorktreeError extends Data.TaggedError(
  "CopyToWorktreeError",
)<{
  readonly message: string;
  readonly path: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}> {}

/** Git sync-in for isolated providers timed out */
export class SyncInTimeoutError extends Data.TaggedError("SyncInTimeoutError")<{
  readonly message: string;
  readonly timeoutMs: number;
}> {}

/** onSandboxReady hook command timed out */
export class HookTimeoutError extends Data.TaggedError("HookTimeoutError")<{
  readonly message: string;
  readonly timeoutMs: number;
  readonly command: string;
}> {}

/** Git config setup command timed out */
export class GitSetupTimeoutError extends Data.TaggedError(
  "GitSetupTimeoutError",
)<{
  readonly message: string;
  readonly timeoutMs: number;
  readonly command: string;
}> {}

/** Prompt shell expression expansion timed out */
export class PromptExpansionTimeoutError extends Data.TaggedError(
  "PromptExpansionTimeoutError",
)<{
  readonly message: string;
  readonly timeoutMs: number;
  readonly expression: string;
  /** Wall-clock time the shell expression actually ran before timing out, measured at the throw site.
   *  Distinct from `timeoutMs` (the configured deadline) so a downstream orchestrator can tell a
   *  genuine contention timeout from a near-instant abort. */
  readonly elapsedMs: number;
}> {}

/** Commit collection timed out */
export class CommitCollectionTimeoutError extends Data.TaggedError(
  "CommitCollectionTimeoutError",
)<{
  readonly message: string;
  readonly timeoutMs: number;
}> {}

/** Merge-to-host branch timed out */
export class MergeToHostTimeoutError extends Data.TaggedError(
  "MergeToHostTimeoutError",
)<{
  readonly message: string;
  readonly timeoutMs: number;
  readonly sourceBranch: string;
  readonly targetBranch: string;
}> {}

/**
 * Wrap an effect with a timeout that fails with a specific error on expiry.
 * Uses `Effect.timeoutFail` under the hood.
 */
export const withTimeout =
  <E>(timeoutMs: number, onTimeout: () => E) =>
  <A, E2, R>(effect: Effect.Effect<A, E2, R>): Effect.Effect<A, E | E2, R> =>
    effect.pipe(
      Effect.timeoutFail({
        duration: Duration.millis(timeoutMs),
        onTimeout,
      }),
    );

/** Session capture (read, rewrite, or write) failed */
export class SessionCaptureError extends Data.TaggedError(
  "SessionCaptureError",
)<{
  readonly message: string;
  readonly sessionId: string;
}> {}

/** The provided `cwd` path does not exist or is not a directory. */
export { CwdError } from "./resolveCwd.js";
import type { CwdError } from "./resolveCwd.js";

/** Union of all sandbox-related errors */
export type SandboxError =
  | CwdError
  | ExecError
  | ExecHostError
  | CopyError
  | DockerError
  | PodmanError
  | AppleContainerError
  | SyncError
  | WorktreeError
  | PromptError
  | AgentError
  | ConfigDirError
  | InitError
  | AgentIdleTimeoutError
  | WorktreeTimeoutError
  | ContainerStartTimeoutError
  | CopyToWorktreeTimeoutError
  | CopyToWorktreeError
  | SyncInTimeoutError
  | HookTimeoutError
  | GitSetupTimeoutError
  | PromptExpansionTimeoutError
  | CommitCollectionTimeoutError
  | MergeToHostTimeoutError
  | SessionCaptureError;
