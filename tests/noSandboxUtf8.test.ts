import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Sandbox } from "@ai-hero/sandcastle";
import { createSandbox } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";

// noSandbox() decodes a command's stdout and stderr as UTF-8 streams, so a
// multi-byte character split across two output chunks comes back whole
// instead of as U+FFFD replacement characters. The command here writes its
// output one byte at a time, pausing between bytes, so every character with
// more than one byte is split across chunks.

const sample = "整理文档 🧠";

/** A node script that writes `sample` and a newline to stdout and stderr, byte by byte. */
const byteByByteScript = `
(async () => {
  for (const byte of Buffer.from(${JSON.stringify(`${sample}\n`)})) {
    process.stdout.write(Buffer.from([byte]));
    process.stderr.write(Buffer.from([byte]));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
})();
`;

describe("noSandbox UTF-8 output split across chunks", () => {
  let repo = "";
  let sandbox: Sandbox | undefined;

  beforeEach(async () => {
    repo = mkdtempSync(path.join(tmpdir(), "e2e-utf8-"));
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    };
    git("init", "-b", "main");
    writeFileSync(path.join(repo, "README.md"), "# repo\n");
    git("add", ".");
    git("commit", "-m", "init");
    sandbox = await createSandbox({
      branch: "utf8",
      cwd: repo,
      sandbox: noSandbox(),
    });
  }, 30_000);

  afterEach(async () => {
    await sandbox?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it("keeps characters whole in a buffered exec", async () => {
    const result = await sandbox?.exec("node", { stdin: byteByByteScript });

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: `${sample}\n`,
      stderr: `${sample}\n`,
    });
  }, 30_000);

  it("keeps characters whole in a streamed exec", async () => {
    const lines: string[] = [];
    const result = await sandbox?.exec("node", {
      stdin: byteByByteScript,
      onLine: (line) => {
        lines.push(line);
      },
    });

    expect({ ...result, lines }).toMatchObject({
      exitCode: 0,
      stdout: sample,
      stderr: `${sample}\n`,
      lines: [sample],
    });
  }, 30_000);
});
