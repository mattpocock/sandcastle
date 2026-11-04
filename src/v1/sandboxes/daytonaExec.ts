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
// streamed (session) exec has no env, so both travel as files in the sandbox
// that the command deletes as it starts.

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

/** Uploads `content` to a fresh file under /tmp and returns its path. */
const uploadTemp = async (
  sandbox: DaytonaSandbox,
  kind: string,
  content: string,
): Promise<string> => {
  const path = `/tmp/sandcastle-${kind}-${randomUUID()}`;
  await sandbox.fs.uploadFile(Buffer.from(content, "utf8"), path);
  return path;
};

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

/**
 * `command` ready for Daytona: in a subshell (so a top-level `exit` can't end
 * a session's shell, which would leave its log stream open forever), in its
 * directory, with its env sourced from a file and stdin redirected from one,
 * each file removed before the command runs. With `sudo`, all of it runs as
 * root.
 */
const prepare = async (
  context: DaytonaExecContext,
  options: Omit<ProviderExecOptions, "onLine" | "abortSignal">,
): Promise<string> => {
  const { sandbox, workingDirectory } = context;
  const script = envScript({ ...context.env, ...options.env });
  const envFile =
    script === undefined ? undefined : await uploadTemp(sandbox, "env", script);
  const cwd = options.workingDirectory ?? workingDirectory;
  const inner = [
    ...(envFile === undefined ? [] : [`. ${envFile}; rm -f ${envFile}`]),
    `cd ${shellEscape(cwd)} || exit 1`,
    options.command,
  ].join("\n");
  const elevated =
    options.sudo === true ? `sudo sh -c ${shellEscape(inner)}` : inner;
  if (options.stdin === undefined) {
    return `(\n${elevated}\n)`;
  }
  const stdinFile = await uploadTemp(sandbox, "stdin", options.stdin);
  return `(\nrm -f ${stdinFile}\n${elevated}\n) < ${stdinFile}`;
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
    const info = await sandbox.process.getSessionCommand(sessionId, cmdId);
    return output.result(info.exitCode ?? 0);
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
  const command = await prepare(context, options);
  if (options.onLine !== undefined || options.abortSignal !== undefined) {
    return streamed(context.sandbox, command, options);
  }
  const response = await context.sandbox.process.executeCommand(command);
  return {
    exitCode: response.exitCode,
    stdout: response.result,
    stderr: response.exitCode === 0 ? "" : response.result,
  };
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
  const command = await prepare(context, options);
  const sessionId = `sandcastle-detached-${randomUUID()}`;
  await context.sandbox.process.createSession(sessionId);
  await context.sandbox.process.executeSessionCommand(sessionId, {
    command,
    runAsync: true,
  });
};
