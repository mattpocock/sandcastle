import { randomUUID } from "node:crypto";
import type { Sandbox as DaytonaSandbox } from "@daytona/sdk";
import { Data, Effect } from "effect";
import { shellEscape } from "../../AgentProvider.js";
import { BoundedTail, MAX_TAIL_CHARS } from "../../boundedTail.js";
import type {
  ProviderExecOptions,
  ProviderExecResult,
} from "../SandboxProvider.js";
import type { SessionCommand } from "./daytonaSessionWatch.js";
import { watchSessionShell } from "./daytonaSessionWatch.js";

// Running commands in a Daytona sandbox. Daytona's exec has no stdin, and its
// streamed (session) exec has no env, so both travel as files in a private
// folder in the sandbox, which the command deletes as it starts, and the host
// deletes again once it's done with the command, in case it never started.

/** A sandbox, and what every command in it gets. */
export interface DaytonaExecContext {
  readonly sandbox: DaytonaSandbox;
  /** Where commands start. */
  readonly workingDirectory: string;
  /** The sandbox's env, for every command. */
  readonly env: Readonly<Record<string, string>>;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
/** The exit code of a command killed through its abort signal (SIGTERM). */
const ABORTED_EXIT_CODE = 143;
/** The exit code of a command Daytona reported no exit code for. */
const UNKNOWN_EXIT_CODE = 1;

/** Lines that export `env` when sourced, or `undefined` when it's empty. */
const envScript = (
  env: Readonly<Record<string, string>>,
): string | undefined => {
  const entries = Object.entries(env);
  if (entries.length === 0) {
    return undefined;
  }
  return entries
    .map(([key, value]) => {
      if (!ENV_KEY.test(key)) {
        throw new TypeError(`daytona: invalid env var name "${key}"`);
      }
      return `export ${key}=${shellEscape(value)}\n`;
    })
    .join("");
};

/** Deletes a command's private folder, if it still exists. Never rejects. */
const discard = async (
  sandbox: DaytonaSandbox,
  folder: string | undefined,
): Promise<void> => {
  if (folder !== undefined) {
    await sandbox.fs.deleteFile(folder, true).catch(() => undefined);
  }
};

/** Uploads the env and stdin files into a folder only the sandbox user can read. */
const uploadFiles = async (
  sandbox: DaytonaSandbox,
  folder: string,
  files: { readonly env?: string; readonly stdin?: string },
): Promise<void> => {
  await sandbox.fs.createFolder(folder, "700");
  await Promise.all(
    Object.entries(files).map(async ([name, content]) => {
      const path = `${folder}/${name}`;
      await sandbox.fs.uploadFile(Buffer.from(content, "utf8"), path);
      await sandbox.fs.setFilePermissions(path, { mode: "600" });
    }),
  );
};

/**
 * `command` ready for Daytona: in a subshell (so a top-level `exit` can't end
 * a session's shell, which would leave its log stream open forever), in its
 * directory, with its env sourced from a file and stdin redirected from one,
 * their folder removed before the command runs. With `sudo`, all of it runs
 * as root.
 */
const prepare = async (
  context: DaytonaExecContext,
  options: Omit<ProviderExecOptions, "onLine" | "abortSignal">,
): Promise<{ readonly command: string; readonly folder?: string }> => {
  const env = envScript({ ...context.env, ...options.env });
  const { stdin } = options;
  const folder =
    env === undefined && stdin === undefined
      ? undefined
      : `/tmp/sandcastle-${randomUUID()}`;
  if (folder !== undefined) {
    await uploadFiles(context.sandbox, folder, {
      ...(env === undefined ? {} : { env }),
      ...(stdin === undefined ? {} : { stdin }),
    }).catch(async (error: unknown) => {
      await discard(context.sandbox, folder);
      throw error;
    });
  }
  const inner = [
    ...(env === undefined ? [] : [`. ${folder}/env`]),
    ...(folder === undefined ? [] : [`rm -rf ${folder}`]),
    `cd ${shellEscape(options.workingDirectory ?? context.workingDirectory)} || exit 1`,
    options.command,
  ].join("\n");
  const elevated =
    options.sudo === true ? `sudo sh -c ${shellEscape(inner)}` : inner;
  const redirect = stdin === undefined ? "" : ` < ${folder}/stdin`;
  return { command: `(\n${elevated}\n)${redirect}`, folder };
};

/** Daytona's stream of a command's output failed. */
class DaytonaLogStreamError extends Data.TaggedError("DaytonaLogStreamError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/** Collects a session command's output, passing each stdout line on as it arrives. */
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
    /** Passes on a last line with no newline, once the stream has ended. */
    flush: () => {
      if (partial !== "") {
        onLine?.(partial);
      }
    },
    result: (exitCode: number): ProviderExecResult => ({
      exitCode,
      stdout: stdout.toString(),
      stderr: stderr.toString(),
    }),
  };
};

/** Succeeds once `abortSignal` aborts; never, without one. */
const abortedBy = (abortSignal: AbortSignal | undefined) =>
  Effect.async<"aborted">((resume) => {
    if (abortSignal === undefined) {
      return;
    }
    const onAbort = () => {
      resume(Effect.succeed("aborted"));
    };
    if (abortSignal.aborted) {
      onAbort();
      return;
    }
    abortSignal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => {
      abortSignal.removeEventListener("abort", onAbort);
    });
  });

/**
 * Whether a session command `ended` (its log stream closed, or its shell
 * ended) or was `aborted`. Rejects if its shell ended without an exit code.
 */
const endOf = async (
  sandbox: DaytonaSandbox,
  session: SessionCommand,
  { logs, abortSignal }: { logs: Promise<void>; abortSignal?: AbortSignal },
): Promise<"ended" | "aborted"> =>
  Effect.runPromise(
    Effect.tryPromise({
      try: async () => logs,
      catch: (cause) =>
        new DaytonaLogStreamError({
          message: `Daytona's log stream for the command failed: ${String(cause)}`,
          cause,
        }),
    }).pipe(
      Effect.as<"ended">("ended"),
      Effect.raceFirst(
        watchSessionShell(sandbox, session).pipe(Effect.as<"ended">("ended")),
      ),
      Effect.raceFirst(abortedBy(abortSignal)),
    ),
  );

/** Runs `command` in a fresh session, streaming its stdout line by line. */
const streamed = async (
  sandbox: DaytonaSandbox,
  command: string,
  { onLine, abortSignal }: Pick<ProviderExecOptions, "onLine" | "abortSignal">,
): Promise<ProviderExecResult> => {
  const sessionId = `sandcastle-${randomUUID()}`;
  const pidPath = `/tmp/${sessionId}.pid`;
  const output = collector(onLine);
  await sandbox.process.createSession(sessionId);
  try {
    const { cmdId } = await sandbox.process.executeSessionCommand(sessionId, {
      command: `echo $$ > ${pidPath}; ${command}`,
      runAsync: true,
    });
    const logs = sandbox.process.getSessionCommandLogs(
      sessionId,
      cmdId,
      output.onStdout,
      output.onStderr,
    );
    const session = { sessionId, cmdId, pidPath };
    const ended = await endOf(sandbox, session, {
      logs,
      ...(abortSignal === undefined ? {} : { abortSignal }),
    });
    if (ended === "aborted") {
      return output.result(ABORTED_EXIT_CODE);
    }
    output.flush();
    const { exitCode } = await sandbox.process.getSessionCommand(
      sessionId,
      cmdId,
    );
    if (exitCode === undefined) {
      output.onStderr("Daytona reported no exit code for the command.\n");
      return output.result(UNKNOWN_EXIT_CODE);
    }
    return output.result(exitCode);
  } finally {
    // Deleting the session kills whatever it still runs.
    await sandbox.process.deleteSession(sessionId).catch(() => undefined);
    await sandbox.process
      .executeCommand(`rm -f ${pidPath}`)
      .catch(() => undefined);
  }
};

/**
 * Runs a command and waits for it. With `onLine` or an abort signal it
 * streams through a session, with stdout and stderr apart; otherwise it's one
 * plain call, whose output Daytona gives as one stream, reported as stdout
 * (and as stderr too when the command fails).
 */
export const daytonaExec = async (
  context: DaytonaExecContext,
  options: ProviderExecOptions,
): Promise<ProviderExecResult> => {
  const { command, folder } = await prepare(context, options);
  try {
    if (options.onLine !== undefined || options.abortSignal !== undefined) {
      return await streamed(context.sandbox, command, options);
    }
    const response = await context.sandbox.process.executeCommand(command);
    return {
      exitCode: response.exitCode,
      stdout: response.result,
      stderr: response.exitCode === 0 ? "" : response.result,
    };
  } finally {
    // Gone already unless the command never got to remove it.
    await discard(context.sandbox, folder);
  }
};

/**
 * Starts a command in a session of its own that is never deleted, so it
 * outlives the host's hold on the sandbox: deleting a Daytona session kills
 * what it runs. Resolves once Daytona has started it.
 */
export const spawnInSession = async (
  context: DaytonaExecContext,
  options: Pick<ProviderExecOptions, "command" | "workingDirectory" | "env">,
): Promise<void> => {
  const { command, folder } = await prepare(context, options);
  const sessionId = `sandcastle-detached-${randomUUID()}`;
  try {
    await context.sandbox.process.createSession(sessionId);
    await context.sandbox.process.executeSessionCommand(sessionId, {
      command,
      runAsync: true,
    });
  } catch (error) {
    // It never started, so it never removed its files. Once it has started
    // it removes them itself: deleting them here would race it.
    await discard(context.sandbox, folder);
    throw error;
  }
};
