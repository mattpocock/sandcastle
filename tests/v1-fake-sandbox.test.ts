import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DetachableSandbox } from "@ai-hero/sandcastle/v1";
import { createSandbox, ExecFailedError } from "@ai-hero/sandcastle/v1";
import type { FakeSandboxProvider } from "@ai-hero/sandcastle/v1/testing";
import { fakeSandbox } from "@ai-hero/sandcastle/v1/testing";
import { providerContract } from "./helpers/providerContract.js";

// createSandbox() on the testing fake: real directories, real `sh` processes.
// The fake needs `sh` and POSIX process groups, so these tests skip on
// Windows, where the fake is documented as unsupported (ADR 0025).

const exists = async (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

/** True while a process with this pid is alive. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Starts a background process in the sandbox and returns its pid. */
const startSleeper = async (sandbox: DetachableSandbox): Promise<number> => {
  const { stdout } = await sandbox.exec("sleep 30 > /dev/null 2>&1 & echo $!");
  return Number(stdout.trim());
};

/**
 * Parses `env` output into variable names, minus the ones `sh` sets itself
 * and NODE_V8_COVERAGE, which Node adds to every child's env while coverage
 * is being collected.
 */
const envNames = (stdout: string): Set<string> => {
  const shellSet = new Set(["PWD", "SHLVL", "_", "OLDPWD", "NODE_V8_COVERAGE"]);
  return new Set(
    stdout
      .trim()
      .split("\n")
      .map((line) => line.slice(0, line.indexOf("=")))
      .filter((name) => !shellSet.has(name)),
  );
};

const WAIT = { timeout: 10_000, interval: 50 };

describe.skipIf(process.platform === "win32")("fakeSandbox()", () => {
  let rootDir = "";
  let provider: FakeSandboxProvider = fakeSandbox();

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-fake-test-"));
    provider = fakeSandbox({ rootDir });
  });

  afterEach(async () => {
    await provider.closeAll();
    await rm(rootDir, { recursive: true, force: true });
  });

  providerContract(async (env) => createSandbox({ provider, env }));

  it("resolves a detachable handle backed by a directory under rootDir", async () => {
    const sandbox = await createSandbox({ provider });

    const dir = provider.pathOf(sandbox.sandboxId);
    expect(path.dirname(dir)).toBe(rootDir);
    expect(sandbox.workingDirectory).toBe(path.join(dir, "work"));
    expect(sandbox.native.directory).toBe(dir);
    const canDetach: true = sandbox.canDetach;
    expect(canDetach).toBe(true);
    const { stdout } = await sandbox.exec("pwd");
    expect(stdout.trim()).toBe(sandbox.workingDirectory);
  });

  it("sets the kill time from timeLimitMinutes", async () => {
    const before = Date.now();
    const sandbox = await createSandbox({ provider, timeLimitMinutes: 30 });
    const after = Date.now();

    expect(sandbox.killTime.getTime()).toBeGreaterThanOrEqual(
      before + 30 * 60_000,
    );
    expect(sandbox.killTime.getTime()).toBeLessThanOrEqual(after + 30 * 60_000);
  });

  it("rejects exec with ExecFailedError on a non-zero exit", async () => {
    const sandbox = await createSandbox({ provider });

    const error: unknown = await sandbox
      .exec("echo out; echo oops >&2; exit 3")
      .catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(ExecFailedError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      command: "echo out; echo oops >&2; exit 3",
      exitCode: 3,
      stdout: "out\n",
      stderr: "oops\n",
    });
  });

  it("resolves a non-zero exit when allowFailure is set", async () => {
    const sandbox = await createSandbox({ provider });

    const result = await sandbox.exec({
      command: "exit 2",
      allowFailure: true,
    });

    expect(result.exitCode).toBe(2);
  });

  it("runs in a working directory relative to the sandbox's", async () => {
    const sandbox = await createSandbox({ provider });
    await sandbox.exec("mkdir -p sub/dir");

    const { stdout } = await sandbox.exec({
      command: "pwd",
      workingDirectory: "sub/dir",
    });

    expect(stdout.trim()).toBe(path.join(sandbox.workingDirectory, "sub/dir"));
  });

  it("gives per-command env to that command only, and the sandbox env to every command", async () => {
    const sandbox = await createSandbox({
      provider,
      env: { SANDBOX_WIDE: "everywhere" },
    });

    const first = await sandbox.exec({
      command: "printenv ONE_COMMAND; printenv SANDBOX_WIDE",
      env: { ONE_COMMAND: "secret" },
    });
    const second = await sandbox.exec({
      command: "printenv ONE_COMMAND; printenv SANDBOX_WIDE",
      allowFailure: true,
    });

    expect(first.stdout).toBe("secret\neverywhere\n");
    expect(second.stdout).toBe("everywhere\n");
  });

  it("starts with only PATH, a private HOME and TMPDIR, and the env given: nothing from the host, a repo or a .env file", async () => {
    vi.stubEnv("SANDCASTLE_FAKE_HOST_ONLY", "leak");
    try {
      const sandbox = await createSandbox({ provider, env: { GIVEN: "1" } });

      const { stdout } = await sandbox.exec("env");

      expect(envNames(stdout)).toStrictEqual(
        new Set(["GIVEN", "HOME", "PATH", "TMPDIR"]),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("gives every command a HOME and TMPDIR inside the sandbox, even when the env sets them", async () => {
    const sandbox = await createSandbox({
      provider,
      env: { HOME: "/root-of-all-evil", TMPDIR: "/tmp" },
    });
    const dir = provider.pathOf(sandbox.sandboxId);

    const { stdout } = await sandbox.exec('echo "$HOME"; echo "$TMPDIR"');

    expect(stdout).toBe(
      `${path.join(dir, "home")}\n${path.join(dir, "tmp")}\n`,
    );
  });

  it("round-trips a text file, creating parent directories", async () => {
    const sandbox = await createSandbox({ provider });

    await sandbox.writeTextFile({ path: "a/b/c.txt", content: "hello\n" });

    await expect(sandbox.readTextFile({ path: "a/b/c.txt" })).resolves.toBe(
      "hello\n",
    );
    const { stdout } = await sandbox.exec("cat a/b/c.txt");
    expect(stdout).toBe("hello\n");
  });

  it("accepts absolute paths inside the sandbox", async () => {
    const sandbox = await createSandbox({ provider });
    const file = path.join(provider.pathOf(sandbox.sandboxId), "home", "x");

    await sandbox.writeTextFile({ path: file, content: "in home" });

    await expect(sandbox.readTextFile({ path: file })).resolves.toBe("in home");
  });

  it("reads a missing file as null", async () => {
    const sandbox = await createSandbox({ provider });

    await expect(
      sandbox.readTextFile({ path: "nope.txt" }),
    ).resolves.toBeNull();
  });

  it("refuses file paths outside the sandbox", async () => {
    const sandbox = await createSandbox({ provider });
    const outside = path.join(rootDir, "outside.txt");

    await expect(
      sandbox.writeTextFile({ path: outside, content: "x" }),
    ).rejects.toThrow(/outside the sandbox/u);
    await expect(
      sandbox.readTextFile({ path: "../../outside.txt" }),
    ).rejects.toThrow(/outside the sandbox/u);
    await expect(exists(outside)).resolves.toBe(false);
  });

  it("close() kills the sandbox's processes and removes its directory", async () => {
    const sandbox = await createSandbox({ provider });
    const dir = provider.pathOf(sandbox.sandboxId);
    const pid = await startSleeper(sandbox);
    const running = sandbox.exec({ command: "sleep 30", allowFailure: true });
    expect(alive(pid)).toBe(true);

    await sandbox.close();

    await vi.waitFor(() => {
      expect(alive(pid)).toBe(false);
    }, WAIT);
    const { exitCode } = await running;
    expect(exitCode).not.toBe(0);
    await expect(exists(dir)).resolves.toBe(false);
  });

  it("close() is safe to call twice", async () => {
    const sandbox = await createSandbox({ provider });

    await sandbox.close();

    await expect(sandbox.close()).resolves.toBeUndefined();
  });

  it("closes the sandbox when an `await using` block ends", async () => {
    let dir = "";
    {
      await using sandbox = await createSandbox({ provider });
      dir = provider.pathOf(sandbox.sandboxId);
      await expect(exists(dir)).resolves.toBe(true);
    }
    await expect(exists(dir)).resolves.toBe(false);
  });

  it("kills everything and removes the sandbox at its kill time", async () => {
    const sandbox = await createSandbox({ provider, timeLimitMinutes: 1 / 60 });
    const dir = provider.pathOf(sandbox.sandboxId);
    const pid = await startSleeper(sandbox);

    await vi.waitFor(async () => {
      expect(alive(pid)).toBe(false);
      await expect(exists(dir)).resolves.toBe(false);
    }, WAIT);

    expect(sandbox.killTime.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("closeAll() and `await using` on the provider close every sandbox it made", async () => {
    let dirs: string[] = [];
    {
      await using scoped = fakeSandbox({ rootDir });
      const sandboxes = await Promise.all([
        createSandbox({ provider: scoped }),
        createSandbox({ provider: scoped }),
      ]);
      dirs = sandboxes.map((sandbox) => scoped.pathOf(sandbox.sandboxId));
    }
    const left = await Promise.all(dirs.map(async (dir) => exists(dir)));
    expect(left).toStrictEqual([false, false]);
  });

  it("never deletes a caller-supplied rootDir", async () => {
    const sandbox = await createSandbox({ provider });
    await sandbox.close();
    await provider.closeAll();

    await expect(exists(rootDir)).resolves.toBe(true);
  });
});
