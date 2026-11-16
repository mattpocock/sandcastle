/**
 * No-sandbox provider — runs the agent directly on the host with no container isolation.
 *
 * Usage:
 *   import { noSandbox } from "sandcastle/sandboxes/no-sandbox";
 *   await run({ agent: claudeCode("claude-opus-4-8"), sandbox: noSandbox(), prompt: "…" });
 *
 * Accepted by `run()` and `createSandbox()`. Skips
 * container isolation entirely — the agent executes on the host. Does not
 * pass `--dangerously-skip-permissions` to the agent — the user manages
 * permissions themselves.
 */

import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type {
  NoSandboxProvider,
  NoSandboxHandle,
  ExecResult,
} from "../SandboxProvider.js";
import { BoundedTail, MAX_TAIL_CHARS } from "../boundedTail.js";
import { planWindowsExec } from "./windowsCommand.js";
import type { SpawnPlan } from "./windowsCommand.js";

export interface NoSandboxOptions {
  /** Environment variables injected by this provider. Merged at launch time. */
  readonly env?: Record<string, string>;
  /**
   * Maximum number of characters of streamed `exec` output retained per stream
   * (stdout and stderr) when an `onLine` callback is supplied (default: 64KiB).
   *
   * Output is delivered live to `onLine` regardless; this only bounds the tail
   * returned in `ExecResult`, preventing a long-running agent's output from
   * overflowing V8's max string length and crashing the run.
   */
  readonly maxOutputTailChars?: number;
}

type ProcessEnv = Record<string, string | undefined>;

/** A spawn plan for `exec`, with the env the command runs under. */
type ExecPlan = SpawnPlan & { readonly env: ProcessEnv };

interface ExecOptions {
  onLine?: (line: string) => void;
  cwd?: string;
  sudo?: boolean;
  stdin?: string;
}

/** What a handle's `exec` needs from its host. */
interface HostContext {
  readonly worktreePath: string;
  readonly processEnv: ProcessEnv;
  readonly maxOutputTailChars: number;
}

/** A spawned `exec` process: stdout and stderr are always piped. */
type ExecProcess = ChildProcessByStdio<Writable | null, Readable, Readable>;

/**
 * Attaches output listeners to a process whose stdout and stderr emit UTF-8
 * strings; call the result on close for the output.
 */
type OutputCollector = (proc: ExecProcess) => () => {
  stdout: string;
  stderr: string;
};

const planExec = async (
  command: string,
  env: ProcessEnv,
  cwd: string,
): Promise<ExecPlan> =>
  // Windows has no `sh`, and cmd.exe doesn't understand the POSIX
  // quoting in Sandcastle's commands (#940): run simple commands as a
  // direct spawn of their argv, and only the rest through cmd.exe.
  process.platform === "win32"
    ? planWindowsExec(command, env, cwd)
    : {
        file: "sh",
        args: ["-c", command],
        windowsVerbatimArguments: false,
        env,
      };

const spawnExec = (
  plan: ExecPlan,
  cwd: string,
  stdin: string | undefined,
): ExecProcess => {
  const spawnOptions = {
    cwd,
    env: plan.env,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
  };
  // Two literal `stdio` tuples, so the types know stdout and stderr
  // are always piped.
  if (stdin === undefined) {
    return spawn(plan.file, plan.args, {
      ...spawnOptions,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  const proc = spawn(plan.file, plan.args, {
    ...spawnOptions,
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stdin.write(stdin);
  proc.stdin.end();
  return proc;
};

/** Streams stdout to `onLine` line by line, keeping only a bounded tail. */
const streamLines =
  (onLine: (line: string) => void, maxTailChars: number): OutputCollector =>
  (proc) => {
    const stdoutTail = new BoundedTail(maxTailChars, "\n");
    const stderrTail = new BoundedTail(maxTailChars, "");
    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      stdoutTail.push(line);
      onLine(line);
    });
    proc.stderr.on("data", (chunk: string) => {
      stderrTail.push(chunk);
    });
    return () => ({
      stdout: stdoutTail.toString(),
      stderr: stderrTail.toString(),
    });
  };

/** Buffers all of stdout and stderr. */
const bufferAll: OutputCollector = (proc) => {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  proc.stdout.on("data", (chunk: string) => {
    stdoutChunks.push(chunk);
  });
  proc.stderr.on("data", (chunk: string) => {
    stderrChunks.push(chunk);
  });
  return () => ({
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  });
};

const waitForExec = async (
  proc: ExecProcess,
  collect: OutputCollector,
): Promise<ExecResult> =>
  new Promise((resolve, reject) => {
    proc.on("error", (error: Error) => {
      reject(new Error(`exec failed: ${error.message}`));
    });
    // Decode as UTF-8 streams, so a multi-byte character split across two
    // chunks is joined back up instead of becoming replacement characters.
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    const output = collect(proc);
    proc.on("close", (code: number | null) => {
      resolve({ ...output(), exitCode: code ?? 0 });
    });
  });

const runExec = async (
  command: string,
  opts: ExecOptions | undefined,
  context: HostContext,
): Promise<ExecResult> => {
  // sudo is a no-op for no-sandbox — the user is already on the host
  const cwd = opts?.cwd ?? context.worktreePath;
  const plan = await planExec(command, context.processEnv, cwd);
  const proc = spawnExec(plan, cwd, opts?.stdin);
  const collect = opts?.onLine
    ? streamLines(opts.onLine, context.maxOutputTailChars)
    : bufferAll;
  return waitForExec(proc, collect);
};

/**
 * Create a no-sandbox provider.
 *
 * The returned provider runs the agent directly on the host. All three
 * branch strategies are supported (head, merge-to-head, branch),
 * defaulting to head.
 */
export const noSandbox = (options?: NoSandboxOptions): NoSandboxProvider => ({
  tag: "none",
  name: "no-sandbox",
  env: options?.env ?? {},
  create: async (createOptions): Promise<NoSandboxHandle> => {
    const { worktreePath } = createOptions;
    const context: HostContext = {
      worktreePath,
      processEnv: { ...process.env, ...createOptions.env },
      maxOutputTailChars: options?.maxOutputTailChars ?? MAX_TAIL_CHARS,
    };

    const handle: NoSandboxHandle = {
      worktreePath,
      exec: async (command: string, opts?: ExecOptions): Promise<ExecResult> =>
        runExec(command, opts, context),
      close: async (): Promise<void> => {
        // No-op — no container to tear down
      },
    };

    return handle;
  },
});
