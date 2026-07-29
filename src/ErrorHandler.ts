import { Effect } from "effect";
import { Display } from "./Display.js";
import type { SandboxError } from "./errors.js";

/**
 * Formats a tagged SandboxError into a user-friendly message with
 * context-specific hints about what went wrong and how to recover.
 */
export const formatErrorMessage = (error: SandboxError): string => {
  switch (error._tag) {
    case "ExecError":
      return `Command failed in sandbox (${error.command}): ${error.message}`;
    case "ExecHostError":
      return `Command failed on host (${error.command}): ${error.message}`;
    case "CopyError":
      return `File copy failed: ${error.message}`;
    case "DockerError":
      return `Docker operation failed: ${error.message}. Is Docker running?`;
    case "PodmanError":
      return `Podman operation failed: ${error.message}. Is Podman running?`;
    case "AppleContainerError":
      return `Apple Container operation failed: ${error.message}. Are Apple Container services running?`;
    case "SyncError":
      return `Git sync failed: ${error.message}`;
    case "WorktreeError":
      return `Git worktree operation failed: ${error.message}`;
    case "PromptError":
      return `Failed to resolve prompt: ${error.message}`;
    case "AgentError":
      return `Agent invocation failed: ${error.message}`;
    case "ConfigDirError":
      return `${error.message}`;
    case "InitError":
      return `${error.message}`;
    case "AgentIdleTimeoutError":
    case "WorktreeTimeoutError":
    case "ContainerStartTimeoutError":
    case "CopyToWorktreeTimeoutError":
    case "CopyToWorktreeError":
    case "SyncInTimeoutError":
    case "HookTimeoutError":
    case "GitSetupTimeoutError":
    case "PromptExpansionTimeoutError":
    case "CommitCollectionTimeoutError":
    case "MergeToHostTimeoutError":
    case "SessionCaptureError":
    case "CwdError":
      return error.message;
  }
};

const showErrorAndExit = (error: SandboxError) =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(formatErrorMessage(error), "error");
    return yield* Effect.sync(() => process.exit(1) as never);
  });

/**
 * Wraps an effect so that any SandboxError is caught, displayed via the
 * Display service as an error-severity status message, then exits the process
 * with code 1. Non-SandboxError errors pass through unchanged.
 */
export const withFriendlyErrors = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, SandboxError>, R | Display> =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Effect.catchTags(effect as Effect.Effect<A, SandboxError, R>, {
    ExecError: showErrorAndExit,
    ExecHostError: showErrorAndExit,
    CopyError: showErrorAndExit,
    DockerError: showErrorAndExit,
    PodmanError: showErrorAndExit,
    AppleContainerError: showErrorAndExit,
    SyncError: showErrorAndExit,
    WorktreeError: showErrorAndExit,
    PromptError: showErrorAndExit,
    AgentError: showErrorAndExit,
    ConfigDirError: showErrorAndExit,
    InitError: showErrorAndExit,
    AgentIdleTimeoutError: showErrorAndExit,
    WorktreeTimeoutError: showErrorAndExit,
    ContainerStartTimeoutError: showErrorAndExit,
    CopyToWorktreeTimeoutError: showErrorAndExit,
    CopyToWorktreeError: showErrorAndExit,
    SyncInTimeoutError: showErrorAndExit,
    HookTimeoutError: showErrorAndExit,
    GitSetupTimeoutError: showErrorAndExit,
    PromptExpansionTimeoutError: showErrorAndExit,
    CommitCollectionTimeoutError: showErrorAndExit,
    MergeToHostTimeoutError: showErrorAndExit,
    SessionCaptureError: showErrorAndExit,
    CwdError: showErrorAndExit,
  }) as Effect.Effect<A, Exclude<E, SandboxError>, R | Display>;
