import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { e2b } from "./e2b.js";

const sdk = vi.hoisted(() => {
  class CommandExitError extends Error {
    constructor(
      readonly stdout: string,
      readonly stderr: string,
      readonly exitCode: number,
    ) {
      super(`exit status ${exitCode}`);
    }
  }
  class NotFoundError extends Error {}
  type Outcome = {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    chunks?: string[];
    errChunks?: string[];
  };
  const fresh = () => ({
    createOpts: undefined as any,
    killed: 0,
    runs: [] as { command: string; opts: any }[],
    stdin: [] as string[],
    stdinClosed: 0,
    stdinError: undefined as Error | undefined,
    commandKilled: 0,
    behave: (_command: string): Outcome | Error => ({}),
  });
  const state = fresh();
  const settle = (o: Outcome) => {
    const exitCode = o.exitCode ?? 0;
    if (exitCode !== 0)
      throw new CommandExitError(o.stdout ?? "", o.stderr ?? "", exitCode);
    return { stdout: o.stdout ?? "", stderr: o.stderr ?? "", exitCode };
  };
  const sandbox = {
    kill: async () => void state.killed++,
    files: { write: vi.fn(async () => ({})) },
    commands: {
      run: async (command: string, opts: any = {}) => {
        state.runs.push({ command, opts });
        const outcome = state.behave(command);
        if (outcome instanceof Error) throw outcome;
        if (!opts.background) return settle(outcome);
        return {
          sendStdin: async (data: string) => {
            if (state.stdinError) throw state.stdinError;
            state.stdin.push(data);
          },
          closeStdin: async () => {
            if (state.stdinError) throw state.stdinError;
            state.stdinClosed++;
          },
          kill: async () => void state.commandKilled++,
          wait: async () => {
            for (const chunk of outcome.chunks ?? []) opts.onStdout?.(chunk);
            for (const chunk of outcome.errChunks ?? []) opts.onStderr?.(chunk);
            return settle(outcome);
          },
        };
      },
    },
  };
  const Sandbox = {
    create: async (opts: any) => {
      state.createOpts = opts;
      return sandbox;
    },
  };
  return { state, fresh, sandbox, Sandbox, CommandExitError, NotFoundError };
});

vi.mock("e2b", () => ({
  Sandbox: sdk.Sandbox,
  CommandExitError: sdk.CommandExitError,
  NotFoundError: sdk.NotFoundError,
}));

const WORKTREE = "/home/user/workspace";

const behave = (outcome: ReturnType<typeof sdk.state.behave>) => {
  sdk.state.behave = (command) =>
    command.includes("$HOME/workspace") ? { stdout: `${WORKTREE}\n` } : outcome;
};

beforeEach(() => {
  Object.assign(sdk.state, sdk.fresh());
  behave({});
});

const createHandle = (options?: Parameters<typeof e2b>[0]) =>
  e2b(options).create({ env: { TOKEN: "secret" } });

describe("e2b()", () => {
  it("returns an isolated provider named 'e2b'", () => {
    const provider = e2b({ env: { E2B_VAR: "value" } });
    expect(provider.tag).toBe("isolated");
    expect(provider.name).toBe("e2b");
    expect(provider.env).toEqual({ E2B_VAR: "value" });
    expect(e2b().env).toEqual({});
  });

  it("creates a killable sandbox with Sandcastle env and a 30 minute default timeout", async () => {
    const handle = await createHandle({
      template: "claude",
      lifecycle: { onTimeout: "pause", autoResume: true },
      envs: { LEAK: "1" },
    } as any);

    expect(sdk.state.createOpts).toEqual({
      template: "claude",
      timeoutMs: 30 * 60 * 1000,
      envs: { TOKEN: "secret" },
      lifecycle: { onTimeout: "kill", autoResume: false },
    });
    expect(handle.worktreePath).toBe(WORKTREE);
  });

  it("passes a custom timeout through", async () => {
    await createHandle({ timeoutMs: 5_000 });
    expect(sdk.state.createOpts.timeoutMs).toBe(5_000);
  });

  it("kills the sandbox when setup after creation fails", async () => {
    sdk.state.behave = () => new Error("setup failed");
    await expect(createHandle()).rejects.toThrow("setup failed");
    expect(sdk.state.killed).toBe(1);
  });
});

describe("exec", () => {
  it("returns complete output when not streaming", async () => {
    const big = "x".repeat(100_000);
    behave({ stdout: big, stderr: "warn" });
    const handle = await createHandle();

    const result = await handle.exec("git diff HEAD");

    expect(result).toEqual({ stdout: big, stderr: "warn", exitCode: 0 });
    expect(sdk.state.runs.at(-1)!.opts).toMatchObject({
      cwd: WORKTREE,
      stdin: false,
      timeoutMs: 0,
    });
  });

  it("streams complete lines across chunk boundaries", async () => {
    behave({ chunks: ["a\nb", "c\n\nd"] });
    const handle = await createHandle();
    const lines: string[] = [];

    const result = await handle.exec("agent", {
      onLine: (line) => lines.push(line),
    });

    expect(lines).toEqual(["a", "bc", "", "d"]);
    expect(result.stdout).toBe("a\nbc\n\nd");
  });

  it("keeps stderr separate and bounds the returned tails", async () => {
    behave({ chunks: ["first\n", "second\n"], errChunks: ["oops", "!"] });
    const handle = await createHandle({ maxOutputTailChars: 6 });
    const lines: string[] = [];

    const result = await handle.exec("agent", {
      onLine: (line) => lines.push(line),
    });

    expect(lines).toEqual(["first", "second"]);
    expect(result.stdout).toBe("second");
    expect(result.stderr).toBe("oops!");
  });

  it("pipes stdin and closes it", async () => {
    const handle = await createHandle();

    await handle.exec("claude -p -", { stdin: "prompt" });

    expect(sdk.state.runs.at(-1)!.opts.stdin).toBe(true);
    expect(sdk.state.stdin).toEqual(["prompt"]);
    expect(sdk.state.stdinClosed).toBe(1);
  });

  it("closes stdin without sending data when stdin is empty", async () => {
    const handle = await createHandle();

    await handle.exec("cat", { stdin: "" });

    expect(sdk.state.stdin).toEqual([]);
    expect(sdk.state.stdinClosed).toBe(1);
  });

  it("returns the result when the command exits before reading stdin", async () => {
    behave({ stdout: "done", exitCode: 0 });
    const handle = await createHandle();
    sdk.state.stdinError = new sdk.NotFoundError("process not found");

    const result = await handle.exec("echo done", { stdin: "prompt" });

    expect(result).toEqual({ stdout: "done", stderr: "", exitCode: 0 });
    expect(sdk.state.commandKilled).toBe(0);
  });

  it("kills the command when stdin cannot be delivered", async () => {
    const handle = await createHandle();
    sdk.state.stdinError = new Error("connection reset");

    await expect(handle.exec("cat", { stdin: "prompt" })).rejects.toThrow(
      "connection reset",
    );
    expect(sdk.state.commandKilled).toBe(1);
  });

  it("maps non-zero exits to an exit code", async () => {
    behave({ stdout: "out", stderr: "err", exitCode: 42 });
    const handle = await createHandle();

    expect(await handle.exec("exit 42")).toEqual({
      stdout: "out",
      stderr: "err",
      exitCode: 42,
    });
  });

  it("rejects on infrastructure errors", async () => {
    const handle = await createHandle();
    behave(new Error("sandbox not running"));

    await expect(handle.exec("echo hi")).rejects.toThrow("sandbox not running");
  });

  it("runs sudo commands as root", async () => {
    const handle = await createHandle();

    await handle.exec("apt-get update", { sudo: true, cwd: "/tmp" });

    expect(sdk.state.runs.at(-1)!.opts).toMatchObject({
      user: "root",
      cwd: "/tmp",
    });
  });
});

describe("copyIn", () => {
  it("applies the host mode even for 0644 files, which may overwrite another mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e2b-copyin-"));
    const file = join(dir, "notes.txt");
    writeFileSync(file, "hi", { mode: 0o644 });
    const handle = await createHandle();

    await handle.copyIn(file, "/home/user/workspace/notes.txt");

    expect(sdk.state.runs.at(-1)!.command).toBe(
      "chmod 644 '/home/user/workspace/notes.txt'",
    );
  });

  it("escapes sandbox paths and preserves the file mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e2b-copyin-"));
    const file = join(dir, "run.sh");
    writeFileSync(file, "echo hi", { mode: 0o755 });
    const handle = await createHandle();

    await handle.copyIn(file, "/tmp/it's here/run.sh");

    expect(sdk.sandbox.files.write).toHaveBeenCalledWith(
      "/tmp/it's here/run.sh",
      expect.any(Blob),
    );
    expect(sdk.state.runs.at(-1)!.command).toBe(
      "chmod 755 '/tmp/it'\\''s here/run.sh'",
    );
  });
});
