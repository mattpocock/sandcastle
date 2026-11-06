import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DetachableSandbox, RecordedEvent } from "@ai-hero/sandcastle/v1";
import {
  claudeCode,
  codex,
  createSandbox,
  Output,
  reattachSandbox,
  SandboxDetachedError,
  SessionInputError,
} from "@ai-hero/sandcastle/v1";
import type { FakeSandboxProvider } from "@ai-hero/sandcastle/v1/testing";
import { fakeAgent, fakeSandbox } from "@ai-hero/sandcastle/v1/testing";

// send(), end to end: the real supervisor bundle in a fake sandbox, with a
// fake Claude Code that takes streaming input the way the real CLI does (it
// prints each message back when it reads it, and answers by repeating it).
// POSIX only, and the bundle comes from the build, so these skip on Windows.

const init = (sessionId: string): string =>
  JSON.stringify({ type: "system", subtype: "init", session_id: sessionId });

const assistant = (text: string): string =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });

const toolUse = (command: string): string =>
  JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name: "Bash", input: { command } }],
    },
  });

const result = (text: string): string =>
  JSON.stringify({ type: "result", is_error: false, result: text });

/** An agent whose turn is still running: a long tool call it never returns from on its own. */
const working = (sessionId: string) =>
  fakeAgent({
    lines: [
      init(sessionId),
      assistant("Running the tests."),
      toolUse("npm test"),
    ],
    hang: true,
  });

const withoutTime = ({ at: _at, ...event }: RecordedEvent) => event;

/** Reattaches, failing the test when the supervisor isn't there. */
const reattach = async (
  options: Parameters<typeof reattachSandbox>[0],
): Promise<DetachableSandbox> => {
  const handle = await reattachSandbox(options);
  if (handle === undefined) {
    throw new Error("the supervisor should be there");
  }
  return handle;
};

const readAll = async (
  events: AsyncIterable<RecordedEvent>,
): Promise<RecordedEvent[]> => {
  const seen: RecordedEvent[] = [];
  for await (const event of events) {
    seen.push(event);
  }
  return seen;
};

describe.skipIf(process.platform === "win32")("send() (v1)", () => {
  let rootDir = "";
  let provider: FakeSandboxProvider = fakeSandbox();

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-send-"));
    provider = fakeSandbox({ rootDir });
  });

  afterEach(async () => {
    await provider.closeAll();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("hands a message to a turn that's still running: the agent reads it with who sent it, and the session ends with its answer", async () => {
    const sandbox = await createSandbox({ provider });
    const spawned = await sandbox.spawnSession({
      agent: working("s-guide"),
      prompt: "Fix the bug.",
    });

    const receipt = await spawned.send({
      text: "Also add a regression test.",
      from: "Ada",
    });
    const done = await spawned.wait();

    expect(receipt).toMatchObject({ session: "session-1", interrupted: false });
    expect(receipt.at).toBeInstanceOf(Date);
    expect(done).toMatchObject({
      exitReason: "completed",
      finalMessage: "[from Ada] Also add a regression test.",
      sessionId: "s-guide",
    });
  });

  it("passes a message without `from` through as it is", async () => {
    const sandbox = await createSandbox({ provider });
    const spawned = await sandbox.spawnSession({
      agent: working("s-plain"),
      prompt: "Fix the bug.",
    });

    await sandbox.send({ text: "Use the existing helper." });

    await expect(spawned.wait()).resolves.toMatchObject({
      finalMessage: "Use the existing helper.",
    });
  });

  it("interrupts the running turn: the session carries on with the message and succeeds, though the interrupted turn ended in an error", async () => {
    const sandbox = await createSandbox({ provider });
    const spawned = await sandbox.spawnSession({
      name: "implement",
      agent: working("s-interrupt"),
      prompt: "Fix the bug.",
    });

    const receipt = await sandbox.send({
      session: "implement",
      text: "Stop. Write up what you have.",
      from: "monitor",
      interrupt: true,
    });

    expect(receipt).toMatchObject({ session: "implement", interrupted: true });
    await expect(spawned.wait()).resolves.toMatchObject({
      exitReason: "completed",
      finalMessage: "[from monitor] Stop. Write up what you have.",
    });
  });

  it("refuses a message once the agent has finished its last turn, even while its process lingers", async () => {
    const sandbox = await createSandbox({ provider });
    const spawned = await sandbox.spawnSession({
      agent: fakeAgent({
        // A turn that has ended, by a process still running after it, like
        // one waiting on a background task before it exits.
        lines: [init("s-lingering"), assistant("Done."), result("Done.")],
        hang: true,
      }),
      prompt: "Say done.",
    });

    await expect(
      spawned.send({ text: "One more thing." }),
    ).rejects.toMatchObject({
      _tag: "SessionInputError",
      reason: "stopped-taking-input",
    });
    await spawned.kill();
  });

  it("holds the completion timeout off while a message hasn't been read yet", async () => {
    const sandbox = await createSandbox({ provider });
    const spawned = await sandbox.spawnSession({
      agent: fakeAgent({
        lines: [init("s-late"), assistant("<summary>first draft</summary>")],
        hang: true,
        // Read after the completion timeout would have stopped the agent.
        inputDelaySeconds: 2,
      }),
      prompt: "Summarise in <summary> tags.",
      output: Output.string({ tag: "summary" }),
      completionTimeoutSeconds: 1,
    });

    await spawned.send({ text: "Reply <summary>second draft</summary>" });

    await expect(spawned.wait()).resolves.toMatchObject({
      exitReason: "completed",
      output: "second draft",
    });
  }, 15_000);

  it("reaches a session from a reattached handle after a detach; follow() and the record show each message, redacted", async () => {
    const sandbox = await createSandbox({ provider });
    const spawned = await sandbox.spawnSession({
      name: "implement",
      agent: working("s-detached"),
      prompt: "Fix the bug.",
      record: { redact: { values: ["hunter2"] } },
    });
    await sandbox.detach();
    const later = await reattach({
      provider: fakeSandbox({ rootDir }),
      sandboxId: sandbox.sandboxId,
    });

    await expect(spawned.send({ text: "Hello." })).rejects.toBeInstanceOf(
      SandboxDetachedError,
    );
    await later.send({
      session: "implement",
      text: "The password is hunter2.",
      from: "Ada",
    });
    const seen = await readAll(later.follow({ session: "implement" }));
    const status = await later.status();

    expect(seen.map((event) => withoutTime(event))).toContainEqual({
      type: "input",
      text: "The password is [REDACTED].",
      from: "Ada",
      interrupt: false,
    });
    expect(seen.at(-1)).toMatchObject({
      type: "text",
      text: "[from Ada] The password is [REDACTED].",
    });
    expect(status.ended).toMatchObject([
      { name: "implement", exitReason: "completed" },
    ]);
  }, 30_000);

  it("says which agents take input", () => {
    expect(claudeCode("claude-opus-4-8").acceptsInput).toBe(true);
    expect(fakeAgent({ lines: [] }).acceptsInput).toBe(true);
    expect(codex("gpt-5.5").acceptsInput).toBe(false);
    expect(fakeAgent({ format: "codex", lines: [] }).acceptsInput).toBe(false);
  });

  it("refuses an agent that takes no input, a session it can't pick, and a session that has ended", async () => {
    const sandbox = await createSandbox({ provider });
    const codexSession = await sandbox.spawnSession({
      name: "codex",
      agent: fakeAgent({
        format: "codex",
        lines: [JSON.stringify({ type: "thread.started", thread_id: "t-1" })],
        hang: true,
      }),
      prompt: "Fix the bug.",
    });
    await sandbox.spawnSession({
      name: "claude",
      agent: working("s-other"),
      prompt: "Fix the bug.",
    });

    await expect(codexSession.send({ text: "Hello." })).rejects.toMatchObject({
      _tag: "SessionInputError",
      reason: "agent-takes-no-input",
    });
    await expect(sandbox.send({ text: "Hello." })).rejects.toMatchObject({
      reason: "ambiguous-session",
    });
    await expect(
      sandbox.send({ session: "review", text: "Hello." }),
    ).rejects.toMatchObject({ reason: "no-such-session" });
    await expect(sandbox.send({ text: "  " })).rejects.toBeInstanceOf(
      TypeError,
    );

    const ended = await sandbox.spawnSession({
      name: "quick",
      agent: fakeAgent({ lines: [init("s-quick"), result("Done.")] }),
      prompt: "Say done.",
    });
    await ended.wait();

    await expect(ended.send({ text: "One more thing." })).rejects.toThrow(
      SessionInputError,
    );
    await expect(ended.send({ text: "One more thing." })).rejects.toMatchObject(
      { reason: "no-such-session" },
    );
  }, 15_000);
});
