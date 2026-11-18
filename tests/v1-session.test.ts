import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import type {
  AgentStreamEvent,
  Sandbox,
  ClaudeCodeAgentOptions,
  OutputObjectDefinition,
  OutputStringDefinition,
} from "@ai-hero/sandcastle/v1";
import {
  claudeCode,
  createSandbox,
  Output,
  SessionFailedError,
  StructuredOutputError,
} from "@ai-hero/sandcastle/v1";
import { host } from "@ai-hero/sandcastle/v1/sandboxes/host";
import { fakeAgent, fakeSandbox } from "@ai-hero/sandcastle/v1/testing";

// Sessions run by the session supervisor: the real bundle, copied into a
// sandbox and run there with Node, with a fake agent replaying Claude Code
// stream-json through the real claudeCode parser. The same held-session cases
// run twice: in fakeSandbox(), which needs `sh` and POSIX process groups and
// so skips on Windows, and in host(), on every OS (on Windows with no `sh`).

const RECORDED = path.resolve(
  import.meta.dirname,
  "../src/__fixtures__/context-window/claude-code.stream.jsonl",
);
const RECORDED_SESSION_ID = "83420a0e-a8fe-4ad6-80be-9574b7a2bd48";

const init = (sessionId: string): string =>
  JSON.stringify({ type: "system", subtype: "init", session_id: sessionId });

const assistant = (text: string): string =>
  JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text }],
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
        output_tokens: 4,
      },
    },
  });

const result = (text: string): string =>
  JSON.stringify({ type: "result", is_error: false, result: text });

const replying = (sessionId: string, text: string): string[] => [
  init(sessionId),
  assistant(text),
  result(text),
];

const ANSWER = Output.object({
  tag: "answer",
  schema: z.object({ answer: z.number() }),
});

/** Where Claude Code keeps a session's file under a home directory. */
const claudeProjects = (home: string): string =>
  path.join(home, ".claude", "projects");

const listRecursive = async (dir: string): Promise<string[]> =>
  readdir(dir, { recursive: true }).catch((): string[] => []);

const isWindows = process.platform === "win32";

/** The supervisor's channel: a socket file, except on Windows, where it's a named pipe. */
const SOCKET_FILES = isWindows ? [] : ["control.sock"];

/** How an agent that isn't on PATH exits: 127 from `sh`; on Windows, cmd.exe's own code. */
const NOT_FOUND_EXIT = isWindows ? {} : { exitCode: 127 };

/** A PATH with nothing on it. */
const NOWHERE = isWindows ? String.raw`C:\nowhere` : "/nowhere";

/** Where a suite's sandboxes come from, and how it finds a sandbox's home. */
interface SessionWorld {
  readonly open: () => Promise<Sandbox>;
  readonly homeOf: (sandbox: Sandbox) => string;
  readonly closeAll: () => Promise<void>;
}

const fakeWorld = (rootDir: string): SessionWorld => {
  const provider = fakeSandbox({ rootDir });
  return {
    open: async () => createSandbox({ provider }),
    homeOf: (sandbox) => path.join(provider.pathOf(sandbox.sandboxId), "home"),
    closeAll: async () => provider.closeAll(),
  };
};

const hostWorld = (rootDir: string): SessionWorld => {
  const opened: Sandbox[] = [];
  return {
    open: async () => {
      const sandbox = await createSandbox({
        provider: host({ create: { rootDir } }),
      });
      opened.push(sandbox);
      return sandbox;
    },
    homeOf: (sandbox) => path.join(rootDir, sandbox.sandboxId, "home"),
    closeAll: async () => {
      await Promise.all(opened.splice(0).map(async (made) => made.close()));
    },
  };
};

/** The held-session cases, in sandboxes from `makeWorld`, registered inside a describe. */
const sessionCases = (makeWorld: (rootDir: string) => SessionWorld): void => {
  let rootDir = "";
  let world = makeWorld(tmpdir());

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-session-"));
    world = makeWorld(rootDir);
  });

  afterEach(async () => {
    await world.closeAll();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 20 });
  });

  test("copies the supervisor in at createSandbox and starts it", async () => {
    const sandbox = await world.open();
    const home = world.homeOf(sandbox);

    const files = await listRecursive(path.join(home, ".sandcastle"));

    expect(files).toContain(
      path.join("supervisor", sandbox.sandboxId, "supervisor.mjs"),
    );
    expect(files).toStrictEqual(
      expect.arrayContaining(
        SOCKET_FILES.map((file) =>
          path.join("supervisor", sandbox.sandboxId, file),
        ),
      ),
    );
  });

  test("replays a recorded claudeCode stream end to end: final message, session id, usage, context window and events", async () => {
    const recorded = await readFile(RECORDED, "utf8");
    const lines = recorded.trim().split("\n");
    const sandbox = await world.open();

    const spawned = await sandbox.spawnSession({
      agent: fakeAgent({ lines }),
      prompt: "Read the notes, then say DONE.",
    });
    const events: AgentStreamEvent[] = [];
    for await (const event of spawned.events) {
      events.push(event);
    }
    const done = await spawned.wait();

    expect(done).toMatchObject({
      name: "session-1",
      agent: "claude-code",
      sessionId: RECORDED_SESSION_ID,
      exitReason: "completed",
      finalMessage: "DONE",
      workingDirectory: sandbox.workingDirectory,
    });
    expect(done.output).toBeUndefined();
    expect(done.usage?.outputTokens).toBeGreaterThan(0);
    expect(done.contextWindow?.tokens).toBeGreaterThan(0);
    expect(events.filter((event) => event.type === "toolCall")).toHaveLength(5);
    expect(events.at(-1)).toStrictEqual({ type: "text", text: "DONE" });
  });

  test("returns typed structured output validated on the host", async () => {
    const sandbox = await world.open();

    const done = await sandbox.session({
      agent: fakeAgent({
        lines: replying("s-typed", 'Here: <answer>{"answer": 7}</answer>'),
      }),
      prompt: "Reply in <answer> tags.",
      output: ANSWER,
    });

    const answer: number = done.output.answer;
    expect(answer).toBe(7);
  });

  test("has no output retries and no host-side session capture (types)", () => {
    const retried: OutputObjectDefinition<{ readonly answer: number }> = {
      ...ANSWER,
      // @ts-expect-error a v1 session never retries its output
      maxRetries: 1,
    };
    const retriedText: OutputStringDefinition = {
      ...Output.string({ tag: "answer" }),
      // @ts-expect-error a v1 session never retries its output
      maxRetries: 1,
    };
    const captured: ClaudeCodeAgentOptions = {
      // @ts-expect-error v1 writes nothing to the host
      captureSessions: false,
    };
    expect([retried, retriedText, captured]).toHaveLength(3);
  });

  test("rejects with StructuredOutputError when the output is missing or fails the schema", async () => {
    const sandbox = await world.open();

    await expect(
      sandbox.session({
        agent: fakeAgent({ lines: replying("s-missing", "no tag here") }),
        prompt: "Reply in <answer> tags.",
        output: ANSWER,
      }),
    ).rejects.toBeInstanceOf(StructuredOutputError);
    await expect(
      sandbox.session({
        agent: fakeAgent({
          lines: replying("s-invalid", '<answer>{"answer": "seven"}</answer>'),
        }),
        prompt: "Reply in <answer> tags.",
        output: ANSWER,
      }),
    ).rejects.toMatchObject({
      _tag: "StructuredOutputError",
      tag: "answer",
      rawMatched: '{"answer": "seven"}',
    });
  });

  test("fails before starting when the prompt lacks the output's opening tag (ADR 0020)", async () => {
    const sandbox = await world.open();
    const home = world.homeOf(sandbox);

    await expect(
      sandbox.session({
        agent: fakeAgent({
          lines: replying("s-no-tag", "<answer>{}</answer>"),
        }),
        prompt: "No tag in this prompt.",
        output: ANSWER,
      }),
    ).rejects.toThrow(/output tag <answer> not found in the prompt/u);
    await expect(listRecursive(claudeProjects(home))).resolves.toStrictEqual(
      [],
    );
  });

  test("spawnSession() resolves once the agent is running", async () => {
    const sandbox = await world.open();
    const home = world.homeOf(sandbox);

    const spawned = await sandbox.spawnSession({
      agent: fakeAgent({ lines: [init("s-running")], hang: true }),
      prompt: "Work forever.",
    });

    expect(spawned.name).toBe("session-1");
    await expect(listRecursive(claudeProjects(home))).resolves.toContainEqual(
      expect.stringContaining("s-running.jsonl"),
    );
    await spawned.kill();
    await expect(spawned.wait()).rejects.toMatchObject({
      _tag: "SessionFailedError",
      exitReason: "aborted",
      started: true,
    });
  });

  test("two sessions spawned at once with one name: one runs, the other is refused", async () => {
    const sandbox = await world.open();
    const spawn = async (sessionId: string) =>
      sandbox.spawnSession({
        name: "twin",
        agent: fakeAgent({ lines: [init(sessionId)], hang: true }),
        prompt: "Work forever.",
      });

    const outcomes = await Promise.all(
      [spawn("s-twin-1"), spawn("s-twin-2")].map(async (spawning) =>
        spawning.then(
          (spawned) => ({ ran: spawned.name }),
          (error: unknown) => ({ refused: error }),
        ),
      ),
    );

    expect(outcomes).toHaveLength(2);
    expect(outcomes).toStrictEqual(
      expect.arrayContaining([
        { ran: "twin" },
        {
          refused: new TypeError(
            'session: a session named "twin" is already running',
          ),
        },
      ]),
    );
  });

  test("a session name is free again once spawning it failed", async () => {
    const sandbox = await world.open();

    await expect(
      sandbox.spawnSession({
        name: "retry",
        agent: claudeCode("claude-opus-4-8"),
        prompt: "Hello",
        env: { PATH: NOWHERE },
      }),
    ).rejects.toBeInstanceOf(SessionFailedError);
    await expect(
      sandbox.session({
        name: "retry",
        agent: fakeAgent({ lines: replying("s-retry", "Again.") }),
        prompt: "Hello",
      }),
    ).resolves.toMatchObject({ finalMessage: "Again." });
  });

  test("spawnSession() rejects when the agent can't start", async () => {
    const sandbox = await world.open();

    // No `claude` on this session's PATH.
    const spawning = sandbox.spawnSession({
      agent: claudeCode("claude-opus-4-8"),
      prompt: "Hello",
      env: { PATH: NOWHERE },
    });

    await expect(spawning).rejects.toBeInstanceOf(SessionFailedError);
    await expect(spawning).rejects.toMatchObject({
      exitReason: "failed",
      started: false,
      ...NOT_FOUND_EXIT,
    });
  });

  test("the idle timeout fails a silent session", async () => {
    const sandbox = await world.open();

    await expect(
      sandbox.session({
        agent: fakeAgent({ lines: [init("s-silent")], hang: true }),
        prompt: "Say nothing.",
        idleTimeoutSeconds: 0.5,
      }),
    ).rejects.toMatchObject({
      _tag: "SessionFailedError",
      exitReason: "idle-timeout",
    });
  });

  // The closing-tag grace window, ported from 0.x run()'s tests (ADR 0021).
  test("force-completes on the closing tag when the agent hangs", async () => {
    const sandbox = await world.open();

    const done = await sandbox.session({
      agent: fakeAgent({
        lines: [init("hang-out"), result('<answer>{"answer":7}</answer>')],
        hang: true,
      }),
      prompt: "emit <answer>",
      output: ANSWER,
      completionTimeoutSeconds: 0.2,
      idleTimeoutSeconds: 30,
    });

    expect(done.output).toStrictEqual({ answer: 7 });
    expect(done.sessionId).toBe("hang-out");
    expect(done.exitReason).toBe("closing-tag");
  });

  test("does NOT start the grace window on the opening tag alone", async () => {
    const sandbox = await world.open();

    await expect(
      sandbox.session({
        agent: fakeAgent({
          lines: [init("half"), result('<answer>{"answer":')],
          hang: true,
        }),
        prompt: "emit <answer>",
        output: ANSWER,
        completionTimeoutSeconds: 0.05,
        idleTimeoutSeconds: 0.4,
      }),
    ).rejects.toMatchObject({ exitReason: "idle-timeout" });
  });

  test("WITHOUT output has no completion trigger: a hang rides the idle timeout", async () => {
    const sandbox = await world.open();

    await expect(
      sandbox.session({
        agent: fakeAgent({
          lines: [init("gap"), result("done <promise>COMPLETE</promise>")],
          hang: true,
        }),
        prompt: "x",
        completionTimeoutSeconds: 0.05,
        idleTimeoutSeconds: 0.4,
      }),
    ).rejects.toMatchObject({ exitReason: "idle-timeout" });
  });

  test("fails a session whose agent exits non-zero", async () => {
    const sandbox = await world.open();

    await expect(
      sandbox.session({
        agent: fakeAgent({ lines: [init("s-exit")], exitCode: 3 }),
        prompt: "Fail.",
      }),
    ).rejects.toMatchObject({
      exitReason: "failed",
      started: true,
      exitCode: 3,
      sessionId: "s-exit",
    });
  });

  test("continueSession continues the conversation in the same sandbox, writing nothing to the host's agent directories", async () => {
    const sandbox = await world.open();
    const home = world.homeOf(sandbox);
    const before = await listRecursive(claudeProjects(homedir()));

    const first = await sandbox.session({
      agent: fakeAgent({ lines: replying("s-convo", "Planned.") }),
      prompt: "Plan it.",
    });
    const second = await sandbox.session({
      agent: fakeAgent({ lines: replying("s-convo", "Built.") }),
      prompt: "Now build it.",
      continueSession: first,
    });

    expect(second).toMatchObject({
      sessionId: "s-convo",
      finalMessage: "Built.",
    });
    const files = await listRecursive(claudeProjects(home));
    const sessionFiles = files.filter((file) => file.endsWith("s-convo.jsonl"));
    expect(sessionFiles).toHaveLength(1);
    const transcript = await readFile(
      path.join(claudeProjects(home), String(sessionFiles[0])),
      "utf8",
    );
    expect(transcript).toContain("Plan it.");
    expect(transcript).toContain("Now build it.");
    await expect(
      listRecursive(claudeProjects(homedir())),
    ).resolves.toStrictEqual(before);
  });

  test("a continued session fails when its conversation isn't in this sandbox", async () => {
    const other = await world.open();
    const sandbox = await world.open();
    const first = await other.session({
      agent: fakeAgent({ lines: replying("s-elsewhere", "Planned.") }),
      prompt: "Plan it.",
    });

    const continuing = sandbox.session({
      agent: fakeAgent({ lines: replying("s-elsewhere", "Built.") }),
      prompt: "Now build it.",
      continueSession: first,
    });

    await expect(continuing).rejects.toMatchObject({ exitReason: "failed" });
    await expect(continuing).rejects.toThrow(/No conversation found/u);
  });

  test("runs two sessions at once in one sandbox", async () => {
    const sandbox = await world.open();

    const [left, right] = await Promise.all([
      sandbox.session({
        agent: fakeAgent({ lines: replying("s-left", "left") }),
        prompt: "left",
      }),
      sandbox.session({
        agent: fakeAgent({ lines: replying("s-right", "right") }),
        prompt: "right",
      }),
    ]);

    expect([left.name, right.name]).toStrictEqual(["session-1", "session-2"]);
    expect([left.finalMessage, right.finalMessage]).toStrictEqual([
      "left",
      "right",
    ]);
  });

  test("an abortSignal stops the session", async () => {
    const sandbox = await world.open();
    const controller = new AbortController();

    const spawned = await sandbox.spawnSession({
      agent: fakeAgent({ lines: [init("s-abort")], hang: true }),
      prompt: "Work forever.",
      abortSignal: controller.signal,
    });
    controller.abort();

    await expect(spawned.wait()).rejects.toMatchObject({
      exitReason: "aborted",
    });
  });

  test("rejects an agent that isn't a built-in one", async () => {
    const sandbox = await world.open();

    await expect(
      sandbox.session({
        agent: { name: "claude-code", model: "custom", acceptsInput: true },
        prompt: "Hello",
      }),
    ).rejects.toThrow(/built-in agent factory/u);
  });
};

// fakeSandbox() needs `sh` and POSIX process groups.
describe.skipIf(isWindows)("sessions (v1) in fakeSandbox()", () => {
  sessionCases(fakeWorld);
});

describe("sessions (v1) in host()", () => {
  sessionCases(hostWorld);
});
