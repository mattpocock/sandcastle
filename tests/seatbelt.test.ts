import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
import { seatbelt } from "@ai-hero/sandcastle/sandboxes/seatbelt";
import {
  NATIVE_PROVIDERS,
  assertUsable,
  skipsHere,
} from "./helpers/nativeProviders.js";

// seatbelt() through the public API, on the real Seatbelt. Gated like the
// containment suite: skipped off macOS, but a broken sandbox-exec fails when
// CI is set. The macOS CI job is the only place this runs.

const SEATBELT = NATIVE_PROVIDERS.find((p) => p.name === "seatbelt()");
if (SEATBELT === undefined) {
  throw new Error("NATIVE_PROVIDERS has no seatbelt() entry");
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

/** `sh` itself sets PWD, SHLVL and `_`, and macOS's libc sets `__CF_*`. */
const SHELL_SET = /^(?:PWD|OLDPWD|SHLVL|_|__CF_.*)$/u;

/** Whether an env var name inside the sandbox came from outside it. */
const isPassedIn = (name: string): boolean => !SHELL_SET.test(name);

describe("seatbelt() mounts", () => {
  it("throws at construction when a mount's sandboxPath differs from its hostPath", () => {
    const hostPath = mkdtempSync(path.join(tmpdir(), "e2e-seatbelt-mount-"));
    try {
      expect(() =>
        seatbelt({ mounts: [{ hostPath, sandboxPath: "/data" }] }),
      ).toThrow(/seatbelt\(\) mounts .*sandboxPath must equal hostPath/u);
    } finally {
      rmSync(hostPath, { recursive: true, force: true });
    }
  });
});

describe.skipIf(skipsHere(SEATBELT))("seatbelt() with createSandbox()", () => {
  let repo = "";
  let scratch = "";

  beforeAll(() => {
    assertUsable(SEATBELT);
  });

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "e2e-seatbelt-"));
    scratch = mkdtempSync(path.join(tmpdir(), "e2e-seatbelt-scratch-"));
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
    rmSync(scratch, { recursive: true, force: true });
  });

  const open = async (): Promise<Awaited<ReturnType<typeof createSandbox>>> =>
    createSandbox({ branch: "work", sandbox: seatbelt(), cwd: repo });

  it("runs a command inside the sandbox, in the worktree", async () => {
    await using sandbox = await open();

    const result = await sandbox.exec("cat README.md");

    expect(result).toMatchObject({ exitCode: 0, stdout: "# repo\n" });
  });

  it("rejects exec with sudo, naming seatbelt() and pointing to docker()", async () => {
    await using sandbox = await open();

    await expect(sandbox.exec("true", { sudo: true })).rejects.toThrow(
      /seatbelt\(\).*docker\(\)/su,
    );
  });

  it("streams stdout to onLine while the command is still running", async () => {
    await using sandbox = await open();
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
    await using sandbox = await open();
    const payload = "x".repeat(1024 * 1024);

    const result = await sandbox.exec("wc -c", { stdin: payload });

    expect(result.stdout.trim()).toBe(String(payload.length));
  });

  it("passes only the declared env, PATH, HOME and TMPDIR", async () => {
    await using sandbox = await open();

    const result = await sandbox.exec("env | cut -d= -f1 | sort");

    const names = result.stdout
      .trim()
      .split("\n")
      .filter((name) => isPassedIn(name));
    expect(new Set(names)).toStrictEqual(new Set(["HOME", "PATH", "TMPDIR"]));
  });

  it("puts a file copied in under /home/agent at $HOME, and copies one written there out", async () => {
    // Core copies files (session files, for one) through the provider
    // handle, which createSandbox()'s Sandbox doesn't expose.
    const handle = await seatbelt().create({
      worktreePath: repo,
      hostRepoPath: repo,
      mounts: [{ hostPath: repo, sandboxPath: repo }],
      env: {},
    });
    try {
      const hostIn = path.join(scratch, "in.txt");
      writeFileSync(hostIn, "copied in\n");

      await handle.copyFileIn(hostIn, "/home/agent/.config/in.txt");
      const read = await handle.exec(
        'cat "$HOME/.config/in.txt" && echo written > "$HOME/out.txt"',
      );
      const hostOut = path.join(scratch, "out", "out.txt");
      await handle.copyFileOut("/home/agent/out.txt", hostOut);

      expect(read).toMatchObject({ exitCode: 0, stdout: "copied in\n" });
      expect(readFileSync(hostOut, "utf8")).toBe("written\n");
    } finally {
      await handle.close();
    }
  });

  it("removes the private home and temp dir on close()", async () => {
    // The private dirs live under the host's temp dir: give this sandbox its own.
    const hostTmp = mkdtempSync(path.join(tmpdir(), "e2e-seatbelt-host-tmp-"));
    const originalTmpdir = process.env["TMPDIR"];
    process.env["TMPDIR"] = hostTmp;
    const planted = (): string[] =>
      readdirSync(hostTmp, { recursive: true, encoding: "utf8" })
        .map((entry) => path.basename(entry))
        .filter((name) => name.startsWith("planted-"));
    try {
      const sandbox = await open();
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
    const sandbox = await open();
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

  it("kills a background process when the exec that started it exits", async () => {
    await using sandbox = await open();

    await sandbox.exec("(sleep 2; echo late > late.txt) >/dev/null 2>&1 &");
    await sleep(3000);

    expect(existsSync(path.join(sandbox.worktreePath, "late.txt"))).toBe(false);
  }, 15_000);

  it("lets a read-write mount be written and keeps a read-only mount read-only", async () => {
    const cache = path.join(scratch, "cache");
    const shared = path.join(scratch, "shared");
    mkdirSync(cache);
    mkdirSync(shared);
    writeFileSync(path.join(shared, "notes.txt"), "shared notes\n");

    await using sandbox = await createSandbox({
      branch: "work",
      sandbox: seatbelt({
        mounts: [
          { hostPath: cache, sandboxPath: cache },
          { hostPath: shared, sandboxPath: shared, readonly: true },
        ],
      }),
      cwd: repo,
    });
    const write = await sandbox.exec(`echo cached > '${cache}/entry'`);
    const read = await sandbox.exec(`cat '${shared}/notes.txt'`);
    const writeReadonly = await sandbox.exec(`echo no > '${shared}/notes.txt'`);

    expect(write.exitCode).toBe(0);
    expect(read).toMatchObject({ exitCode: 0, stdout: "shared notes\n" });
    expect(writeReadonly.exitCode).not.toBe(0);
    expect(readFileSync(path.join(shared, "notes.txt"), "utf8")).toBe(
      "shared notes\n",
    );
  });

  it("refuses interactive() with a clear Error", async () => {
    const attempt = interactive({
      agent: claudeCode("claude-opus-4-8"),
      sandbox: seatbelt(),
      cwd: repo,
      prompt: "hi",
    });

    await expect(attempt).rejects.toThrow(
      "interactive() is not supported on native providers",
    );
    await expect(attempt).rejects.toBeInstanceOf(
      NativeInteractiveNotSupportedError,
    );
  });

  it("refuses wt.interactive() from createWorktree()", async () => {
    await using wt = await createWorktree({
      branchStrategy: { type: "branch", branch: "work" },
      cwd: repo,
    });

    await expect(
      wt.interactive({
        agent: claudeCode("claude-opus-4-8"),
        sandbox: seatbelt(),
        prompt: "hi",
      }),
    ).rejects.toThrow("interactive() is not supported on native providers");
  });
});
