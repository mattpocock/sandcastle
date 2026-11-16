import { Effect } from "effect";
import { CopyError, ExecError } from "./errors.js";
import type {
  BindMountSandboxHandle,
  IsolatedSandboxHandle,
  NoSandboxHandle,
} from "./SandboxProvider.js";

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface SandboxService {
  readonly exec: (
    command: string,
    options?: {
      onLine?: (line: string) => void;
      cwd?: string;
      sudo?: boolean;
      stdin?: string;
    },
  ) => Effect.Effect<ExecResult, ExecError>;

  /** Copy a file or directory from the host into the sandbox. */
  readonly copyIn: (
    hostPath: string,
    sandboxPath: string,
  ) => Effect.Effect<void, CopyError>;

  /** Copy a single file from the sandbox to the host. */
  readonly copyFileOut: (
    sandboxPath: string,
    hostPath: string,
  ) => Effect.Effect<void, CopyError>;
}

const getCopyIn = (
  handle: BindMountSandboxHandle | IsolatedSandboxHandle | NoSandboxHandle,
): SandboxService["copyIn"] => {
  if ("copyIn" in handle) {
    return (hostPath, sandboxPath) =>
      Effect.tryPromise({
        try: () => handle.copyIn(hostPath, sandboxPath),
        catch: (e) =>
          new CopyError({
            message: `copyIn failed: ${e instanceof Error ? e.message : String(e)}`,
          }),
      });
  }
  if ("copyFileIn" in handle) {
    return (hostPath, sandboxPath) =>
      Effect.tryPromise({
        try: () => handle.copyFileIn(hostPath, sandboxPath),
        catch: (e) =>
          new CopyError({
            message: `copyFileIn failed: ${e instanceof Error ? e.message : String(e)}`,
          }),
      });
  }
  return () =>
    Effect.fail(
      new CopyError({
        message: "copyIn is not supported for this sandbox provider",
      }),
    );
};

/**
 * Wrap a Promise-based sandbox handle into an Effect-based SandboxService.
 * Delegates copyIn/copyFileOut to the handle when available.
 */
export const makeSandboxFromHandle = (
  handle: BindMountSandboxHandle | IsolatedSandboxHandle | NoSandboxHandle,
): SandboxService => ({
  exec: (command, options) =>
    Effect.tryPromise({
      try: () => handle.exec(command, options),
      catch: (e) =>
        new ExecError({
          command,
          message: `exec failed: ${e instanceof Error ? e.message : String(e)}`,
        }),
    }),
  copyIn: getCopyIn(handle),
  copyFileOut:
    "copyFileOut" in handle
      ? (sandboxPath, hostPath) =>
          Effect.tryPromise({
            try: () => handle.copyFileOut(sandboxPath, hostPath),
            catch: (e) =>
              new CopyError({
                message: `copyFileOut failed: ${e instanceof Error ? e.message : String(e)}`,
              }),
          })
      : () =>
          Effect.fail(
            new CopyError({
              message: "copyFileOut is not supported for this sandbox provider",
            }),
          ),
});

/** The mount point inside the sandbox where the project worktree is bound. */
export const SANDBOX_REPO_DIR = "/home/agent/workspace";

/** A git mount for a bind-mount sandbox. */
export interface MountEntry {
  readonly hostPath: string;
  readonly sandboxPath: string;
  /** Mount read-only. */
  readonly readonly?: boolean;
  /** A temp dir holding `hostPath`, removed when the sandbox closes. */
  readonly tempDir?: string;
}
