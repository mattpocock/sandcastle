import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Runs the `sandcastle` CLI from source, the way a user runs the built bin:
 * a separate Node process, here loading src/main.ts through tsx. Nothing from
 * the source tree is imported into the test, so the tests stay on the public
 * side of the package boundary.
 */

/** src/main.ts, the CLI entry. A path handed to a subprocess, not an import. */
const CLI_ENTRY = join(import.meta.dirname, "..", "..", "src", "main.ts");

/**
 * tsx's loader as a file URL. `node --import <url>` works the same on every
 * OS (no `.cmd` shim on Windows), and an absolute URL resolves from any cwd,
 * including a temp repo with no node_modules.
 */
const TSX_LOADER = pathToFileURL(
  createRequire(import.meta.url).resolve("tsx"),
).href;

/** What a CLI run left behind. */
export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `sandcastle <args>` in `cwd` with no TTY: stdin is an empty pipe, so
 * the CLI takes its non-interactive path and every choice must come from a
 * flag. Resolves when the process exits, whatever its exit code.
 */
export const runCli = async (
  args: readonly string[],
  options: { readonly cwd: string },
): Promise<CliResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", TSX_LOADER, CLI_ENTRY, ...args],
      {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        exitCode: code ?? (signal === null ? 1 : 128),
        stdout,
        stderr,
      });
    });
    child.stdin.end();
  });

/** A fresh git repo in a temp dir, with one commit on `main`. */
export const createTempGitRepo = (): {
  readonly dir: string;
  readonly cleanup: () => void;
} => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-cli-"));
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  git("init", "-b", "main");
  git("commit", "--allow-empty", "-m", "init");
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
