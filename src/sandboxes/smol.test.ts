import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  symlink,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { smol } from "./smol.js";

const mock = vi.hoisted(() => ({
  create: vi.fn(),
  exec: vi.fn(),
  execStream: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  readFileStream: undefined as
    | undefined
    | ((path: string) => AsyncGenerator<Uint8Array>),
  delete: vi.fn(),
}));

vi.mock("smolmachines", () => ({ Machine: { create: mock.create } }));

const stream = (
  ...events: Array<{ kind: string; data?: string; exitCode?: number }>
) =>
  (async function* () {
    for (const event of events) yield event;
  })();

describe("smol()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.create.mockResolvedValue(mock);
    mock.exec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    mock.delete.mockResolvedValue(undefined);
    mock.writeFile.mockResolvedValue(undefined);
    mock.readFile.mockResolvedValue(Buffer.from("from guest"));
    mock.readFileStream = undefined;
    mock.execStream.mockImplementation(() =>
      stream({ kind: "exit", exitCode: 0 }),
    );
  });

  it("creates an isolated local VM with merged environment and deletes it", async () => {
    const provider = smol({ env: { SANDCASTLE_EXTRA: "yes" } });
    expect(provider).toMatchObject({ tag: "isolated", name: "smol" });
    const handle = await provider.create({ env: { AGENT_TOKEN: "secret" } });
    expect(mock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        image: "node:22",
        env: { AGENT_TOKEN: "secret" },
        resources: { cpus: 2, memoryMb: 2048, network: true },
      }),
      { target: "local" },
    );
    expect(handle.worktreePath).toBe("/var/tmp/sandcastle-workspace");
    await handle.close();
    await handle.close();
    expect(mock.delete).toHaveBeenCalledTimes(1);
  });

  it("accepts cloud credentials, a resource policy, and a finite lifetime", async () => {
    await smol({
      target: "cloud",
      apiKey: "test",
      baseUrl: "https://api.example.com",
      resources: { network: false },
      ttlSeconds: 3600,
    }).create({ env: {} });
    expect(mock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        resources: { cpus: 2, memoryMb: 2048, network: false },
        ttlSeconds: 3600,
      }),
      { target: "cloud", apiKey: "test", baseUrl: "https://api.example.com" },
    );
  });

  it("streams stdout across chunk boundaries and retains only a bounded tail", async () => {
    mock.execStream.mockImplementation(() =>
      stream(
        { kind: "stdout", data: "first\nse" },
        { kind: "stderr", data: "issue" },
        { kind: "stdout", data: "cond\nthird" },
        { kind: "exit", exitCode: 5 },
      ),
    );
    const handle = await smol({ maxOutputTailChars: 12 }).create({
      env: { FOO: "bar" },
    });
    const lines: string[] = [];
    const result = await handle.exec("echo hello", {
      onLine: (line) => lines.push(line),
      cwd: "/tmp",
      sudo: true,
    });
    expect(lines).toEqual(["first", "second", "third"]);
    expect(result).toEqual({
      exitCode: 5,
      stdout: "second\nthird",
      stderr: "issue",
    });
    expect(mock.execStream).toHaveBeenCalledWith(["sh", "-c", "echo hello"], {
      workdir: "/tmp",
      env: { FOO: "bar" },
      user: "root",
    });
  });

  it("writes long stdin to a guest file and removes it after the command", async () => {
    const handle = await smol().create({ env: {} });
    await handle.exec("cat > result.txt", { stdin: "long prompt" });
    const [path, content] = mock.writeFile.mock.calls[0] as unknown as [
      string,
      string,
    ];
    expect(path).toMatch(/^\/tmp\/sandcastle-stdin-/);
    expect(content).toBe("long prompt");
    expect(mock.execStream).toHaveBeenCalledWith(
      ["sh", "-c", expect.stringContaining("sh -c 'cat > result.txt' < '")],
      expect.any(Object),
    );
    expect(mock.exec).toHaveBeenLastCalledWith(["rm", "-f", path]);
  });

  it("removes partially uploaded stdin when a guest transfer fails", async () => {
    const handle = await smol().create({ env: {} });
    mock.writeFile.mockRejectedValueOnce(new Error("guest upload interrupted"));

    await expect(
      handle.exec("cat", { stdin: "private payload" }),
    ).rejects.toThrow("guest upload interrupted");
    const [path] = mock.writeFile.mock.calls[0] as [string];
    expect(mock.exec).toHaveBeenLastCalledWith(["rm", "-f", path]);
    expect(mock.execStream).not.toHaveBeenCalled();
  });

  it("returns complete output when no streaming callback is requested", async () => {
    mock.execStream.mockImplementation(() =>
      stream(
        { kind: "stdout", data: "hello" },
        { kind: "stdout", data: " world" },
        { kind: "stderr", data: "warning" },
        { kind: "exit", exitCode: 0 },
      ),
    );
    const handle = await smol({ maxOutputTailChars: 3 }).create({ env: {} });
    expect(await handle.exec("echo hi")).toEqual({
      stdout: "hello world",
      stderr: "warning",
      exitCode: 0,
    });
  });

  it("refuses a truncated command stream and deletes a VM when setup fails", async () => {
    mock.execStream.mockImplementation(() =>
      stream({ kind: "stdout", data: "partial" }),
    );
    const handle = await smol().create({ env: {} });
    await expect(handle.exec("echo partial")).rejects.toThrow(
      "without an exit status",
    );
    mock.exec.mockResolvedValueOnce({ exitCode: 1, stderr: "no disk" });
    await expect(smol().create({ env: {} })).rejects.toThrow("no disk");
    expect(mock.delete).toHaveBeenCalledTimes(1);
  });

  it("uploads files over the Cloud request limit in bounded chunks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smol-sandcastle-large-"));
    try {
      const source = join(directory, "large.sh");
      const file = await open(source, "w");
      await file.truncate(100 * 1024 * 1024 + 1);
      await file.close();
      await chmod(source, 0o755);

      const handle = await smol({ target: "cloud" }).create({ env: {} });
      await handle.copyIn(source, "/workspace/large.sh");
      const uploads = mock.writeFile.mock.calls;
      expect(uploads.length).toBeGreaterThan(1);
      expect(
        uploads.every(([guestPath]) => guestPath.startsWith("/workspace/")),
      ).toBe(true);
      expect(uploads.every(([, data]) => data.length <= 16 * 1024 * 1024)).toBe(
        true,
      );
      expect(uploads.reduce((sum, [, data]) => sum + data.length, 0)).toBe(
        100 * 1024 * 1024 + 1,
      );
      const commands = mock.execStream.mock.calls.map(([argv]) => argv[2]);
      expect(commands.some((command) => command.includes("chmod 755"))).toBe(
        true,
      );
      expect(commands.some((command) => command.includes("mv -f"))).toBe(true);
      expect(mock.exec).toHaveBeenCalledWith([
        "rm",
        "-f",
        expect.stringContaining("sandcastle-upload-"),
        expect.stringContaining(".sandcastle-"),
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stages directory archives on the VM storage disk", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "smol-sandcastle-directory-"),
    );
    try {
      const source = join(directory, "project");
      await mkdir(source);
      await writeFile(join(source, "file.txt"), "hello");
      const handle = await smol().create({ env: {} });
      await handle.copyIn(source, "/workspace/project");
      const guestArchive = mock.writeFile.mock.calls[0]?.[0];
      expect(guestArchive).toMatch(/^\/workspace\/\.sandcastle-copyin-/);
      expect(mock.exec).toHaveBeenCalledWith(["rm", "-f", guestArchive]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("removes guest staging files when a chunk upload fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smol-sandcastle-large-"));
    try {
      const source = join(directory, "large.bin");
      const file = await open(source, "w");
      await file.truncate(33 * 1024 * 1024);
      await file.close();
      mock.writeFile.mockRejectedValueOnce(new Error("upload failed"));
      const handle = await smol().create({ env: {} });
      await expect(
        handle.copyIn(source, "/workspace/large.bin"),
      ).rejects.toThrow("upload failed");
      expect(mock.exec).toHaveBeenCalledWith([
        "rm",
        "-f",
        expect.stringContaining("sandcastle-upload-"),
        expect.stringContaining(".sandcastle-"),
      ]);
      const commands = mock.execStream.mock.calls.map(([argv]) => argv[2]);
      expect(commands.every((command) => !command.includes("mv -f"))).toBe(
        true,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("falls back to buffered reads for Cloud SDKs without streaming", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smol-sandcastle-copyout-"));
    try {
      const handle = await smol({ target: "cloud" }).create({ env: {} });
      const destination = join(directory, "output.txt");
      await handle.copyFileOut("/workspace/output.txt", destination);
      expect(mock.readFile).toHaveBeenCalledWith("/workspace/output.txt");
      expect(await readFile(destination, "utf8")).toBe("from guest");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("streams Cloud files and preserves existing symlinks and hard links", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smol-sandcastle-copyout-"));
    try {
      const original = join(directory, "original.txt");
      const alias = join(directory, "alias.txt");
      const destination = join(directory, "download.txt");
      const newFile = join(directory, "fresh.txt");
      await writeFile(original, "old");
      await link(original, alias);
      await symlink(original, destination);
      mock.readFileStream = async function* () {
        yield Buffer.from("new ");
        yield Buffer.from("guest bytes");
      };
      const handle = await smol({ target: "cloud" }).create({ env: {} });
      await handle.copyFileOut("/workspace/output.txt", destination);
      await handle.copyFileOut("/workspace/output.txt", newFile);
      expect(mock.readFile).not.toHaveBeenCalled();
      expect((await lstat(destination)).isSymbolicLink()).toBe(true);
      expect(await readFile(alias, "utf8")).toBe("new guest bytes");
      expect(await readFile(newFile, "utf8")).toBe("new guest bytes");
      expect(
        (await readdir(directory)).filter((name) =>
          name.startsWith(".smol-download-"),
        ),
      ).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains existing output and clears host staging after a failed Cloud stream", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smol-sandcastle-copyout-"));
    try {
      const destination = join(directory, "output.txt");
      await writeFile(destination, "old bytes");
      mock.readFileStream = async function* () {
        yield Buffer.from("partial");
        throw new Error("guest stream failed");
      };
      const handle = await smol({ target: "cloud" }).create({ env: {} });
      await expect(
        handle.copyFileOut("/workspace/output.txt", destination),
      ).rejects.toThrow("guest stream failed");
      await expect(
        handle.copyFileOut("/workspace/output.txt", join(directory, "new.txt")),
      ).rejects.toThrow("guest stream failed");
      expect(await readFile(destination, "utf8")).toBe("old bytes");
      expect(await readdir(directory)).toEqual(["output.txt"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("copies bytes in and out and preserves file permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smol-sandcastle-test-"));
    try {
      const source = join(directory, "script.sh");
      const destination = join(directory, "download.txt");
      await writeFile(source, "echo test\n", { mode: 0o755 });
      const handle = await smol().create({ env: {} });
      await handle.copyIn(source, "/workspace/inner/script.sh");
      expect(mock.writeFile).toHaveBeenCalledWith(
        "/workspace/inner/script.sh",
        Buffer.from("echo test\n"),
        0o755,
      );
      await handle.copyFileOut("/workspace/inner/log.txt", destination);
      expect(await readFile(destination, "utf8")).toBe("from guest");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
