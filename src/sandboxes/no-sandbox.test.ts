import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { noSandbox } from "./no-sandbox.js";

describe("noSandbox", () => {
  it("returns a provider with tag 'none'", () => {
    const provider = noSandbox();
    expect(provider.tag).toBe("none");
    expect(provider.name).toBe("no-sandbox");
    expect(provider.env).toEqual({});
  });

  it("merges env from options", () => {
    const provider = noSandbox({ env: { FOO: "bar" } });
    expect(provider.env).toEqual({ FOO: "bar" });
  });

  describe("handle", () => {
    it("exec runs a command on the host and returns output", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      const result = await handle.exec('echo "hello world"');
      expect(result.stdout).toContain("hello world");
      expect(result.exitCode).toBe(0);
    });

    it("exec returns non-zero exit code on failure", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      const result = await handle.exec("exit 42");
      expect(result.exitCode).toBe(42);
    });

    it("exec supports onLine streaming callback", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      const lines: string[] = [];
      const result = await handle.exec('echo "line1"; echo "line2"', {
        onLine: (line) => lines.push(line),
      });

      expect(lines).toEqual(["line1", "line2"]);
      expect(result.stdout).toContain("line1");
      expect(result.exitCode).toBe(0);
    });

    it("exec respects cwd option", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: "/tmp",
        env: {},
      });

      const result = await handle.exec("pwd", { cwd: "/tmp" });
      expect(result.stdout.trim()).toBe(realpathSync("/tmp"));
    });

    it("exec ignores sudo option (no-op)", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      // sudo is a no-op — the command should still run successfully
      const result = await handle.exec('echo "test"', { sudo: true });
      expect(result.stdout).toContain("test");
      expect(result.exitCode).toBe(0);
    });

    it("exec passes env vars to spawned processes", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: { MY_TEST_VAR: "sandcastle_test_value" },
      });

      const result = await handle.exec("echo $MY_TEST_VAR");
      expect(result.stdout.trim()).toBe("sandcastle_test_value");
    });

    it("interactiveExec spawns process and returns exit code", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      const result = await handle.interactiveExec(["sh", "-c", "exit 0"], {
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
      });

      expect(result.exitCode).toBe(0);
    });

    it("bounds streamed stdout to the configured tail without dropping live lines", async () => {
      const provider = noSandbox({ maxOutputTailChars: 100 });
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      const lines: string[] = [];
      const result = await handle.exec(
        'for i in $(seq 1 5000); do echo "line-$i"; done',
        { onLine: (line) => lines.push(line) },
      );

      // The process survives and exits cleanly — no RangeError crash.
      expect(result.exitCode).toBe(0);
      // Every line is delivered live to onLine, regardless of the tail bound.
      expect(lines.length).toBe(5000);
      expect(lines[0]).toBe("line-1");
      expect(lines[lines.length - 1]).toBe("line-5000");
      // The returned stdout is bounded to the configured tail.
      expect(result.stdout.length).toBeLessThanOrEqual(100);
      // ...and it is the tail, so the most recent line is present.
      expect(result.stdout).toContain("line-5000");
    });

    it("bounds streamed stderr to the configured tail", async () => {
      const provider = noSandbox({ maxOutputTailChars: 100 });
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      // onLine selects the streaming branch; stderr is accumulated there too.
      const result = await handle.exec(
        'for i in $(seq 1 5000); do echo "err-$i" >&2; done',
        { onLine: () => {} },
      );

      expect(result.exitCode).toBe(0);
      // The returned stderr is bounded to the configured tail...
      expect(result.stderr.length).toBeLessThanOrEqual(100);
      // ...and it is the tail, so the most recent output is present.
      expect(result.stderr).toContain("err-5000");
    });

    it("close is a no-op and does not throw", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      await expect(handle.close()).resolves.toBeUndefined();
    });
  });
});
