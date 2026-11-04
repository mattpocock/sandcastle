import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Sandbox } from "@ai-hero/sandcastle";
import { createSandbox } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";

// A streamed exec (one with `onLine`) returns only a bounded tail of its
// output, so a long agent run can't build a string past V8's limit. Every
// line still reaches `onLine`; only the returned stdout/stderr are bounded.

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("noSandbox streamed exec output tail", () => {
  let repo = "";
  const sandboxes: Sandbox[] = [];

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "e2e-tail-"));
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    };
    git("init", "-b", "main");
    writeFileSync(path.join(repo, "README.md"), "# repo\n");
    git("add", ".");
    git("commit", "-m", "init");
  });

  afterEach(async () => {
    await Promise.all(sandboxes.splice(0).map(async (s) => s.close()));
    rmSync(repo, { recursive: true, force: true });
  });

  const open = async (maxOutputTailChars?: number): Promise<Sandbox> => {
    const sandbox = await createSandbox({
      branch: `tail-${sandboxes.length}`,
      cwd: repo,
      sandbox: noSandbox(
        maxOutputTailChars === undefined ? undefined : { maxOutputTailChars },
      ),
    });
    sandboxes.push(sandbox);
    return sandbox;
  };

  /** Runs a node script in the sandbox, streaming, and returns the result. */
  const streamNode = async (sandbox: Sandbox, script: string) => {
    const lines: string[] = [];
    const result = await sandbox.exec(
      `node -e '${script.replaceAll("'", String.raw`'\''`)}'`,
      {
        onLine: (line) => {
          lines.push(line);
        },
      },
    );
    return { ...result, lines };
  };

  it("returns empty output when the command prints nothing", async () => {
    const sandbox = await open(100);
    const result = await streamNode(sandbox, "");
    expect({ stdout: result.stdout, stderr: result.stderr }).toStrictEqual({
      stdout: "",
      stderr: "",
    });
  });

  it("returns every line, newline-joined, while under budget", async () => {
    const sandbox = await open(100);
    const result = await streamNode(
      sandbox,
      `console.log("alpha"); console.log("beta");`,
    );
    expect(result.stdout).toBe("alpha\nbeta");
  });

  it("drops the oldest lines once the output passes the budget", async () => {
    const sandbox = await open(10);
    const result = await streamNode(
      sandbox,
      `console.log("aaaa"); console.log("bbbb"); console.log("cccc");`,
    );
    expect(result.stdout).toBe("bbbb\ncccc");
  });

  it("stays within budget over many lines, keeping the newest", async () => {
    const sandbox = await open(50);
    const result = await streamNode(
      sandbox,
      `for (let i = 0; i < 10000; i++) console.log("line-" + i);`,
    );
    expect(result.stdout.length).toBeLessThanOrEqual(50);
    expect(result.stdout).toMatch(/line-9999$/u);
  });

  it("still streams every line to onLine", async () => {
    const sandbox = await open(10);
    const result = await streamNode(
      sandbox,
      `for (let i = 0; i < 100; i++) console.log("line-" + i);`,
    );
    expect(result.lines).toHaveLength(100);
  });

  it("keeps only the tail of a single line longer than the budget", async () => {
    const sandbox = await open(10);
    const result = await streamNode(
      sandbox,
      `console.log("0123456789ABCDEF");`,
    );
    expect(result.stdout).toBe("6789ABCDEF");
  });

  it("keeps only the tail of an oversized line that follows others", async () => {
    const sandbox = await open(10);
    const result = await streamNode(
      sandbox,
      `console.log("hello"); console.log("X".repeat(100));`,
    );
    expect(result.stdout).toBe("X".repeat(10));
  });

  it("returns stderr chunks joined with no separator", async () => {
    const sandbox = await open(100);
    const result = await streamNode(
      sandbox,
      `process.stderr.write("ab"); setTimeout(() => process.stderr.write("cd"), 50);`,
    );
    expect(result.stderr).toBe("abcd");
  });

  it("bounds the tail to 64KiB by default", async () => {
    const sandbox = await open();
    const result = await streamNode(
      sandbox,
      `console.log("y".repeat(100000));`,
    );
    expect(result.stdout).toHaveLength(64 * 1024);
  });
});
