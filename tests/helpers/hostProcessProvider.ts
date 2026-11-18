import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type {
  ProviderExecOptions,
  ProviderExecResult,
  ProviderSandbox,
} from "@ai-hero/sandcastle/v1";
import { createSandboxProvider } from "@ai-hero/sandcastle/v1";
import type { HostCommand } from "@ai-hero/sandcastle/v1/testing";
import { startHostCommand } from "@ai-hero/sandcastle/v1/testing";

// A test-only provider whose sandboxes are folders on this machine, their
// commands run with Sandcastle's own host command runner: `sh -c` on Linux
// and macOS, and on Windows the Windows planner, with no `sh`. It's what
// proves v1 sessions run on a Windows host before there's a provider for it.
// Attached only. No isolation: a test's commands are its own.
//
// On Windows every command's PATH leaves out each directory holding an
// `sh.exe` (Git for Windows puts two on it), so nothing in the sandbox, the
// session supervisor and its agents included, can fall back on one.

const isWindows = process.platform === "win32";

const exists = async (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false,
  );

/** The host's PATH, less every directory with an `sh.exe` on Windows. */
const hostPath = async (): Promise<string> => {
  const dirs = (process.env["PATH"] ?? process.env["Path"] ?? "").split(
    path.delimiter,
  );
  if (!isWindows) {
    return dirs.join(path.delimiter);
  }
  const kept = await Promise.all(
    dirs.map(async (dir) =>
      dir !== "" && (await exists(path.join(dir, "sh.exe"))) ? [] : [dir],
    ),
  );
  return kept.flat().join(path.delimiter);
};

/** What a Windows program needs to start, from the host. */
const WINDOWS_SYSTEM = [
  "SystemRoot",
  "windir",
  "ComSpec",
  "PATHEXT",
  "SystemDrive",
];

/** HOME and the temp dirs inside the folder, and on Windows the system variables. */
const folderEnv = (folder: string): Record<string, string> => {
  const home = path.join(folder, "home");
  const temp = path.join(folder, "tmp");
  if (!isWindows) {
    return { HOME: home, TMPDIR: temp };
  }
  const system = Object.fromEntries(
    WINDOWS_SYSTEM.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  return {
    ...system,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    TEMP: temp,
    TMP: temp,
  };
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
    createInterface({ input: command.stdout }).on("line", onLine);
  }
  return () => ({ stdout: stdout.join(""), stderr: stderr.join("") });
};

interface Folder {
  readonly folder: string;
  readonly workingDirectory: string;
  readonly env: Readonly<Record<string, string>>;
}

const execIn = async (
  sandbox: Folder,
  running: Set<HostCommand>,
  options: ProviderExecOptions,
): Promise<ProviderExecResult> => {
  const command = await startHostCommand({
    command: options.command,
    cwd: options.workingDirectory ?? sandbox.workingDirectory,
    env: { ...sandbox.env, ...options.env, ...folderEnv(sandbox.folder) },
    stdin: options.stdin === undefined ? "ignore" : "pipe",
  });
  running.add(command);
  const output = outputOf(command, options.onLine);
  command.stdin?.on("error", () => undefined).end(options.stdin);
  const abort = (): void => {
    void command.kill();
  };
  options.abortSignal?.addEventListener("abort", abort, { once: true });
  const { exitCode } = await command.exited;
  options.abortSignal?.removeEventListener("abort", abort);
  running.delete(command);
  return { exitCode, ...output() };
};

/** The sandbox for a new folder in `rootDir`. */
const sandboxIn = async (
  rootDir: string,
  options: {
    readonly env: Readonly<Record<string, string>>;
    readonly extraPath: readonly string[];
    readonly timeLimitMinutes: number;
  },
): Promise<ProviderSandbox<{ readonly folder: string }>> => {
  const folder = await mkdtemp(path.join(rootDir, "h-"));
  const workingDirectory = path.join(folder, "work");
  await Promise.all(
    ["work", "home", "tmp"].map(async (dir) =>
      mkdir(path.join(folder, dir), { recursive: true }),
    ),
  );
  const PATH = [...options.extraPath, await hostPath()].join(path.delimiter);
  const sandbox: Folder = {
    folder,
    workingDirectory,
    env: { PATH, ...options.env },
  };
  const running = new Set<HostCommand>();
  return {
    sandboxId: path.basename(folder),
    workingDirectory,
    killTime: new Date(Date.now() + options.timeLimitMinutes * 60_000),
    native: { folder },
    exec: async (exec) => execIn(sandbox, running, exec),
    readTextFile: async ({ path: file }) =>
      readFile(file, "utf8").catch(() => null),
    writeTextFile: async ({ path: file, content }) => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    },
    close: async () => {
      await Promise.all([...running].map(async (command) => command.kill()));
      // On Windows a folder can't go while a process still runs in it.
      await rm(folder, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      });
    },
  };
};

/** Options for the test-only host-process provider. */
export interface HostProcessProviderOptions {
  /** Where sandbox folders go. Default: the test file's temp dir. */
  readonly rootDir?: string;
  /** Directories put on PATH ahead of the host's, e.g. one holding a stub agent CLI. */
  readonly extraPath?: readonly string[];
}

/** The test-only provider: sandboxes that are folders on this machine. */
export const hostProcessProvider = (options: HostProcessProviderOptions = {}) =>
  createSandboxProvider<{ readonly folder: string }>({
    name: "host-process (test)",
    create: async ({ env, timeLimitMinutes }) =>
      sandboxIn(options.rootDir ?? tmpdir(), {
        env,
        extraPath: options.extraPath ?? [],
        timeLimitMinutes,
      }),
  });
