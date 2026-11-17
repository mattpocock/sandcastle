import type { CommandHandle, Sandbox as E2BSandbox } from "e2b";
import { BoundedTail, MAX_TAIL_CHARS } from "../../boundedTail.js";
import type {
  ProviderExecOptions,
  ProviderExecResult,
} from "../SandboxProvider.js";

// Running commands in an E2B sandbox. E2B takes env per command and has
// native stdin, so neither touches a file or the command line. Every command
// runs in the background with no time limit of its own (`timeoutMs: 0`):
// E2B ends a command after 60 seconds otherwise, and the sandbox's own kill
// time is the limit that matters.

/** A sandbox, and what every command in it gets. */
export interface E2BExecContext {
  readonly sandbox: E2BSandbox;
  /** Where commands start. */
  readonly workingDirectory: string;
  /** The sandbox's env, for every command. */
  readonly env: Readonly<Record<string, string>>;
}

/** A command handle that keeps no output of its own: the collector keeps it. */
type OutputlessHandle = CommandHandle<undefined>;

/** The exit code of a command killed through its abort signal (SIGTERM's). */
const ABORTED_EXIT_CODE = 143;

/** Whether `error` is one of the SDK's not-found errors (a file, a command, a sandbox). */
export const isNotFound = (error: unknown): boolean =>
  error instanceof Error && error.name.endsWith("NotFoundError");

/** The SDK's error for a command that exited non-zero: it still carries the result. */
const exitCodeOf = (error: unknown): number | undefined =>
  error instanceof Error &&
  error.name === "CommandExitError" &&
  "exitCode" in error &&
  typeof error.exitCode === "number"
    ? error.exitCode
    : undefined;

/** Collects a command's output, passing each stdout line on as it arrives. */
const collector = (onLine: ((line: string) => void) | undefined) => {
  const stdout = new BoundedTail(MAX_TAIL_CHARS, "");
  const stderr = new BoundedTail(MAX_TAIL_CHARS, "");
  let partial = "";
  return {
    onStdout: (chunk: string) => {
      stdout.push(chunk);
      const lines = (partial + chunk).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        onLine?.(line);
      }
    },
    onStderr: (chunk: string) => {
      stderr.push(chunk);
    },
    result: (exitCode: number): ProviderExecResult => {
      if (partial !== "") {
        onLine?.(partial);
        partial = "";
      }
      return {
        exitCode,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
      };
    },
  };
};

/** Sends stdin, then closes it. A command that already exited needn't read it. */
const deliverStdin = async (
  handle: OutputlessHandle,
  stdin: string,
): Promise<void> => {
  try {
    if (stdin !== "") {
      await handle.sendStdin(stdin);
    }
    await handle.closeStdin();
  } catch (error) {
    // The command has exited: its exit code still comes from wait().
    if (!isNotFound(error)) {
      await handle.kill().catch(() => undefined);
      throw error;
    }
  }
};

/**
 * The command's exit code. A broken stream to the sandbox rejects, naming
 * that: E2B keeps no output of its own, so a lost stream can't be replayed,
 * and the command can't be heard from again.
 */
const exitOf = async (handle: OutputlessHandle): Promise<number> => {
  try {
    const { exitCode } = await handle.wait();
    return exitCode;
  } catch (error) {
    const exitCode = exitCodeOf(error);
    if (exitCode !== undefined) {
      return exitCode;
    }
    throw new Error(
      `e2b: lost the command's output stream before it ended: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
};

/** Kills the command when `abortSignal` aborts; returns whether it did, and a cleanup. */
const killOnAbort = (
  handle: OutputlessHandle,
  abortSignal: AbortSignal | undefined,
) => {
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    void handle.kill().catch(() => undefined);
  };
  if (abortSignal?.aborted === true) {
    onAbort();
  }
  abortSignal?.addEventListener("abort", onAbort, { once: true });
  return {
    aborted: () => aborted,
    stop: () => {
      abortSignal?.removeEventListener("abort", onAbort);
    },
  };
};

/** The options every command is started with: env, directory, user, no time limit. */
const startOptions = (
  context: E2BExecContext,
  options: Pick<ProviderExecOptions, "workingDirectory" | "env" | "sudo">,
) => ({
  background: true as const,
  cwd: options.workingDirectory ?? context.workingDirectory,
  envs: { ...context.env, ...options.env },
  ...(options.sudo === true ? { user: "root" } : {}),
  timeoutMs: 0,
});

/** Runs a command and waits for it, streaming its stdout line by line, stderr apart. */
export const e2bExec = async (
  context: E2BExecContext,
  options: ProviderExecOptions,
): Promise<ProviderExecResult> => {
  const output = collector(options.onLine);
  const handle = await context.sandbox.commands.run(options.command, {
    ...startOptions(context, options),
    stdin: options.stdin !== undefined,
    retainOutput: false,
    onStdout: output.onStdout,
    onStderr: output.onStderr,
  });
  const abort = killOnAbort(handle, options.abortSignal);
  try {
    if (options.stdin !== undefined) {
      await deliverStdin(handle, options.stdin);
    }
    const exitCode = await exitOf(handle).catch((error: unknown) => {
      if (abort.aborted()) {
        return ABORTED_EXIT_CODE;
      }
      throw error;
    });
    return output.result(abort.aborted() ? ABORTED_EXIT_CODE : exitCode);
  } finally {
    abort.stop();
  }
};

/**
 * Starts a command in the background and lets go of it: disconnecting stops
 * the host hearing from it, but E2B keeps it running (with no time limit of
 * its own) until the sandbox ends.
 */
export const e2bSpawnDetached = async (
  context: E2BExecContext,
  options: Pick<ProviderExecOptions, "command" | "workingDirectory" | "env">,
): Promise<void> => {
  const handle = await context.sandbox.commands.run(options.command, {
    ...startOptions(context, options),
    retainOutput: false,
  });
  await handle.disconnect();
};
