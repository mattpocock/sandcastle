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
      expect(result.stdout.trim()).toBe("/tmp");
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

    it("handle declares supportsStdinExec: true", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });
      expect(handle.supportsStdinExec).toBe(true);
    });

    it("exec forwards the stdin option to the spawned process", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      const result = await handle.exec("cat", { stdin: "piped-input-data" });
      expect(result.stdout).toBe("piped-input-data");
      expect(result.exitCode).toBe(0);
    });

    it("exec delivers stdin payloads larger than MAX_ARG_STRLEN (128 KB)", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      // 256 KB — double the per-argv-string kernel cap. Would hit E2BIG via argv.
      const largePayload = "x".repeat(256 * 1024);
      const result = await handle.exec("wc -c", { stdin: largePayload });
      expect(result.stdout.trim()).toBe(String(largePayload.length));
      expect(result.exitCode).toBe(0);
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
