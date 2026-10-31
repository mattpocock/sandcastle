import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { testBindMount } from "./test-bind-mount.js";

describe("testBindMount()", () => {
  it("returns a SandboxProvider with tag 'bind-mount' and name 'test-bind-mount'", () => {
    const provider = testBindMount();
    expect(provider.tag).toBe("bind-mount");
    expect(provider.name).toBe("test-bind-mount");
  });

  it("can create a sandbox and exec a command", async () => {
    const provider = testBindMount();
    const handle = await provider.create({
      worktreePath: "/tmp/unused",
      hostRepoPath: "/tmp/unused",
      mounts: [],
      env: {},
    });
    try {
      const result = await handle.exec("echo hello");
      expect(result.stdout.trim()).toBe("hello");
      expect(result.exitCode).toBe(0);
    } finally {
      await handle.close();
    }
  });

  it("exec runs in worktreePath by default", async () => {
    const provider = testBindMount();
    const handle = await provider.create({
      worktreePath: "/tmp/unused",
      hostRepoPath: "/tmp/unused",
      mounts: [],
      env: {},
    });
    try {
      const result = await handle.exec("pwd");
      expect(result.stdout.trim()).toBe(handle.worktreePath);
    } finally {
      await handle.close();
    }
  });

  it("can copyFileIn a file from host to sandbox", async () => {
    const provider = testBindMount();
    const handle = await provider.create({
      worktreePath: "/tmp/unused",
      hostRepoPath: "/tmp/unused",
      mounts: [],
      env: {},
    });
    try {
      // Create a file on the "host"
      const hostDir = mkdtempSync(join(tmpdir(), "test-host-"));
      const hostFile = join(hostDir, "input.txt");
      writeFileSync(hostFile, "hello from host");

      // Copy it into the sandbox
      const sandboxFile = join(handle.worktreePath, "input.txt");
      await handle.copyFileIn(hostFile, sandboxFile);

      // Verify it exists inside the sandbox
      const result = await handle.exec("cat input.txt");
      expect(result.stdout.trim()).toBe("hello from host");
    } finally {
      await handle.close();
    }
  });

  it("can copyFileOut a file from sandbox to host", async () => {
    const provider = testBindMount();
    const handle = await provider.create({
      worktreePath: "/tmp/unused",
      hostRepoPath: "/tmp/unused",
      mounts: [],
      env: {},
    });
    try {
      // Create a file inside the sandbox
      await handle.exec('echo "hello from sandbox" > output.txt');

      // Copy it out to the host
      const hostDir = mkdtempSync(join(tmpdir(), "test-host-"));
      const hostFile = join(hostDir, "output.txt");
      const sandboxFile = join(handle.worktreePath, "output.txt");
      await handle.copyFileOut(sandboxFile, hostFile);

      // Verify it exists on the host
      const content = readFileSync(hostFile, "utf8");
      expect(content.trim()).toBe("hello from sandbox");
    } finally {
      await handle.close();
    }
  });

  it("copyFileIn creates parent directories", async () => {
    const provider = testBindMount();
    const handle = await provider.create({
      worktreePath: "/tmp/unused",
      hostRepoPath: "/tmp/unused",
      mounts: [],
      env: {},
    });
    try {
      const hostDir = mkdtempSync(join(tmpdir(), "test-host-"));
      const hostFile = join(hostDir, "data.txt");
      writeFileSync(hostFile, "nested file");

      // Copy to a nested path that doesn't exist yet
      const sandboxFile = join(handle.worktreePath, "sub", "dir", "data.txt");
      await handle.copyFileIn(hostFile, sandboxFile);

      const result = await handle.exec("cat sub/dir/data.txt");
      expect(result.stdout.trim()).toBe("nested file");
    } finally {
      await handle.close();
    }
  });

  it("copyFileOut creates parent directories on host", async () => {
    const provider = testBindMount();
    const handle = await provider.create({
      worktreePath: "/tmp/unused",
      hostRepoPath: "/tmp/unused",
      mounts: [],
      env: {},
    });
    try {
      await handle.exec('echo "data" > file.txt');

      const hostDir = mkdtempSync(join(tmpdir(), "test-host-"));
      const hostFile = join(hostDir, "nested", "dir", "file.txt");
      const sandboxFile = join(handle.worktreePath, "file.txt");
      await handle.copyFileOut(sandboxFile, hostFile);

      expect(readFileSync(hostFile, "utf8").trim()).toBe("data");
    } finally {
      await handle.close();
    }
  });

  it("handles absolute paths outside the mounted worktree", async () => {
    const provider = testBindMount();
    const handle = await provider.create({
      worktreePath: "/tmp/unused",
      hostRepoPath: "/tmp/unused",
      mounts: [],
      env: {},
    });
    try {
      // Create a file outside the worktree on "host" side
      const hostDir = mkdtempSync(join(tmpdir(), "test-outside-"));
      const hostFile = join(hostDir, "outside.txt");
      writeFileSync(hostFile, "outside worktree");

      // Copy to a path outside the worktree in sandbox
      const sandboxDir = mkdtempSync(join(tmpdir(), "test-sandbox-outside-"));
      const sandboxFile = join(sandboxDir, "outside.txt");
      await handle.copyFileIn(hostFile, sandboxFile);

      expect(readFileSync(sandboxFile, "utf8")).toBe("outside worktree");

      // Copy back out to a different host location
      const hostFile2 = join(hostDir, "roundtrip.txt");
      await handle.copyFileOut(sandboxFile, hostFile2);

      expect(readFileSync(hostFile2, "utf8")).toBe("outside worktree");
    } finally {
      await handle.close();
    }
  });

  it("close cleans up the temp directory", async () => {
    const provider = testBindMount();
    const handle = await provider.create({
      worktreePath: "/tmp/unused",
      hostRepoPath: "/tmp/unused",
      mounts: [],
      env: {},
    });
    const { worktreePath } = handle;
    expect(existsSync(worktreePath)).toBe(true);

    await handle.close();
    expect(existsSync(worktreePath)).toBe(false);
  });
});
