import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { smol } from "./smol.js";

const mock = vi.hoisted(() => ({
  create: vi.fn(),
  exec: vi.fn(),
  execStream: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
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
