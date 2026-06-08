import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { testIsolated } from "./test-isolated.js";

describe("testIsolated()", () => {
  it("returns a SandboxProvider with tag 'isolated' and name 'test-isolated'", () => {
    const provider = testIsolated();
    expect(provider.tag).toBe("isolated");
    expect(provider.name).toBe("test-isolated");
  });

  it("can create a sandbox and exec a command", async () => {
    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      const result = await handle.exec("echo hello");
      expect(result.stdout.trim()).toBe("hello");
      expect(result.exitCode).toBe(0);
    } finally {
      await handle.close();
    }
  });

  it("exec runs in worktreePath by default", async () => {
    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      const result = await handle.exec("pwd");
      expect(result.stdout.trim()).toBe(handle.worktreePath);
    } finally {
      await handle.close();
    }
  });

  it("exec respects cwd option", async () => {
    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      const result = await handle.exec("pwd", { cwd: "/tmp" });
      expect(result.stdout.trim()).toBe(realpathSync("/tmp"));
    } finally {
      await handle.close();
    }
  });

  it("exec returns non-zero exit code on failure", async () => {
    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      const result = await handle.exec("exit 42");
      expect(result.exitCode).toBe(42);
    } finally {
      await handle.close();
    }
  });

  it("can copyIn a file from host to sandbox", async () => {
    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      // Create a file on the "host"
      const hostDir = mkdtempSync(join(tmpdir(), "test-host-"));
      const hostFile = join(hostDir, "input.txt");
      writeFileSync(hostFile, "hello from host");

      // Copy it into the sandbox
      const sandboxFile = join(handle.worktreePath, "input.txt");
      await handle.copyIn(hostFile, sandboxFile);

      // Verify it exists inside the sandbox
      const result = await handle.exec("cat input.txt");
      expect(result.stdout.trim()).toBe("hello from host");
    } finally {
      await handle.close();
    }
  });

  it("can copyFileOut a file from sandbox to host", async () => {
    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      // Create a file inside the sandbox
      await handle.exec('echo "hello from sandbox" > output.txt');

      // Copy it out to the host
      const hostDir = mkdtempSync(join(tmpdir(), "test-host-"));
      const hostFile = join(hostDir, "output.txt");
      const sandboxFile = join(handle.worktreePath, "output.txt");
      await handle.copyFileOut(sandboxFile, hostFile);

      // Verify it exists on the host
      const content = readFileSync(hostFile, "utf-8");
      expect(content.trim()).toBe("hello from sandbox");
    } finally {
      await handle.close();
    }
  });

  it("can copyIn a directory recursively from host to sandbox", async () => {
    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      // Create a directory tree on the "host"
      const hostDir = mkdtempSync(join(tmpdir(), "test-host-"));
      const srcDir = join(hostDir, "mydir");
      mkdirSync(join(srcDir, "sub"), { recursive: true });
      writeFileSync(join(srcDir, "a.txt"), "file-a");
      writeFileSync(join(srcDir, "sub", "b.txt"), "file-b");

      // Copy directory into sandbox
      const sandboxDir = join(handle.worktreePath, "mydir");
      await handle.copyIn(srcDir, sandboxDir);

      // Verify both files exist
      const resultA = await handle.exec("cat mydir/a.txt");
      expect(resultA.stdout.trim()).toBe("file-a");
      const resultB = await handle.exec("cat mydir/sub/b.txt");
      expect(resultB.stdout.trim()).toBe("file-b");
    } finally {
      await handle.close();
    }
  });

  it("close cleans up the temp directory", async () => {
    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    const worktreePath = handle.worktreePath;

    // Worktree should exist before close
    expect(existsSync(worktreePath)).toBe(true);

    await handle.close();

    // Worktree should be gone after close
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("exec streams lines to onLine callback", async () => {
    const provider = testIsolated();
    const handle = await provider.create({ env: {} });
    try {
      const lines: string[] = [];
      const result = await handle.exec(
        'echo "line1"; echo "line2"; echo "line3"',
        { onLine: (line) => lines.push(line) },
      );

      expect(lines).toEqual(["line1", "line2", "line3"]);
      expect(result.exitCode).toBe(0);
    } finally {
      await handle.close();
    }
  });
});
