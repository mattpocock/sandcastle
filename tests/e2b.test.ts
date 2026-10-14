import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExitError, Sandbox } from "e2b";
import type { CommandResult, CommandStartOpts } from "e2b";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { e2b } from "@ai-hero/sandcastle/sandboxes/e2b";

// e2b() runs against the real `e2b` SDK classes with their network calls
// stubbed: Sandbox.create() returns a Sandbox that never connects, whose
// commands answer from `state.behave`, and whose background command handles
// record the stdin they get.

interface Outcome {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly chunks?: readonly string[];
  readonly errChunks?: readonly string[];
}

type RunOpts = CommandStartOpts & { background?: boolean };

interface FakeState {
  createOpts: unknown;
  killed: number;
  runs: { command: string; opts: RunOpts }[];
  stdin: string[];
  stdinClosed: number;
  stdinError: Error | undefined;
  commandKilled: number;
  behave: (command: string) => Outcome | Error;
}

const fresh = (): FakeState => ({
  createOpts: undefined,
  killed: 0,
  runs: [],
  stdin: [],
  stdinClosed: 0,
  stdinError: undefined,
  commandKilled: 0,
  behave: () => ({}),
});
const state = fresh();

const settle = (o: Outcome): CommandResult => {
  const result = {
    stdout: o.stdout ?? "",
    stderr: o.stderr ?? "",
    exitCode: o.exitCode ?? 0,
  };
  if (result.exitCode !== 0) {
    throw new CommandExitError(result);
  }
  return result;
};

const failStdin = (): void => {
  if (state.stdinError !== undefined) {
    throw state.stdinError;
  }
};

/**
 * Stands in for a background CommandHandle. The SDK exports that class as a
 * type only, so the fake is installed on `commands.run` by defineProperty.
 */
const background = (outcome: Outcome, opts: RunOpts) => ({
  sendStdin: async (data: string) => {
    failStdin();
    state.stdin.push(data);
  },
  closeStdin: async () => {
    failStdin();
    state.stdinClosed++;
  },
  kill: async () => {
    state.commandKilled++;
    return true;
  },
  wait: async () => {
    for (const chunk of outcome.chunks ?? []) {
      void opts.onStdout?.(chunk);
    }
    for (const chunk of outcome.errChunks ?? []) {
      void opts.onStderr?.(chunk);
    }
    return settle(outcome);
  },
});

const fakeRun = async (command: string, opts: RunOpts = {}) => {
  state.runs.push({ command, opts });
  const outcome = state.behave(command);
  if (outcome instanceof Error) {
    throw outcome;
  }
  return opts.background === true ? background(outcome, opts) : settle(outcome);
};

const behave = (outcome: Outcome | Error): void => {
  state.behave = (command) =>
    command.includes("$HOME/workspace") ? { stdout: `${WORKTREE}\n` } : outcome;
};

const sandbox = new Sandbox({
  sandboxId: "sbx-1",
  envdVersion: "0.4.0",
  apiKey: "e2b_fake",
});
const writeFile = vi.spyOn(sandbox.files, "write");

beforeEach(() => {
  Object.assign(state, fresh());
  vi.spyOn(Sandbox, "create").mockImplementation(async (opts: unknown) => {
    state.createOpts = opts;
    return sandbox;
  });
  vi.spyOn(sandbox, "kill").mockImplementation(async () => {
    state.killed++;
    return true;
  });
  writeFile.mockReset();
  writeFile.mockResolvedValue([]);
  Object.defineProperty(sandbox.commands, "run", { value: fakeRun });
  behave({});
});

const WORKTREE = "/home/user/workspace";

/** The SDK's error for a process that is already gone. */
const processNotFound = (): Error => {
  const error = new Error("process not found");
  error.name = "NotFoundError";
  return error;
};

const lastRun = () => {
  const run = state.runs.at(-1);
  expect(run).toBeDefined();
  return run ?? { command: "", opts: {} };
};

const createHandle = async (options?: Parameters<typeof e2b>[0]) =>
  e2b(options).create({ env: { TOKEN: "secret" } });

describe("e2b()", () => {
  it("returns an isolated provider named 'e2b'", () => {
    const provider = e2b({ env: { E2B_VAR: "value" } });
    expect(provider.tag).toBe("isolated");
    expect(provider.name).toBe("e2b");
    expect(provider.env).toStrictEqual({ E2B_VAR: "value" });
    expect(e2b().env).toStrictEqual({});
  });

  it("creates a killable sandbox with Sandcastle env and a 30 minute default timeout", async () => {
    // envs and lifecycle are not E2BOptions; plain JS callers can still pass them.
    const options = {
      template: "claude",
      lifecycle: { onTimeout: "pause", autoResume: true },
      envs: { LEAK: "1" },
    };
    const handle = await createHandle(options);

    expect(state.createOpts).toStrictEqual({
      template: "claude",
      timeoutMs: 30 * 60 * 1000,
      envs: { TOKEN: "secret" },
      lifecycle: { onTimeout: "kill", autoResume: false },
    });
    expect(handle.worktreePath).toBe(WORKTREE);
    expect(handle.sandboxId).toBe("sbx-1");
  });

  it("passes a custom timeout through", async () => {
    await createHandle({ timeoutMs: 5000 });
    expect(state.createOpts).toMatchObject({ timeoutMs: 5000 });
  });

  it("kills the sandbox when setup after creation fails", async () => {
    state.behave = () => new Error("setup failed");
    await expect(createHandle()).rejects.toThrow("setup failed");
    expect(state.killed).toBe(1);
  });
});

describe("exec", () => {
  it("returns complete output when not streaming", async () => {
    const big = "x".repeat(100_000);
    behave({ stdout: big, stderr: "warn" });
    const handle = await createHandle();

    const result = await handle.exec("git diff HEAD");

    expect(result).toStrictEqual({ stdout: big, stderr: "warn", exitCode: 0 });
    expect(lastRun().opts).toMatchObject({
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
      onLine: (line) => {
        lines.push(line);
      },
    });

    expect(lines).toStrictEqual(["a", "bc", "", "d"]);
    expect(result.stdout).toBe("a\nbc\n\nd");
  });

  it("keeps stderr separate and bounds the returned tails", async () => {
    behave({ chunks: ["first\n", "second\n"], errChunks: ["oops", "!"] });
    const handle = await createHandle({ maxOutputTailChars: 6 });
    const lines: string[] = [];

    const result = await handle.exec("agent", {
      onLine: (line) => {
        lines.push(line);
      },
    });

    expect(lines).toStrictEqual(["first", "second"]);
    expect(result.stdout).toBe("second");
    expect(result.stderr).toBe("oops!");
  });

  it("pipes stdin and closes it", async () => {
    const handle = await createHandle();

    await handle.exec("claude -p -", { stdin: "prompt" });

    expect(lastRun().opts.stdin).toBe(true);
    expect(state.stdin).toStrictEqual(["prompt"]);
    expect(state.stdinClosed).toBe(1);
  });

  it("closes stdin without sending data when stdin is empty", async () => {
    const handle = await createHandle();

    await handle.exec("cat", { stdin: "" });

    expect(state.stdin).toStrictEqual([]);
    expect(state.stdinClosed).toBe(1);
  });

  it("returns the result when the command exits before reading stdin", async () => {
    behave({ stdout: "done", exitCode: 0 });
    const handle = await createHandle();
    state.stdinError = processNotFound();

    const result = await handle.exec("echo done", { stdin: "prompt" });

    expect(result).toStrictEqual({ stdout: "done", stderr: "", exitCode: 0 });
    expect(state.commandKilled).toBe(0);
  });

  it("kills the command when stdin cannot be delivered", async () => {
    const handle = await createHandle();
    state.stdinError = new Error("connection reset");

    await expect(handle.exec("cat", { stdin: "prompt" })).rejects.toThrow(
      "connection reset",
    );
    expect(state.commandKilled).toBe(1);
  });

  it("maps non-zero exits to an exit code", async () => {
    behave({ stdout: "out", stderr: "err", exitCode: 42 });
    const handle = await createHandle();

    await expect(handle.exec("exit 42")).resolves.toStrictEqual({
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

    expect(lastRun().opts).toMatchObject({ user: "root", cwd: "/tmp" });
  });
});

describe("copyIn", () => {
  it("applies the host mode even for 0644 files, which may overwrite another mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e2b-copyin-"));
    const file = join(dir, "notes.txt");
    writeFileSync(file, "hi", { mode: 0o644 });
    const handle = await createHandle();

    await handle.copyIn(file, "/home/user/workspace/notes.txt");

    expect(lastRun().command).toBe(
      "chmod 644 '/home/user/workspace/notes.txt'",
    );
  });

  it("escapes sandbox paths and preserves the file mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e2b-copyin-"));
    const file = join(dir, "run.sh");
    writeFileSync(file, "echo hi", { mode: 0o755 });
    const handle = await createHandle();

    await handle.copyIn(file, "/tmp/it's here/run.sh");

    expect(writeFile).toHaveBeenCalledWith(
      "/tmp/it's here/run.sh",
      expect.any(Blob),
    );
    expect(lastRun().command).toBe(
      String.raw`chmod 755 '/tmp/it'\''s here/run.sh'`,
    );
  });
});
