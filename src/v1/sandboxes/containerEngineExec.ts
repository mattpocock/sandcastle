import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ProviderExecOptions,
  ProviderExecResult,
} from "../SandboxProvider.js";
import type { ContainerEngine } from "./containerEngineCli.js";
import { cliError, runCli, runCliOrFail } from "./containerEngineCli.js";

// Commands and files in a running container, through `<engine> exec`. Env
// reaches each command through an `--env-file` the host writes (owner-only)
// and removes once the CLI has read it: never on the CLI's command line, and
// never on the container itself.

/** A running container, and what every command in it gets. */
export interface ContainerContext {
  readonly engine: ContainerEngine;
  /** The container's id. */
  readonly id: string;
  /** Where commands start. */
  readonly workingDirectory: string;
  /** The sandbox's env, for every command. */
  readonly env: Readonly<Record<string, string>>;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const PID_LINE = /^__SANDCASTLE_PID=(?<pid>\d+)\n/u;
const STATUS_LINE = /\n__SANDCASTLE_EXIT_STATUS=(?<status>\d+)\n$/u;
/** The exit code of a command killed through its abort signal (SIGTERM). */
const ABORTED_EXIT_CODE = 143;
/** The exit code `readTextFile`'s script uses for a missing file. */
const MISSING_EXIT_CODE = 44;

/**
 * The command's shell first says its pid, the leader of the process group
 * the engine starts each exec in, so an abort can kill the whole group. The
 * command runs in a subshell (an `exit` ends only that), and its status is
 * printed as a last stderr line: the engine CLI's own exit code can't be
 * trusted, since a CLI killed mid-command exits 0. The command arrives as
 * `$1` and is unset before it runs.
 */
const WRAPPER = [
  `printf '__SANDCASTLE_PID=%s\\n' "$$" >&2`,
  '__sandcastle_cmd=$1; shift; (eval "unset __sandcastle_cmd',
  "$__sandcastle_cmd",
  `"); __sandcastle_status=$?; printf '\\n__SANDCASTLE_EXIT_STATUS=%s\\n' "$__sandcastle_status" >&2; exit "$__sandcastle_status"`,
].join("\n");

/** Writes `env` as an owner-only env file; resolves its CLI flags and a remover. */
const envFile = async (
  engine: ContainerEngine,
  env: Readonly<Record<string, string>>,
): Promise<{
  readonly flags: string[];
  readonly remove: () => Promise<void>;
}> => {
  const entries = Object.entries(env);
  if (entries.length === 0) {
    return { flags: [], remove: async () => undefined };
  }
  const lines = entries.map(([key, value]) => {
    if (!ENV_KEY.test(key)) {
      throw new TypeError(`${engine.cli}: invalid env var name "${key}"`);
    }
    if (/[\n\r\0]/u.test(value)) {
      throw new TypeError(
        `${engine.cli}: env var "${key}" has a line break, which \`${engine.cli} exec --env-file\` can't carry`,
      );
    }
    return `${key}=${value}\n`;
  });
  const folder = await mkdtemp(path.join(tmpdir(), "sandcastle-env-"));
  const file = path.join(folder, "env");
  await writeFile(file, lines.join(""), { mode: 0o600 });
  return {
    flags: ["--env-file", file],
    remove: async () => rm(folder, { recursive: true, force: true }),
  };
};

/** The command's stderr without the wrapper's lines, and its exit code. */
const unwrap = (
  stderr: string,
  cliCode: number,
): { readonly stderr: string; readonly exitCode: number } => {
  const own = stderr.replace(PID_LINE, "");
  const status = STATUS_LINE.exec(own);
  if (status === null) {
    // It never finished: the CLI failed, or was interrupted.
    return { stderr: own, exitCode: cliCode === 0 ? 1 : cliCode };
  }
  return {
    stderr: own.slice(0, status.index),
    exitCode: Number(status.groups?.["status"]),
  };
};

/** Kills an exec's process group in the container, as root. Never rejects. */
const killGroup = async (context: ContainerContext, pid: string) =>
  runCli(context.engine, [
    "exec",
    "--user",
    "root",
    context.id,
    "sh",
    "-c",
    'kill -TERM -"$1" 2>/dev/null || kill -TERM "$1"',
    "sh",
    pid,
  ]).catch(() => undefined);

/** Kills the command in the container once `abortSignal` aborts and its pid is known. */
const abortWatch = (
  context: ContainerContext,
  abortSignal: AbortSignal | undefined,
) => {
  let pid: string | undefined;
  let head = "";
  let killed: Promise<unknown> | undefined;
  const kill = () => {
    if (pid !== undefined && abortSignal?.aborted === true) {
      killed ??= killGroup(context, pid);
    }
  };
  abortSignal?.addEventListener("abort", kill, { once: true });
  return {
    onStderr: (chunk: string) => {
      if (pid === undefined) {
        head += chunk;
        pid = PID_LINE.exec(head)?.groups?.["pid"];
        kill();
      }
    },
    /** Whether the command was aborted, once whatever kill it took has run. */
    aborted: async (): Promise<boolean> => {
      abortSignal?.removeEventListener("abort", kill);
      await killed;
      return abortSignal?.aborted === true;
    },
  };
};

/** Runs a command in the container and waits for it, streaming stdout lines to `onLine`. */
export const containerExec = async (
  context: ContainerContext,
  options: ProviderExecOptions,
): Promise<ProviderExecResult> => {
  const env = await envFile(context.engine, { ...context.env, ...options.env });
  const watch = abortWatch(context, options.abortSignal);
  try {
    const result = await runCli(
      context.engine,
      [
        "exec",
        "-i",
        ...(options.sudo === true ? ["--user", "root"] : []),
        "-w",
        options.workingDirectory ?? context.workingDirectory,
        ...env.flags,
        context.id,
        "sh",
        "-c",
        WRAPPER,
        "sh",
        options.command,
      ],
      {
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        ...(options.onLine === undefined ? {} : { onLine: options.onLine }),
        onStderr: watch.onStderr,
      },
    );
    const { stderr, exitCode } = unwrap(result.stderr, result.exitCode);
    const aborted = await watch.aborted();
    return {
      stdout: result.stdout,
      stderr,
      exitCode: aborted ? ABORTED_EXIT_CODE : exitCode,
    };
  } finally {
    await env.remove();
  }
};

/**
 * Starts a command with `<engine> exec -d`: the engine runs it, so it
 * outlives the host process. Resolves once the engine has started it.
 */
export const containerSpawnDetached = async (
  context: ContainerContext,
  options: Pick<ProviderExecOptions, "command" | "workingDirectory" | "env">,
): Promise<void> => {
  const env = await envFile(context.engine, { ...context.env, ...options.env });
  try {
    await runCliOrFail(
      context.engine,
      [
        "exec",
        "-d",
        "-w",
        options.workingDirectory ?? context.workingDirectory,
        ...env.flags,
        context.id,
        "sh",
        "-c",
        options.command,
      ],
      { what: "starting a detached command" },
    );
  } finally {
    await env.remove();
  }
};

/** Reads a text file in the container, or `null` if it doesn't exist. */
export const containerReadTextFile = async (
  context: ContainerContext,
  file: string,
): Promise<string | null> => {
  const result = await runCli(context.engine, [
    "exec",
    context.id,
    "sh",
    "-c",
    `if [ -e "$1" ]; then exec cat -- "$1"; fi; exit ${String(MISSING_EXIT_CODE)}`,
    "sh",
    file,
  ]);
  if (result.exitCode === MISSING_EXIT_CODE) {
    return null;
  }
  if (result.exitCode !== 0) {
    throw cliError(context.engine, `reading ${file}`, result);
  }
  return result.stdout;
};

/** Writes a text file in the container, creating its parent directories. */
export const containerWriteTextFile = async (
  context: ContainerContext,
  file: string,
  content: string,
): Promise<void> => {
  await runCliOrFail(
    context.engine,
    [
      "exec",
      "-i",
      context.id,
      "sh",
      "-c",
      'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"',
      "sh",
      file,
    ],
    { what: `writing ${file}`, stdin: content },
  );
};
