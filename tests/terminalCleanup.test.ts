import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// The `sandcastle` CLI leaves the terminal usable on exit: clack's spinners
// hide the cursor and put stdin in raw mode, so every exit shows the cursor
// again and, when stdin is a terminal, takes it out of raw mode. It runs
// from src/main.ts through tsx as a subprocess, as tests/cli.test.ts does.

const ROOT = path.resolve(import.meta.dirname, "..");
const MAIN = path.join(ROOT, "src", "main.ts");
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

/** DECTCEM "show cursor". */
const SHOW_CURSOR = "\u001B[?25h";

interface Result {
  readonly exitCode: number;
  readonly stdout: string;
}

const run = async (command: string, args: readonly string[]): Promise<Result> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? -1, stdout });
    });
  });

const quote = (arg: string): string => `'${arg.replaceAll("'", `'\\''`)}'`;

/** util-linux `script`, which runs a command on a fresh pseudo-terminal. */
const hasUtilLinuxScript = ((): boolean => {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    return execFileSync("script", ["--version"], {
      encoding: "utf8",
    }).includes("util-linux");
  } catch {
    return false;
  }
})();

describe("sandcastle CLI terminal cleanup", () => {
  it("shows the cursor again on exit when output is piped", async () => {
    const result = await run(process.execPath, [
      "--import",
      TSX,
      MAIN,
      "--help",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.endsWith(SHOW_CURSOR)).toBe(true);
  });

  it.skipIf(!hasUtilLinuxScript)(
    "on a terminal, exits cleanly, shows the cursor and leaves the terminal in canonical mode",
    async () => {
      const cli = [process.execPath, "--import", TSX, MAIN, "--help"]
        .map((arg) => quote(arg))
        .join(" ");
      // After the CLI exits, report its exit code and the terminal's modes
      // from the same pseudo-terminal.
      const result = await run("script", [
        "-qec",
        `${cli}; echo "EXIT=$?"; stty -a`,
        "/dev/null",
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`${SHOW_CURSOR}EXIT=0`);
      expect(result.stdout).toMatch(/(?:^|\s)icanon(?:\s|$)/mu);
      expect(result.stdout).toMatch(/(?:^|\s)echo(?:\s|$)/mu);
    },
    30_000,
  );
});
