import { Effect, Predicate } from "effect";
import { Display } from "./Display.js";
import type { SandboxError } from "./errors.js";

/**
 * Formats a tagged SandboxError into a user-friendly message with
 * context-specific hints about what went wrong and how to recover.
 */
export const formatErrorMessage = (error: SandboxError): string => {
  switch (error._tag) {
    case "ExecError": {
      return `Command failed in sandbox (${error.command}): ${error.message}`;
    }
    case "ExecHostError": {
      return `Command failed on host (${error.command}): ${error.message}`;
    }
    case "CopyError": {
      return `File copy failed: ${error.message}`;
    }
    case "DockerError": {
      return `Docker operation failed: ${error.message}. Is Docker running?`;
    }
    case "PodmanError": {
      return `Podman operation failed: ${error.message}. Is Podman running?`;
    }
    case "SyncError": {
      return `Git sync failed: ${error.message}`;
    }
    case "WorktreeError": {
      return `Git worktree operation failed: ${error.message}`;
    }
    case "PromptError": {
      return `Failed to resolve prompt: ${error.message}`;
    }
    case "AgentError": {
      return `Agent invocation failed: ${error.message}`;
    }
    case "ConfigDirError":
    case "InitError":
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
    case "SyncOutPathError":
    case "CwdError":
    case "ImageNotFoundError": {
      return error.message;
    }
  }
};

const showErrorAndExit = (error: SandboxError) =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(formatErrorMessage(error), "error");
    return yield* Effect.sync(() => process.exit(1));
  });

// Keyed by every SandboxError tag, so adding an error to the union without
// listing it here fails to compile.
const sandboxErrorTags: Record<SandboxError["_tag"], true> = {
  ExecError: true,
  ExecHostError: true,
  CopyError: true,
  DockerError: true,
  PodmanError: true,
  SyncError: true,
  SyncOutPathError: true,
  WorktreeError: true,
  PromptError: true,
  AgentError: true,
  ConfigDirError: true,
  InitError: true,
  AgentIdleTimeoutError: true,
  WorktreeTimeoutError: true,
  ContainerStartTimeoutError: true,
  CopyToWorktreeTimeoutError: true,
  CopyToWorktreeError: true,
  SyncInTimeoutError: true,
  HookTimeoutError: true,
  GitSetupTimeoutError: true,
  PromptExpansionTimeoutError: true,
  CommitCollectionTimeoutError: true,
  MergeToHostTimeoutError: true,
  SessionCaptureError: true,
  CwdError: true,
  ImageNotFoundError: true,
};

const isSandboxError = (error: unknown): error is SandboxError =>
  Predicate.hasProperty(error, "_tag") &&
  typeof error._tag === "string" &&
  Object.hasOwn(sandboxErrorTags, error._tag);

/**
 * Wraps an effect so that any SandboxError is caught, displayed via the
 * Display service as an error-severity status message, then exits the process
 * with code 1. Non-SandboxError errors pass through unchanged.
 */
export const withFriendlyErrors = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, Extract<E, SandboxError>>, R | Display> =>
  Effect.catchIf(
    effect,
    (error): error is Extract<E, SandboxError> => isSandboxError(error),
    (error) => showErrorAndExit(error),
  );
