/**
 * No-sandbox provider — runs the agent directly on the host with no container isolation.
 *
 * Usage:
 *   import { noSandbox } from "sandcastle/sandboxes/no-sandbox";
 *   await interactive({ agent: claudeCode("claude-opus-4-8"), sandbox: noSandbox() });
 *
 * Accepted by `run()`, `interactive()`, and `createSandbox()`. Skips
 * container isolation entirely — the agent executes on the host. Does not
 * pass `--dangerously-skip-permissions` to the agent — the user manages
 * permissions themselves.
 */

import { spawn, type StdioOptions } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  NoSandboxProvider,
  NoSandboxHandle,
  ExecResult,
  InteractiveExecOptions,
} from "../SandboxProvider.js";
import { BoundedTail, MAX_TAIL_CHARS } from "../boundedTail.js";

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
    const worktreePath = createOptions.worktreePath;
    const processEnv = { ...process.env, ...createOptions.env };
    const maxOutputTailChars = options?.maxOutputTailChars ?? MAX_TAIL_CHARS;

    const handle: NoSandboxHandle = {
      worktreePath,

      exec: (
        command: string,
        opts?: {
          onLine?: (line: string) => void;
          cwd?: string;
          sudo?: boolean;
          stdin?: string;
        },
      ): Promise<ExecResult> => {
        // sudo is a no-op for no-sandbox — the user is already on the host
        const cwd = opts?.cwd ?? worktreePath;
        const isWindows = process.platform === "win32";
        // PowerShell and cmd.exe don't ship `sh`, so on Windows route the
        // command string through cmd.exe instead. `/d` skips AutoRun, `/s`
        // preserves the quoted command verbatim, `/c` runs it and exits.
        // `windowsVerbatimArguments` keeps Node from re-quoting our args.
        const shellCmd = isWindows ? "cmd.exe" : "sh";
        const shellArgs = isWindows
          ? ["/d", "/s", "/c", command]
          : ["-c", command];

        return new Promise((resolve, reject) => {
          const proc = spawn(shellCmd, shellArgs, {
            cwd,
            env: processEnv,
            stdio: [
              opts?.stdin !== undefined ? "pipe" : "ignore",
              "pipe",
              "pipe",
            ],
            windowsVerbatimArguments: isWindows,
          });

          if (opts?.stdin !== undefined) {
            proc.stdin!.write(opts.stdin);
            proc.stdin!.end();
          }

          proc.on("error", (error) => {
            reject(new Error(`exec failed: ${error.message}`));
          });

          if (opts?.onLine) {
            const onLine = opts.onLine;
            const stdoutTail = new BoundedTail(maxOutputTailChars, "\n");
            const stderrTail = new BoundedTail(maxOutputTailChars, "");
            const rl = createInterface({ input: proc.stdout! });
            rl.on("line", (line) => {
              stdoutTail.push(line);
              onLine(line);
            });
            proc.stderr!.on("data", (chunk: Buffer) => {
              stderrTail.push(chunk.toString());
            });
            proc.on("close", (code) => {
              resolve({
                stdout: stdoutTail.toString(),
                stderr: stderrTail.toString(),
                exitCode: code ?? 0,
              });
            });
          } else {
            const stdoutChunks: string[] = [];
            const stderrChunks: string[] = [];
            proc.stdout!.on("data", (chunk: Buffer) => {
              stdoutChunks.push(chunk.toString());
            });
            proc.stderr!.on("data", (chunk: Buffer) => {
              stderrChunks.push(chunk.toString());
            });
            proc.on("close", (code) => {
              resolve({
                stdout: stdoutChunks.join(""),
                stderr: stderrChunks.join(""),
                exitCode: code ?? 0,
              });
            });
          }
        });
      },

      interactiveExec: (
        args: string[],
        opts: InteractiveExecOptions,
      ): Promise<{ exitCode: number }> => {
        return new Promise((resolve, reject) => {
          const [cmd, ...rest] = args;
          // Agent CLIs on Windows are typically installed as `.cmd`/`.ps1`
          // npm wrappers; bare `spawn("claude", …)` only resolves `.exe`
          // without `shell: true`, so let cmd.exe handle PATHEXT lookup.
          const proc = spawn(cmd!, rest, {
            cwd: opts.cwd ?? worktreePath,
            env: processEnv,
            stdio: [opts.stdin, opts.stdout, opts.stderr] as StdioOptions,
            shell: process.platform === "win32",
          });

          proc.on("error", (error: Error) => {
            reject(new Error(`exec failed: ${error.message}`));
          });

          proc.on("close", (code: number | null) => {
            resolve({ exitCode: code ?? 0 });
          });
        });
      },

      close: async (): Promise<void> => {
        // No-op — no container to tear down
      },
    };

    return handle;
  },
});
