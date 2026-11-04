import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type {
  ProviderExecOptions,
  ProviderExecResult,
} from "./SandboxProvider.js";
import { killGroup, recordGroup } from "./fakeSandboxState.js";

/** Where a fake sandbox's commands run, and with what env. */
export interface FakeProcessContext {
  /** The sandbox's directory. */
  readonly dir: string;
  /** The host's PATH, so `sh` finds tools. */
  readonly hostPath: string;
  /** The sandbox's env. */
  readonly env: Readonly<Record<string, string>>;
}

const commandEnv = (
  context: FakeProcessContext,
  extra: Readonly<Record<string, string>> | undefined,
): Record<string, string> => ({
  PATH: context.hostPath,
  ...context.env,
  ...extra,
  HOME: path.join(context.dir, "home"),
  TMPDIR: path.join(context.dir, "tmp"),
});

/**
 * Starts `sh -c command` in its own process group. `recorded` settles once
 * the group is on disk for close(); attach listeners before awaiting it.
 */
export const startProcess = (
  context: FakeProcessContext,
  options: Pick<
    ProviderExecOptions,
    "command" | "workingDirectory" | "env" | "stdin"
  >,
  stdio: "pipe" | "ignore",
) => {
  const child = spawn("sh", ["-c", options.command], {
    cwd: path.resolve(
      path.join(context.dir, "work"),
      options.workingDirectory ?? ".",
    ),
    env: commandEnv(context, options.env),
    detached: true,
    stdio: [options.stdin === undefined ? "ignore" : "pipe", stdio, stdio],
  });
  const recorded =
    child.pid === undefined
      ? Promise.resolve()
      : recordGroup(context.dir, child.pid);
  return { child, recorded };
};

const exitCodeOf = (code: unknown, signal: unknown): number => {
  if (typeof code === "number") {
    return code;
  }
  const signals: Readonly<Record<string, number>> = constants.signals;
  return 128 + (typeof signal === "string" ? (signals[signal] ?? 0) : 0);
};

/** Runs a command in a fake sandbox and waits for it. */
export const runProcess = async (
  context: FakeProcessContext,
  options: ProviderExecOptions,
): Promise<ProviderExecResult> => {
  const { child, recorded } = startProcess(context, options, "pipe");
  const closed: Promise<unknown[]> = once(child, "close");
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout.push(chunk);
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr.push(chunk);
  });
  const { onLine } = options;
  if (onLine !== undefined && child.stdout !== null) {
    createInterface({ input: child.stdout }).on("line", onLine);
  }
  // A command that exits without reading its stdin closes the pipe early.
  child.stdin?.on("error", () => undefined).end(options.stdin);
  const abort = (): void => {
    if (child.pid !== undefined) {
      killGroup(child.pid);
    }
  };
  options.abortSignal?.addEventListener("abort", abort, { once: true });
  await recorded;
  const [code, signal] = await closed;
  options.abortSignal?.removeEventListener("abort", abort);
  return {
    exitCode: exitCodeOf(code, signal),
    stdout: stdout.join(""),
    stderr: stderr.join(""),
  };
};

/** Starts a command that runs on after the host lets go of the sandbox. */
export const spawnDetachedProcess = async (
  context: FakeProcessContext,
  options: Pick<ProviderExecOptions, "command" | "workingDirectory" | "env">,
) => {
  const { child, recorded } = startProcess(context, options, "ignore");
  child.unref();
  await recorded;
};
