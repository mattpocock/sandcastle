import { spawn } from "node:child_process";
import type { ChildProcess, StdioOptions } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:os";
import { win32 } from "node:path";
import type { Readable, Writable } from "node:stream";
import { planWindowsExec } from "./windowsCommand.js";

// A command string run as a process on the machine this code runs on: the
// supervisor's agents, inside any sandbox, and a host-process sandbox's own
// commands. On Linux and macOS it's `sh -c` in a process group of its own,
// killed by group. Windows has no `sh`: a simple command (leading
// `export K=v;`, then argv) is spawned straight from its argv, a `.cmd` or
// `.bat` through cmd.exe with batch escaping, anything else goes to cmd.exe
// as written, and a kill takes the whole process tree with `taskkill`.

/** What to run, where, and with what env. */
export interface HostCommandOptions {
  /** A POSIX shell command. On Windows, only a simple command runs unchanged. */
  readonly command: string;
  /** Absolute directory to run in. */
  readonly cwd: string;
  /** The command's whole env. On Windows, `export K=v;` statements in `command` are added to it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Pipe stdin, or give the command none. */
  readonly stdin: "pipe" | "ignore";
}

/** How a host command ended. */
export interface HostCommandExit {
  /** Its exit code; 128 plus the signal's number when a signal ended it. */
  readonly exitCode: number;
  /** Why it couldn't be started, when it couldn't. */
  readonly error?: string;
}

/** A running host command. */
export interface HostCommand {
  /** Its process id, once started: the root of the tree `kill` takes. */
  readonly pid: number | undefined;
  /** Its stdin, when piped. */
  readonly stdin: Writable | null;
  /** Its stdout. */
  readonly stdout: Readable;
  /** Its stderr. */
  readonly stderr: Readable;
  /** Resolves once it has exited and its output has closed. */
  readonly exited: Promise<HostCommandExit>;
  /** Kills it and every process it started. Resolves once the kill has been sent. */
  readonly kill: () => Promise<void>;
}

const isWindows = process.platform === "win32";

const exitCodeOf = (code: number | null, signal: string | null): number => {
  if (code !== null) {
    return code;
  }
  const signals: Readonly<Record<string, number>> = constants.signals;
  return 128 + (signal === null ? 0 : (signals[signal] ?? 0));
};

/** `taskkill`, by absolute path where Windows says where it is. */
export const taskkill = (env: HostCommandOptions["env"]): string => {
  const root = env["SystemRoot"];
  return root === undefined
    ? "taskkill"
    : win32.join(root, "System32", "taskkill.exe");
};

/** Kills `pid` and its whole tree: by process group off Windows, `taskkill /T` on it. */
const killHostTree = async (
  pid: number | undefined,
  env: HostCommandOptions["env"],
): Promise<void> => {
  if (pid === undefined) {
    return;
  }
  if (!isWindows) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // It has already exited.
    }
    return;
  }
  const killer = spawn(taskkill(env), ["/T", "/F", "/PID", String(pid)], {
    stdio: "ignore",
    windowsHide: true,
  });
  // An "error" rejects `once`: a taskkill that couldn't start. Nothing to do.
  await once(killer, "close").catch(() => undefined);
};

const spawnChild = async (
  options: HostCommandOptions,
): Promise<ChildProcess> => {
  const stdio: StdioOptions = [options.stdin, "pipe", "pipe"];
  if (!isWindows) {
    return spawn("sh", ["-c", options.command], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio,
    });
  }
  const plan = await planWindowsExec(options.command, options.env, options.cwd);
  return spawn(plan.file, plan.args, {
    cwd: options.cwd,
    env: plan.env,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
    windowsHide: true,
    stdio,
  });
};

/** Listens for its exit, at once: a spawn error comes on the next tick. */
const exitOf = async (child: ChildProcess): Promise<HostCommandExit> =>
  // An "error" rejects `once`: a command that couldn't be started.
  once(child, "close").then(
    ([code, signal]: unknown[]) => ({
      exitCode: exitCodeOf(
        typeof code === "number" ? code : null,
        typeof signal === "string" ? signal : null,
      ),
    }),
    (error: unknown) => ({
      exitCode: 127,
      error: error instanceof Error ? error.message : String(error),
    }),
  );

/**
 * Starts `command` on this machine: `sh -c` in its own process group on Linux
 * and macOS, and on Windows, with no `sh`, through the Windows planner.
 * Rejects when Windows can't carry it: a `.cmd` or `.bat` handed an argument
 * with a newline, or a command line over cmd.exe's 8191 characters.
 */
export const startHostCommand = async (
  options: HostCommandOptions,
): Promise<HostCommand> => {
  const child = await spawnChild(options);
  const exited = exitOf(child);
  const { stdout, stderr } = child;
  if (stdout === null || stderr === null) {
    throw new TypeError("a host command's stdout and stderr are piped");
  }
  return {
    pid: child.pid,
    stdin: child.stdin,
    stdout,
    stderr,
    exited,
    kill: async () => killHostTree(child.pid, options.env),
  };
};
