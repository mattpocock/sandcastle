import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  claudeCode,
  createSandbox,
  createWorktree,
  interactive,
  NativeInteractiveNotSupportedError,
} from "@ai-hero/sandcastle";
import { bwrap } from "@ai-hero/sandcastle/sandboxes/bwrap";
import {
  NATIVE_PROVIDERS,
  assertUsable,
  skipsHere,
} from "./helpers/nativeProviders.js";

// bwrap() through the public API, on the real Bubblewrap. Gated like the
// containment suite: skipped off Linux and where bwrap is missing, but a
// missing bwrap fails when CI is set.

const BWRAP = NATIVE_PROVIDERS.find((p) => p.name === "bwrap()");
if (BWRAP === undefined) {
  throw new Error("NATIVE_PROVIDERS has no bwrap() entry");
}

/**
 * An `onLine` callback that records every line, and a promise that resolves
 * with the lines seen so far when `marker` arrives.
 */
const watchFor = (
  marker: string,
): {
  lines: string[];
  onLine: (line: string) => void;
  seen: Promise<string[]>;
} => {
  const lines: string[] = [];
  let resolveSeen = (_lines: string[]): void => undefined;
  const seen = new Promise<string[]>((resolve) => {
    resolveSeen = resolve;
  });
  const onLine = (line: string): void => {
    lines.push(line);
    if (line === marker) {
      resolveSeen([...lines]);
    }
  };
  return { lines, onLine, seen };
};

describe.skipIf(skipsHere(BWRAP))("bwrap() with createSandbox()", () => {
  beforeAll(() => {
    assertUsable(BWRAP);
  });

  let repo = "";

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "e2e-bwrap-"));
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    };
    git("init", "-b", "main");
    writeFileSync(path.join(repo, "README.md"), "# repo\n");
    git("add", ".");
    git("commit", "-m", "init");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("runs a command inside the sandbox, in the worktree", async () => {
    await using sandbox = await createSandbox({
      branch: "work",
      sandbox: bwrap(),
      cwd: repo,
    });

    const result = await sandbox.exec("cat README.md");

    expect(result).toMatchObject({ exitCode: 0, stdout: "# repo\n" });
  });

  it("rejects exec with sudo, naming bwrap() and pointing to docker()", async () => {
    await using sandbox = await createSandbox({
      branch: "work",
      sandbox: bwrap(),
      cwd: repo,
    });

    await expect(sandbox.exec("true", { sudo: true })).rejects.toThrow(
      /bwrap\(\).*docker\(\)/su,
    );
  });

  it("streams stdout to onLine while the command is still running", async () => {
    await using sandbox = await createSandbox({
      branch: "work",
      sandbox: bwrap(),
      cwd: repo,
    });
    const watch = watchFor("first");
    // The command prints a line, then waits until the test has seen it.
    const running = sandbox.exec(
      "echo first; while [ ! -f released ]; do sleep 0.05; done; echo second",
      { onLine: watch.onLine },
    );
    const linesBeforeRelease = await watch.seen;
    writeFileSync(path.join(sandbox.worktreePath, "released"), "");
    const result = await running;

    expect(linesBeforeRelease).toStrictEqual(["first"]);
    expect(watch.lines).toStrictEqual(["first", "second"]);
    expect(result.exitCode).toBe(0);
  });

  it("pipes a large stdin to the command", async () => {
    await using sandbox = await createSandbox({
      branch: "work",
      sandbox: bwrap(),
      cwd: repo,
    });
    const payload = "x".repeat(1024 * 1024);

    const result = await sandbox.exec("wc -c", { stdin: payload });

    expect(result.stdout.trim()).toBe(String(payload.length));
  });

  it("removes the private home and temp dir on close()", async () => {
    // The private dirs live under the host's temp dir: give this sandbox its own.
    const hostTmp = mkdtempSync(path.join(tmpdir(), "e2e-bwrap-host-tmp-"));
    const originalTmpdir = process.env["TMPDIR"];
    process.env["TMPDIR"] = hostTmp;
    const planted = (): string[] =>
      readdirSync(hostTmp, { recursive: true, encoding: "utf8" })
        .map((entry) => path.basename(entry))
        .filter((name) => name.startsWith("planted-"));
    try {
      const sandbox = await createSandbox({
        branch: "work",
        sandbox: bwrap(),
        cwd: repo,
      });
      const write = await sandbox.exec(
        'mkdir -p "$HOME/.claude" && echo hook > "$HOME/.claude/planted-home" && echo tmp > "$TMPDIR/planted-tmp"',
      );
      expect(write.exitCode).toBe(0);
      expect(new Set(planted())).toStrictEqual(
        new Set(["planted-home", "planted-tmp"]),
      );

      await sandbox.close();

      expect(planted()).toStrictEqual([]);
    } finally {
      process.env["TMPDIR"] = originalTmpdir;
      rmSync(hostTmp, { recursive: true, force: true });
    }
  });

  it("kills the processes it started on close()", async () => {
    const sandbox = await createSandbox({
      branch: "work",
      sandbox: bwrap(),
      cwd: repo,
    });
    const watch = watchFor("started");
    const running = sandbox.exec(
      // keep.txt leaves the worktree dirty, so close() preserves it.
      "echo keep > keep.txt; (sleep 2; echo late > late.txt) & echo started; sleep 60",
      { onLine: watch.onLine },
    );
    await watch.seen;

    const { preservedWorktreePath } = await sandbox.close();
    await running;
    await sleep(3000);

    expect(preservedWorktreePath).toBeTypeOf("string");
    expect(
      existsSync(path.join(String(preservedWorktreePath), "late.txt")),
    ).toBe(false);
  }, 15_000);

  it("refuses interactive() with a clear Error", async () => {
    const attempt = interactive({
      agent: claudeCode("claude-opus-4-8"),
      sandbox: bwrap(),
      cwd: repo,
      prompt: "hi",
    });

    await expect(attempt).rejects.toThrow(
      "interactive() is not supported on native providers",
    );
    await expect(attempt).rejects.toBeInstanceOf(
      NativeInteractiveNotSupportedError,
    );
    await expect(attempt).rejects.toBeInstanceOf(Error);
  });

  it("refuses sandbox.interactive() from createSandbox()", async () => {
    await using sandbox = await createSandbox({
      branch: "work",
      sandbox: bwrap(),
      cwd: repo,
    });

    await expect(
      sandbox.interactive({
        agent: claudeCode("claude-opus-4-8"),
        prompt: "hi",
      }),
    ).rejects.toThrow("interactive() is not supported on native providers");
  });

  it("refuses wt.interactive() from createWorktree()", async () => {
    await using wt = await createWorktree({
      branchStrategy: { type: "branch", branch: "work" },
      cwd: repo,
    });

    await expect(
      wt.interactive({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: bwrap(),
        prompt: "hi",
      }),
    ).rejects.toThrow("interactive() is not supported on native providers");
  });
});
