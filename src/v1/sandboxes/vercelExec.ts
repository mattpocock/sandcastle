import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import type { Sandbox as VercelSandbox } from "@vercel/sandbox";
import { shellEscape } from "../../AgentProvider.js";
import { BoundedTail, MAX_TAIL_CHARS } from "../../boundedTail.js";
import type {
  ProviderExecOptions,
  ProviderExecResult,
} from "../SandboxProvider.js";

// Running commands in a Vercel sandbox. Env goes to each command through
// `runCommand`'s own `env`, never onto the command line. `runCommand` gives a
// command it waits for no stdin, so stdin travels as a file the command
// removes as it starts.

/** A sandbox, and what every command in it gets. */
export interface VercelExecContext {
  readonly sandbox: VercelSandbox;
  /** Where commands start. */
  readonly workingDirectory: string;
  /** The sandbox's env, for every command. */
  readonly env: Readonly<Record<string, string>>;
}

/** The exit code of a command killed through its abort signal (SIGTERM). */
const ABORTED_EXIT_CODE = 143;

/**
 * `command`, its stdin redirected from a file in the sandbox when there is
 * one (a file, not an argument, keeps clear of the per-argument size limit).
 * The redirect opens the file before the group runs, so the group deletes it
 * straight away and leaves nothing behind.
 */
const withStdin = async (
  sandbox: VercelSandbox,
  command: string,
  stdin: string | undefined,
): Promise<string> => {
  if (stdin === undefined) {
    return command;
  }
  const stdinPath = `/tmp/sandcastle-stdin-${randomUUID()}`;
  await sandbox.writeFiles([{ path: stdinPath, content: Buffer.from(stdin) }]);
  return `{ rm -f ${stdinPath}; ${command}\n} < ${stdinPath}`;
};

/** A stream that keeps a bounded tail of what's written to it, passing each chunk on. */
const tailStream = (
  tail: BoundedTail,
  onChunk: (chunk: string) => void = () => undefined,
): Writable =>
  new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const text = chunk.toString();
      tail.push(text);
      onChunk(text);
      callback();
    },
  });

/**
 * Collects a command's output, passing each stdout line on as it arrives.
 * The SDK never ends the streams it writes to, so `flush()` passes on a last
 * line with no newline once the command has finished.
 */
const collector = (onLine: ((line: string) => void) | undefined) => {
  const stdout = new BoundedTail(MAX_TAIL_CHARS, "");
  const stderr = new BoundedTail(MAX_TAIL_CHARS, "");
  let partial = "";
  return {
    stdout: tailStream(stdout, (chunk) => {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        onLine?.(line);
      }
    }),
    stderr: tailStream(stderr),
    flush: () => {
      if (partial !== "") {
        onLine?.(partial);
        partial = "";
      }
    },
    result: (exitCode: number): ProviderExecResult => ({
      exitCode,
      stdout: stdout.toString(),
      stderr: stderr.toString(),
    }),
  };
};

/**
 * Ends the command whose shell wrote its pid to `pidPath`, and everything it
 * started. Vercel's own kill only signals the shell, which waits for its
 * running child before it exits; and every command shares one process group,
 * so the tree is walked instead.
 */
const killTree = async (
  sandbox: VercelSandbox,
  pidPath: string,
  sudo: boolean,
): Promise<void> => {
  const script = [
    'tree() { echo "$1"; for c in $(pgrep -P "$1"); do tree "$c"; done; }',
    `[ -f ${pidPath} ] && kill -TERM $(tree "$(cat ${pidPath})") 2>/dev/null`,
    "true",
  ].join("\n");
  await sandbox
    .runCommand({ cmd: "sh", args: ["-c", script], sudo })
    .catch(() => undefined);
};

/** Calls `kill` once `abortSignal` aborts and `command` has started. */
const onAbort = (
  abortSignal: AbortSignal | undefined,
  kill: () => Promise<void>,
) => {
  let started = false;
  let aborted = false;
  const fire = () => {
    if (started && aborted) {
      started = false;
      void kill();
    }
  };
  const abort = () => {
    aborted = true;
    fire();
  };
  abortSignal?.addEventListener("abort", abort, { once: true });
  return {
    aborted: () => aborted,
    started: () => {
      started = true;
      aborted ||= abortSignal?.aborted === true;
      fire();
    },
    dispose: () => {
      abortSignal?.removeEventListener("abort", abort);
    },
  };
};

const sudoOf = (options: Pick<ProviderExecOptions, "sudo">) =>
  options.sudo === true ? { sudo: true } : {};

/** The cwd, env and sudo of a command, as `runCommand` takes them. */
const commandParams = (
  context: VercelExecContext,
  options: Pick<ProviderExecOptions, "workingDirectory" | "env" | "sudo">,
) => ({
  cwd: options.workingDirectory ?? context.workingDirectory,
  env: { ...context.env, ...options.env },
  ...sudoOf(options),
});

/**
 * Runs a command and waits for it, with stdout and stderr apart, streaming
 * stdout line by line. Its abort signal ends the command and all it started:
 * with one, the command's shell writes its pid to a file first.
 */
export const vercelExec = async (
  context: VercelExecContext,
  options: ProviderExecOptions,
): Promise<ProviderExecResult> => {
  const { sandbox } = context;
  const pidPath =
    options.abortSignal === undefined
      ? undefined
      : `/tmp/sandcastle-${randomUUID()}.pid`;
  const command = await withStdin(sandbox, options.command, options.stdin);
  const output = collector(options.onLine);
  const abort = onAbort(options.abortSignal, async () =>
    pidPath === undefined
      ? undefined
      : killTree(sandbox, pidPath, options.sudo === true),
  );
  try {
    const finished = await sandbox.runCommand({
      cmd: "sh",
      args: [
        "-c",
        pidPath === undefined ? command : `echo $$ > ${pidPath}\n${command}`,
      ],
      ...commandParams(context, options),
      stdout: output.stdout,
      stderr: output.stderr,
      onStart: () => {
        abort.started();
      },
    });
    output.flush();
    return output.result(
      abort.aborted() ? ABORTED_EXIT_CODE : finished.exitCode,
    );
  } finally {
    abort.dispose();
    if (pidPath !== undefined) {
      await sandbox
        .runCommand({ cmd: "rm", args: ["-f", pidPath], ...sudoOf(options) })
        .catch(() => undefined);
    }
  }
};

/**
 * Starts a command that outlives the host's hold on the sandbox: a detached
 * `runCommand`, with no per-command timeout (Vercel kills a command at its
 * timeout, detached or not). Resolves once Vercel has started it.
 */
export const spawnDetachedCommand = async (
  context: VercelExecContext,
  options: Pick<ProviderExecOptions, "command" | "workingDirectory" | "env">,
): Promise<void> => {
  await context.sandbox.runCommand({
    cmd: "sh",
    args: ["-c", options.command],
    ...commandParams(context, options),
    detached: true,
  });
};

/** Makes `directory` and its parents; the default image has no `/vercel/sandbox`. */
export const makeDirectory = async (
  sandbox: VercelSandbox,
  directory: string,
): Promise<void> => {
  const made = await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", `mkdir -p ${shellEscape(directory)}`],
  });
  if (made.exitCode !== 0) {
    const stderr = await made.stderr();
    throw new Error(
      `vercel: could not create ${directory}: ${stderr.trim() || `exit code ${made.exitCode}`}`,
    );
  }
};
