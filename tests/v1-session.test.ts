import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentStreamEvent } from "@ai-hero/sandcastle/v1";
import {
  claudeCode,
  createSandbox,
  Output,
  SessionFailedError,
  StructuredOutputError,
} from "@ai-hero/sandcastle/v1";
import type { FakeSandboxProvider } from "@ai-hero/sandcastle/v1/testing";
import { fakeAgent, fakeSandbox } from "@ai-hero/sandcastle/v1/testing";

// Sessions run by the session supervisor: the real bundle, copied into a fake
// sandbox and run there with Node, with a fake agent replaying Claude Code
// stream-json through the real claudeCode parser. The fake sandbox needs `sh`
// and POSIX process groups, and the supervisor bundle comes from the build
// (the Windows job runs from src without one), so these skip on Windows.

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

describe.skipIf(process.platform === "win32")("sessions (v1)", () => {
  let rootDir = "";
  let provider: FakeSandboxProvider = fakeSandbox();

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-session-"));
    provider = fakeSandbox({ rootDir });
  });

  afterEach(async () => {
    await provider.closeAll();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("copies the supervisor in at createSandbox and starts it", async () => {
    const sandbox = await createSandbox({ provider });
    const home = path.join(provider.pathOf(sandbox.sandboxId), "home");

    const files = await listRecursive(path.join(home, ".sandcastle"));

    expect(files).toContain(
      path.join("supervisor", sandbox.sandboxId, "supervisor.mjs"),
    );
    expect(files).toContain(
      path.join("supervisor", sandbox.sandboxId, "control.sock"),
    );
  });

  it("replays a recorded claudeCode stream end to end: final message, session id, usage, context window and events", async () => {
    const recorded = await readFile(RECORDED, "utf8");
    const lines = recorded.trim().split("\n");
    const sandbox = await createSandbox({ provider });

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

  it("returns typed structured output validated on the host", async () => {
    const sandbox = await createSandbox({ provider });

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

  it("rejects with StructuredOutputError when the output is missing or fails the schema", async () => {
    const sandbox = await createSandbox({ provider });

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

  it("fails before starting when the prompt lacks the output's opening tag (ADR 0020)", async () => {
    const sandbox = await createSandbox({ provider });
    const home = path.join(provider.pathOf(sandbox.sandboxId), "home");

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

  it("spawnSession() resolves once the agent is running", async () => {
    const sandbox = await createSandbox({ provider });
    const home = path.join(provider.pathOf(sandbox.sandboxId), "home");

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

  it("spawnSession() rejects when the agent can't start", async () => {
    const sandbox = await createSandbox({ provider });

    // No `claude` on this session's PATH.
    const spawning = sandbox.spawnSession({
      agent: claudeCode("claude-opus-4-8"),
      prompt: "Hello",
      env: { PATH: "/nowhere" },
    });

    await expect(spawning).rejects.toBeInstanceOf(SessionFailedError);
    await expect(spawning).rejects.toMatchObject({
      exitReason: "failed",
      started: false,
      exitCode: 127,
    });
  });

  it("the idle timeout fails a silent session", async () => {
    const sandbox = await createSandbox({ provider });

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
  it("force-completes on the closing tag when the agent hangs", async () => {
    const sandbox = await createSandbox({ provider });

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

  it("does NOT start the grace window on the opening tag alone", async () => {
    const sandbox = await createSandbox({ provider });

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

  it("WITHOUT output has no completion trigger: a hang rides the idle timeout", async () => {
    const sandbox = await createSandbox({ provider });

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

  it("fails a session whose agent exits non-zero", async () => {
    const sandbox = await createSandbox({ provider });

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

  it("continueSession continues the conversation in the same sandbox, writing nothing to the host's agent directories", async () => {
    const sandbox = await createSandbox({ provider });
    const home = path.join(provider.pathOf(sandbox.sandboxId), "home");
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

  it("a continued session fails when its conversation isn't in this sandbox", async () => {
    const other = await createSandbox({ provider });
    const sandbox = await createSandbox({ provider });
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

  it("runs two sessions at once in one sandbox", async () => {
    const sandbox = await createSandbox({ provider });

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

  it("an abortSignal stops the session", async () => {
    const sandbox = await createSandbox({ provider });
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

  it("rejects an agent that isn't a built-in one", async () => {
    const sandbox = await createSandbox({ provider });

    await expect(
      sandbox.session({
        agent: { name: "claude-code", model: "custom" },
        prompt: "Hello",
      }),
    ).rejects.toThrow(/built-in agent factory/u);
  });
});
