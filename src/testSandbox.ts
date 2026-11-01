/**
 * Test helper: creates a local (filesystem-based) SandboxService for unit tests.
 * This replaces FilesystemSandbox which has been removed.
 */
import { Effect } from "effect";
import { spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { BoundedTail, MAX_TAIL_CHARS } from "./boundedTail.js";
import { CopyError, ExecError } from "./errors.js";
import type { ExecResult, SandboxService } from "./SandboxFactory.js";

/**
 * Creates an isolated git global config env so that test sandbox
 * `git config --global` writes don't corrupt the developer's real ~/.gitconfig.
 */
const createIsolatedGitEnv = (): Record<string, string> => {
  const tmpDir = mkdtempSync(join(tmpdir(), "test-gitconfig-"));
  const globalConfigPath = join(tmpDir, ".gitconfig");
  writeFileSync(globalConfigPath, "");
  return { GIT_CONFIG_GLOBAL: globalConfigPath };
};

export const makeLocalSandbox = (sandboxDir: string): SandboxService => {
  const gitEnv = createIsolatedGitEnv();
  const env = { ...process.env, ...gitEnv };

  return {
    exec: (command, options) =>
      Effect.async<ExecResult, ExecError>((resume) => {
        const spawnOptions = { cwd: options?.cwd ?? sandboxDir, env };
        const stdin = options?.stdin;
        // Two literal `stdio` tuples, so the types know stdout and stderr
        // are always piped.
        const proc =
          stdin === undefined
            ? spawn("sh", ["-c", command], {
                ...spawnOptions,
                stdio: ["ignore", "pipe", "pipe"],
              })
            : spawn("sh", ["-c", command], {
                ...spawnOptions,
                stdio: ["pipe", "pipe", "pipe"],
              });

        if (stdin !== undefined) {
          proc.stdin?.write(stdin);
          proc.stdin?.end();
        }

        proc.on("error", (error: Error) => {
          resume(
            Effect.fail(
              new ExecError({
                command,
                message: `Failed to exec: ${error.message}`,
              }),
            ),
          );
        });

        if (options?.onLine) {
          const { onLine } = options;
          const stdoutTail = new BoundedTail(MAX_TAIL_CHARS, "\n");
          const stderrTail = new BoundedTail(MAX_TAIL_CHARS, "");
          const rl = createInterface({ input: proc.stdout });
          rl.on("line", (line) => {
            stdoutTail.push(line);
            onLine(line);
          });
          proc.stderr.on("data", (chunk: Buffer) => {
            stderrTail.push(chunk.toString());
          });
          proc.on("close", (code: number | null) => {
            resume(
              Effect.succeed({
                stdout: stdoutTail.toString(),
                stderr: stderrTail.toString(),
                exitCode: code ?? 0,
              }),
            );
          });
        } else {
          const stdoutChunks: string[] = [];
          const stderrChunks: string[] = [];
          proc.stdout.on("data", (chunk: Buffer) => {
            stdoutChunks.push(chunk.toString());
          });
          proc.stderr.on("data", (chunk: Buffer) => {
            stderrChunks.push(chunk.toString());
          });
          proc.on("close", (code: number | null) => {
            resume(
              Effect.succeed({
                stdout: stdoutChunks.join(""),
                stderr: stderrChunks.join(""),
                exitCode: code ?? 0,
              }),
            );
          });
        }
      }),
    copyIn: (hostPath, sandboxPath) =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(sandboxPath), { recursive: true });
          await copyFile(hostPath, sandboxPath);
        },
        catch: (e) =>
          new CopyError({
            message: `Failed to copy ${hostPath} -> ${sandboxPath}: ${e instanceof Error ? e.message : String(e)}`,
          }),
      }),

    copyFileOut: (sandboxPath, hostPath) =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(hostPath), { recursive: true });
          await copyFile(sandboxPath, hostPath);
        },
        catch: (e) =>
          new CopyError({
            message: `Failed to copy ${sandboxPath} -> ${hostPath}: ${e instanceof Error ? e.message : String(e)}`,
          }),
      }),
  };
};
