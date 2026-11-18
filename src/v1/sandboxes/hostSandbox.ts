import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { registerShutdown } from "../../shutdownRegistry.js";
import type { HostCommand } from "../hostCommand.js";
import { startHostCommand, taskkill } from "../hostCommand.js";
import type {
  ProviderCreateOptions,
  ProviderExecOptions,
  ProviderExecResult,
  ProviderSandbox,
} from "../SandboxProvider.js";
import { commandEnv, hostBaseEnv } from "./hostEnv.js";

// A host() sandbox: a private folder on this machine, `<rootDir>/<id>/`,
// holding `workspace/` (the working directory, empty at create), `home/` and
// `tmp/`. Its commands run as the calling user through Sandcastle's host
// command runner, with no isolation. It lives only as long as the process
// that holds it: a timer ends it at the kill time, and the shutdown registry
// ends it when the process exits.

const isWindows = process.platform === "win32";

/** A `setTimeout` delay can't be longer than this; a later kill time is waited for in steps. */
const MAX_TIMER_MS = 2_147_483_647;

/** What a host() sandbox exposes as `native`. */
export interface HostNative {
  /** The sandbox's folder on this machine: `workspace/`, `home/` and `tmp/` are in it. */
  readonly folder: string;
}

/**
 * Removes `folder` once the trees rooted at `pids` are killed, from a
 * detached Node process: a shutdown teardown must be synchronous, and on
 * Windows a folder can't go while a process still runs in it.
 */
const CLEANUP_SCRIPT = `
const { execFileSync } = require("node:child_process");
const [taskkill, folder, ...pids] = process.argv.slice(1);
for (const pid of pids) {
  try { execFileSync(taskkill, ["/T", "/F", "/PID", pid], { stdio: "ignore", windowsHide: true }); } catch {}
}
require("node:fs").rmSync(folder, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
`;

/** Ends a sandbox from a shutdown teardown, synchronously: what `close()` does, without awaiting. */
const tearDownNow = (folder: string, running: ReadonlySet<HostCommand>) => {
  const pids = [...running].flatMap((command) =>
    command.pid === undefined ? [] : [command.pid],
  );
  if (!isWindows) {
    for (const pid of pids) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // It has already exited.
      }
    }
  }
  spawn(
    process.execPath,
    [
      "-e",
      CLEANUP_SCRIPT,
      taskkill(hostBaseEnv()),
      folder,
      ...(isWindows ? pids.map(String) : []),
    ],
    { detached: true, stdio: "ignore", windowsHide: true },
  ).unref();
};

/** Collects a command's output, streaming stdout's lines to `onLine`. */
const outputOf = (
  command: HostCommand,
  onLine: ((line: string) => void) | undefined,
) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  command.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout.push(chunk);
  });
  command.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr.push(chunk);
  });
  if (onLine !== undefined) {
    createInterface({ input: command.stdout, crlfDelay: Infinity }).on(
      "line",
      onLine,
    );
  }
  return () => ({ stdout: stdout.join(""), stderr: stderr.join("") });
};

interface HostFolder {
  readonly folder: string;
  readonly workingDirectory: string;
  readonly env: Readonly<Record<string, string>>;
  readonly running: Set<HostCommand>;
  readonly isClosed: () => boolean;
}

const execIn = async (
  sandbox: HostFolder,
  options: ProviderExecOptions,
): Promise<ProviderExecResult> => {
  if (options.sudo === true) {
    throw new Error(
      "host() has no root: exec with `sudo: true` isn't supported. Commands run as you; install what you need on the host yourself.",
    );
  }
  if (sandbox.isClosed()) {
    throw new Error(
      `host(): sandbox ${path.basename(sandbox.folder)} is closed`,
    );
  }
  const cwd = options.workingDirectory ?? sandbox.workingDirectory;
  const command = await startHostCommand({
    command: options.command,
    cwd,
    env: commandEnv({
      folder: sandbox.folder,
      cwd,
      sandboxEnv: sandbox.env,
      env: options.env,
    }),
    stdin: "pipe",
  });
  sandbox.running.add(command);
  const output = outputOf(command, options.onLine);
  // Stdin is piped, given what the caller wrote, then closed.
  command.stdin?.on("error", () => undefined).end(options.stdin ?? "");
  const abort = (): void => {
    void command.kill();
  };
  if (options.abortSignal?.aborted === true) {
    abort();
  }
  options.abortSignal?.addEventListener("abort", abort, { once: true });
  const { exitCode, error } = await command.exited;
  options.abortSignal?.removeEventListener("abort", abort);
  sandbox.running.delete(command);
  const result = output();
  return {
    exitCode,
    stdout: result.stdout,
    stderr: error === undefined ? result.stderr : `${result.stderr}${error}\n`,
  };
};

/** A missing file reads as `null`; any other failure is the caller's to see. */
const readOrNull = async (file: string): Promise<string | null> =>
  readFile(file, "utf8").catch((error: unknown) => {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return null;
    }
    throw error;
  });

/** Calls `end` at `killTime`, without keeping the process alive for it. */
const timerUntil = (killTime: Date, end: () => void) => {
  let timer: NodeJS.Timeout | undefined;
  const arm = (): void => {
    const left = killTime.getTime() - Date.now();
    if (left <= 0) {
      end();
      return;
    }
    timer = setTimeout(arm, Math.min(left, MAX_TIMER_MS));
    timer.unref();
  };
  arm();
  return () => {
    clearTimeout(timer);
  };
};

/** Removes a folder; on Windows it can't go until its last process has. */
const removeFolder = async (folder: string): Promise<void> =>
  rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });

/** Makes the folder for a new sandbox in `rootDir`, removing it again if that fails partway. */
const makeFolder = async (
  rootDir: string,
  abortSignal: AbortSignal | undefined,
): Promise<string> => {
  await mkdir(rootDir, { recursive: true });
  const folder = await mkdtemp(path.join(rootDir, "host-"));
  try {
    await Promise.all(
      ["workspace", "home", "tmp"].map(async (dir) =>
        mkdir(path.join(folder, dir)),
      ),
    );
    abortSignal?.throwIfAborted();
  } catch (error) {
    await removeFolder(folder);
    throw error;
  }
  return folder;
};

/** A new host() sandbox, a folder in `rootDir`. */
export const createHostSandbox = async (
  rootDir: string,
  options: ProviderCreateOptions,
): Promise<ProviderSandbox<HostNative>> => {
  options.abortSignal?.throwIfAborted();
  const folder = await makeFolder(rootDir, options.abortSignal);
  const killTime = new Date(Date.now() + options.timeLimitMinutes * 60_000);
  const running = new Set<HostCommand>();
  let closing: Promise<void> | undefined;
  let stopTimer: () => void = () => undefined;
  const sandbox: HostFolder = {
    folder,
    workingDirectory: path.join(folder, "workspace"),
    env: options.env,
    running,
    isClosed: () => closing !== undefined,
  };
  const unregister = registerShutdown(() => {
    tearDownNow(folder, running);
  });
  const close = async (): Promise<void> => {
    closing ??= (async () => {
      stopTimer();
      unregister();
      await Promise.all([...running].map(async (command) => command.kill()));
      await removeFolder(folder);
    })();
    return closing;
  };
  stopTimer = timerUntil(killTime, () => {
    void close();
  });
  return {
    sandboxId: path.basename(folder),
    workingDirectory: sandbox.workingDirectory,
    killTime,
    native: { folder },
    exec: async (exec) => execIn(sandbox, exec),
    readTextFile: async ({ path: file }) => readOrNull(file),
    writeTextFile: async ({ path: file, content }) => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    },
    close,
  };
};
