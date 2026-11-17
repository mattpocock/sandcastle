import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { ContainerProcess, Sandbox as ModalSandbox } from "modal";
import { shellEscape } from "../../AgentProvider.js";
import { BoundedTail, MAX_TAIL_CHARS } from "../../boundedTail.js";
import type {
  ProviderExecOptions,
  ProviderExecResult,
} from "../SandboxProvider.js";

// Running commands in a Modal sandbox. Modal runs every command as root, so
// a sandbox with a non-root user runs each one through `setpriv` as that
// user, with its HOME, USER and LOGNAME under the command's own env; `sudo`
// runs it as root instead. Env and stdin are native: env goes in the exec
// call, never on the command line, and stdin is written, then closed.

/** The user commands run as, when the image has one. */
export interface ModalUser {
  readonly name: string;
  readonly home: string;
}

/** A sandbox, and what every command in it gets. */
export interface ModalExecContext {
  readonly sandbox: ModalSandbox;
  /** Where commands start. */
  readonly workingDirectory: string;
  /** The sandbox's env, for every command. */
  readonly env: Readonly<Record<string, string>>;
  /** Who commands run as; `undefined` is root. */
  readonly user: ModalUser | undefined;
}

/** The exit code of a command killed through its abort signal (SIGTERM). */
const ABORTED_EXIT_CODE = 143;

/** The argv and env that run `argv` as the context's user, or as root with `sudo`. */
const asUser = (
  context: ModalExecContext,
  argv: readonly string[],
  options: Pick<ProviderExecOptions, "env" | "sudo">,
): { readonly argv: string[]; readonly env: Record<string, string> } => {
  const env = { ...context.env, ...options.env };
  const { user } = context;
  if (user === undefined || options.sudo === true) {
    return { argv: [...argv], env };
  }
  return {
    argv: [
      "setpriv",
      `--reuid=${user.name}`,
      `--regid=${user.name}`,
      "--init-groups",
      "--",
      ...argv,
    ],
    env: { HOME: user.home, USER: user.name, LOGNAME: user.name, ...env },
  };
};

/** Writes `stdin` (if any) to the process, then closes it so it reads EOF. */
const feedStdin = async (
  process: ContainerProcess<string>,
  stdin: string | undefined,
): Promise<void> => {
  if (stdin !== undefined && stdin !== "") {
    await process.stdin.writeText(stdin);
  }
  await process.stdin.close();
};

/** Reads stdout to its end, passing each line on as it arrives. */
const readLines = async (
  stream: ReadableStream<string>,
  tail: BoundedTail,
  onLine: ((line: string) => void) | undefined,
): Promise<void> => {
  let partial = "";
  for await (const chunk of stream) {
    tail.push(chunk);
    const lines = (partial + chunk).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      onLine?.(line);
    }
  }
  // A last line with no trailing newline is still a line.
  if (partial !== "") {
    onLine?.(partial);
  }
};

const readAll = async (
  stream: ReadableStream<string>,
  tail: BoundedTail,
): Promise<void> => {
  for await (const chunk of stream) {
    tail.push(chunk);
  }
};

/** Whichever comes first: the command's exit code, or `abortSignal` aborting. */
const firstOf = async (
  ended: Promise<number>,
  abortSignal: AbortSignal | undefined,
): Promise<number | "aborted"> => {
  if (abortSignal === undefined) {
    return ended;
  }
  if (abortSignal.aborted) {
    return "aborted";
  }
  const done = new AbortController();
  const aborted = once(abortSignal, "abort", { signal: done.signal }).then(
    () => "aborted" as const,
    () => "aborted" as const,
  );
  try {
    return await Promise.race([ended, aborted]);
  } finally {
    done.abort();
  }
};

/** Kills the process group whose leader wrote its PID to `pidPath`, as root. */
const killGroup = async (
  sandbox: ModalSandbox,
  pidPath: string,
): Promise<void> => {
  const process = await sandbox.exec([
    "sh",
    "-c",
    `test -f ${pidPath} && kill -TERM -"$(cat ${pidPath})"; rm -f ${pidPath}`,
  ]);
  await process.stdin.close();
  await process.wait();
};

/**
 * The shell command for `command`. With an abort signal it leads a process
 * group of its own (`setsid`) and records its PID, so an abort can kill
 * everything it started.
 */
const shell = (
  command: string,
  pidPath: string | undefined,
): readonly string[] =>
  pidPath === undefined
    ? ["sh", "-c", command]
    : [
        "sh",
        "-c",
        `echo $$ > ${pidPath}\ntrap "rm -f ${pidPath}" EXIT\n${command}`,
      ];

/**
 * Runs a command and waits for it, with stdout and stderr apart and each
 * stdout line passed to `onLine` as it arrives. An abort kills it and
 * resolves with exit code 143.
 */
export const modalExec = async (
  context: ModalExecContext,
  options: ProviderExecOptions,
): Promise<ProviderExecResult> => {
  const { abortSignal } = options;
  const pidPath =
    abortSignal === undefined
      ? undefined
      : `/tmp/sandcastle-${randomUUID()}.pid`;
  const run = asUser(context, shell(options.command, pidPath), options);
  const process = await context.sandbox.exec(
    pidPath === undefined ? run.argv : ["setsid", "-w", ...run.argv],
    {
      workdir: options.workingDirectory ?? context.workingDirectory,
      env: run.env,
    },
  );
  const stdout = new BoundedTail(MAX_TAIL_CHARS, "");
  const stderr = new BoundedTail(MAX_TAIL_CHARS, "");
  const ended = (async () => {
    await feedStdin(process, options.stdin);
    await Promise.all([
      readLines(process.stdout, stdout, options.onLine),
      readAll(process.stderr, stderr),
    ]);
    return process.wait();
  })();
  const outcome = await firstOf(ended, abortSignal);
  if (outcome === "aborted" && pidPath !== undefined) {
    ended.catch(() => undefined);
    await killGroup(context.sandbox, pidPath).catch(() => undefined);
  }
  return {
    exitCode: outcome === "aborted" ? ABORTED_EXIT_CODE : outcome,
    stdout: stdout.toString(),
    stderr: stderr.toString(),
  };
};

/**
 * Starts a command and lets it run: a Modal exec carries on after the host
 * stops reading it, and after the host process exits. Its output goes
 * nowhere, so nothing waits on it. Resolves once Modal has started it.
 */
export const modalSpawnDetached = async (
  context: ModalExecContext,
  options: Pick<ProviderExecOptions, "command" | "workingDirectory" | "env">,
): Promise<void> => {
  const run = asUser(context, ["sh", "-c", options.command], options);
  const process = await context.sandbox.exec(run.argv, {
    workdir: options.workingDirectory ?? context.workingDirectory,
    env: run.env,
    stdout: "ignore",
    stderr: "ignore",
  });
  await process.stdin.close();
};

/** Writes a text file as the context's user, making its parent folders, through stdin. */
export const modalWriteText = async (
  context: ModalExecContext,
  { path, content }: { readonly path: string; readonly content: string },
): Promise<void> => {
  const file = shellEscape(path);
  const result = await modalExec(context, {
    command: `mkdir -p "$(dirname ${file})" && cat > ${file}`,
    stdin: content,
    workingDirectory: "/",
  });
  if (result.exitCode !== 0) {
    throw new Error(`modal: could not write ${path}: ${result.stderr}`);
  }
};
