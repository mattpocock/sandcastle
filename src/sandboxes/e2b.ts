/**
 * E2B isolated sandbox provider — wraps the `e2b` SDK into a SandboxProvider.
 *
 * Usage:
 *   import { e2b } from "@ai-hero/sandcastle/sandboxes/e2b";
 *   await run({ agent: claudeCode("claude-opus-4-8"), sandbox: e2b() });
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { openAsBlob } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  CommandExitError,
  CommandHandle,
  Sandbox,
  SandboxOpts,
} from "e2b";
import { shellEscape } from "../AgentProvider.js";
import { createIsolatedSandboxProvider } from "../SandboxProvider.js";
import type {
  ExecResult,
  IsolatedSandboxHandle,
  IsolatedSandboxProvider,
} from "../SandboxProvider.js";
import { BoundedTail, MAX_TAIL_CHARS } from "../boundedTail.js";

/** Pack `dir` into a gzipped tarball at `archive` on the host. */
const tarDirectory = async (archive: string, dir: string): Promise<void> => {
  const child = spawn("tar", ["-czf", archive, "-C", dir, "."], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  await once(child, "close");
  if (child.exitCode !== 0) {
    throw new Error(
      `tar exited with ${String(child.exitCode)}: ${stderr.trim()}`,
    );
  }
};

/** The SDK's error class for a non-zero exit, loaded with the SDK at runtime. */
type ExitErrorClass = typeof CommandExitError;
type ExecOptions = Parameters<IsolatedSandboxHandle["exec"]>[1];

/**
 * Options for the E2B sandbox provider.
 *
 * All `Sandbox.create()` options from the `e2b` SDK are accepted as
 * pass-through (`template`, `timeoutMs`, `apiKey`, `metadata`, `network`, ...),
 * except `envs` and `lifecycle`, which the provider controls.
 *
 * `timeoutMs` defaults to 30 minutes. The sandbox is killed when it expires,
 * so it must cover setup, the agent run, and syncing changes back.
 */
export interface E2BOptions extends Omit<SandboxOpts, "envs" | "lifecycle"> {
  /** Environment variables injected by this provider. Merged at launch time with env resolver and agent provider env. */
  readonly env?: Record<string, string>;

  /**
   * Maximum number of characters of streamed `exec` output retained per stream
   * (stdout and stderr) when an `onLine` callback is supplied (default: 64KiB).
   *
   * Output is delivered live to `onLine` regardless; this only bounds the tail
   * returned in `ExecResult`.
   */
  readonly maxOutputTailChars?: number;
}

/** Run a setup command to completion and return its stdout. */
const runToEnd = async (sandbox: Sandbox, command: string): Promise<string> => {
  const result = await sandbox.commands.run(command, { timeoutMs: 0 });
  return result.stdout;
};

/** Create `$HOME/workspace`, killing the sandbox if setup fails. */
const prepareWorktree = async (sandbox: Sandbox): Promise<string> => {
  try {
    const out = await runToEnd(
      sandbox,
      'mkdir -p "$HOME/workspace" && cd "$HOME/workspace" && pwd',
    );
    return out.trim();
  } catch (error) {
    await sandbox.kill().catch(() => undefined);
    throw error;
  }
};

/** Send the prompt and close stdin. The command may exit before reading it. */
const deliverStdin = async (
  handle: CommandHandle,
  stdin: string,
): Promise<void> => {
  try {
    if (stdin !== "") {
      await handle.sendStdin(stdin);
    }
    await handle.closeStdin();
  } catch (error) {
    // wait() still reports the result of a command that already exited. The
    // SDK reports a missing process as its base NotFoundError.
    if (!(error instanceof Error && error.name === "NotFoundError")) {
      await handle.kill().catch(() => undefined);
      throw error;
    }
  }
};

/** Wait for a command, mapping a non-zero exit to its result. */
const waitForExit = async (
  ExitError: ExitErrorClass,
  handle: CommandHandle,
): Promise<ExecResult> => {
  try {
    const { stdout, stderr, exitCode } = await handle.wait();
    return { stdout, stderr, exitCode };
  } catch (error) {
    if (!(error instanceof ExitError)) {
      throw error;
    }
    const { stdout, stderr, exitCode } = error;
    return { stdout, stderr, exitCode };
  }
};

/** Split streamed stdout into lines for `onLine`, keeping bounded tails. */
const lineStreams = (onLine: (line: string) => void, maxTail: number) => {
  const stdoutTail = new BoundedTail(maxTail, "\n");
  const stderrTail = new BoundedTail(maxTail, "");
  let partial = "";
  return {
    onStdout: (chunk: string): void => {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        stdoutTail.push(line);
        onLine(line);
      }
    },
    onStderr: (chunk: string): void => {
      stderrTail.push(chunk);
    },
    finish: (exitCode: number): ExecResult => {
      if (partial !== "") {
        stdoutTail.push(partial);
        onLine(partial);
      }
      return {
        stdout: stdoutTail.toString(),
        stderr: stderrTail.toString(),
        exitCode,
      };
    },
  };
};

interface ExecContext {
  readonly ExitError: ExitErrorClass;
  readonly sandbox: Sandbox;
  readonly worktreePath: string;
  readonly maxTail: number;
}

const makeExec =
  ({ ExitError, sandbox, worktreePath, maxTail }: ExecContext) =>
  async (command: string, opts?: ExecOptions): Promise<ExecResult> => {
    const streams =
      opts?.onLine === undefined
        ? undefined
        : lineStreams(opts.onLine, maxTail);
    const handle = await sandbox.commands.run(command, {
      background: true,
      cwd: opts?.cwd ?? worktreePath,
      ...(opts?.sudo === true ? { user: "root" } : {}),
      stdin: opts?.stdin !== undefined,
      timeoutMs: 0,
      ...(streams === undefined
        ? {}
        : { onStdout: streams.onStdout, onStderr: streams.onStderr }),
    });
    if (opts?.stdin !== undefined) {
      await deliverStdin(handle, opts.stdin);
    }
    const result = await waitForExit(ExitError, handle);
    return streams === undefined ? result : streams.finish(result.exitCode);
  };

const makeCopyIn =
  (sandbox: Sandbox) =>
  async (hostPath: string, sandboxPath: string): Promise<void> => {
    const info = await stat(hostPath);
    if (!info.isDirectory()) {
      await sandbox.files.write(sandboxPath, await openAsBlob(hostPath));
      // files.write keeps an existing file's mode, so always apply the host's
      const mode = (info.mode % 0o1000).toString(8);
      await runToEnd(sandbox, `chmod ${mode} ${shellEscape(sandboxPath)}`);
      return;
    }

    const id = crypto.randomUUID();
    const tarPath = join(tmpdir(), `sandcastle-copyin-${id}.tar.gz`);
    const sandboxTarPath = `/tmp/sandcastle-copyin-${id}.tar.gz`;
    try {
      await tarDirectory(tarPath, hostPath);
      await sandbox.files.write(sandboxTarPath, await openAsBlob(tarPath));
      const tar = shellEscape(sandboxTarPath);
      const dest = shellEscape(sandboxPath);
      // Remove the archive even if extraction fails, keeping its exit code
      await runToEnd(
        sandbox,
        `mkdir -p ${dest} && tar -xzf ${tar} -C ${dest}; s=$?; rm -f ${tar}; exit $s`,
      );
    } finally {
      await rm(tarPath, { force: true });
    }
  };

/**
 * Create an E2B isolated sandbox provider.
 *
 * Each sandbox is ephemeral — `create()` starts a new E2B sandbox and
 * `close()` kills it. Requires `e2b` to be installed as a peer dependency
 * and `E2B_API_KEY` in the host environment (or the `apiKey` option).
 */
export const e2b = (options?: E2BOptions): IsolatedSandboxProvider => {
  const {
    env,
    maxOutputTailChars: maxTail = MAX_TAIL_CHARS,
    ...sdkOptions
  } = options ?? {};
  return createIsolatedSandboxProvider({
    name: "e2b",
    env,
    create: async (createOptions): Promise<IsolatedSandboxHandle> => {
      // Dynamic import so the peer dependency is only loaded at runtime
      const { Sandbox: E2BSandbox, CommandExitError: ExitError } = await import(
        "e2b"
      );
      const sandbox = await E2BSandbox.create({
        ...sdkOptions,
        timeoutMs: sdkOptions.timeoutMs ?? 30 * 60 * 1000,
        envs: createOptions.env,
        lifecycle: { onTimeout: "kill", autoResume: false },
      });
      const worktreePath = await prepareWorktree(sandbox);

      return {
        worktreePath,
        sandboxId: sandbox.sandboxId,
        exec: makeExec({ ExitError, sandbox, worktreePath, maxTail }),
        copyIn: makeCopyIn(sandbox),
        copyFileOut: async (sandboxPath, hostPath) => {
          const content = await sandbox.files.read(sandboxPath, {
            format: "bytes",
          });
          await mkdir(dirname(hostPath), { recursive: true });
          await writeFile(hostPath, content);
        },
        close: async () => {
          await sandbox.kill();
        },
      };
    },
  });
};
