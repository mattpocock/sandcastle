import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DetachableSandbox, RecordedEvent } from "@ai-hero/sandcastle/v1";
import {
  createSandbox,
  reattachSandbox,
  SandboxUnavailableError,
} from "@ai-hero/sandcastle/v1";
import type { FakeSandboxProvider } from "@ai-hero/sandcastle/v1/testing";
import { fakeAgent, fakeSandbox } from "@ai-hero/sandcastle/v1/testing";
import type { FinishReportReceiver } from "./helpers/finishReportReceiver.js";
import {
  finishReportReceiver,
  supervisorDir,
} from "./helpers/finishReportReceiver.js";

// follow(), end to end: the real supervisor bundle in a fake sandbox, its
// session's events read live from outside, as an orchestrator or agent
// watching a detached run would. POSIX only, and the bundle comes from the
// build, so these skip on Windows.

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

/** What the agent below does, as follow() should show it, without the timestamps. */
const EXPECTED = [
  { type: "text", text: "Looking around." },
  { type: "toolCall", name: "Bash", args: "ls" },
  { type: "text", text: "Found it." },
  { type: "toolCall", name: "Bash", args: "cat notes.md" },
  { type: "text", text: "All done." },
];

/**
 * Prints its events, then hangs until `endAgents` stops it, so "still
 * running" never depends on timing.
 */
const working = fakeAgent({
  lines: [
    init("s-follow"),
    assistant("Looking around."),
    toolUse("ls"),
    assistant("Found it."),
    toolUse("cat notes.md"),
    assistant("All done."),
  ],
  hang: true,
});

const SECRET = "whsec_c2FuZGNhc3RsZS1yZWF0dGFjaC10ZXN0";

/** Stops the fake agents running in a sandbox, ending their sessions. */
const endAgents = async (
  sandbox: DetachableSandbox,
  supervisor: string,
): Promise<void> => {
  // The bracket keeps pkill from matching its own shell's command line.
  await sandbox.exec(`pkill -f '${supervisor}/[r]eplays/'`);
};

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

const withoutTime = ({ at: _at, ...event }: RecordedEvent) => event;

/** Reads a follow to its end. */
const readAll = async (
  events: AsyncIterable<RecordedEvent>,
): Promise<RecordedEvent[]> => {
  const seen: RecordedEvent[] = [];
  for await (const event of events) {
    seen.push(event);
  }
  return seen;
};

/** Reads a follow to its end, calling `then` once `count` events are in. */
const readAllThen = async (
  events: AsyncIterable<RecordedEvent>,
  count: number,
  then: () => Promise<void>,
): Promise<RecordedEvent[]> => {
  const seen: RecordedEvent[] = [];
  for await (const event of events) {
    seen.push(event);
    if (seen.length === count) {
      await then();
    }
  }
  return seen;
};

/** The first `count` events of a follow, then stops following. */
const take = async (
  events: AsyncIterable<RecordedEvent>,
  count: number,
): Promise<RecordedEvent[]> => {
  const seen: RecordedEvent[] = [];
  for await (const event of events) {
    seen.push(event);
    if (seen.length === count) {
      break;
    }
  }
  return seen;
};

/** Every events file under the supervisor's sessions directory, concatenated. */
const readAllFiles = async (supervisor: string): Promise<string> => {
  const dir = path.join(supervisor, "sessions");
  const entries = await readdir(dir);
  const names = entries.filter((name) => name.endsWith(".events.jsonl"));
  const texts = await Promise.all(
    names.map(async (name) => readFile(path.join(dir, name), "utf8")),
  );
  return texts.join("\n");
};

describe.skipIf(process.platform === "win32")("follow() (v1)", () => {
  let rootDir = "";
  let provider: FakeSandboxProvider = fakeSandbox();
  let receivers: FinishReportReceiver[] = [];

  const listening = async () => {
    const made = await finishReportReceiver();
    receivers.push(made);
    return made;
  };

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-follow-"));
    provider = fakeSandbox({ rootDir });
  });

  afterEach(async () => {
    await provider.closeAll();
    await Promise.all(receivers.map(async (made) => made.close()));
    receivers = [];
    await rm(rootDir, { recursive: true, force: true });
  });

  it("follows a detached session live from the held handle: every event once, in order, ending at the session's end", async () => {
    const sandbox = await createSandbox({ provider });
    await sandbox.spawnSession({
      name: "implement",
      agent: working,
      prompt: "Go.",
    });
    await sandbox.detach();
    // The held handle's exec is closed after a detach; this one stops the agent.
    const stopper = await reattach({
      provider: fakeSandbox({ rootDir }),
      sandboxId: sandbox.sandboxId,
    });

    // Every event arrives while the agent is still running; then it's ended.
    const seen = await readAllThen(
      sandbox.follow({ session: "implement" }),
      EXPECTED.length,
      async () =>
        endAgents(stopper, supervisorDir(provider, sandbox.sandboxId)),
    );

    expect(seen.map((event) => withoutTime(event))).toStrictEqual(EXPECTED);
    expect(seen.every((event) => !Number.isNaN(Date.parse(event.at)))).toBe(
      true,
    );
  }, 30_000);

  it("follows from a fresh reattach, live and after the supervisor has exited, and picks up where an earlier follow stopped", async () => {
    const hook = await listening();
    const sandbox = await createSandbox({ provider });
    await sandbox.spawnSession({
      name: "implement",
      agent: working,
      prompt: "Go.",
    });
    await sandbox.detach({ finishReport: { url: hook.url, secret: SECRET } });
    const watching = await reattach({
      provider: fakeSandbox({ rootDir }),
      sandboxId: sandbox.sandboxId,
    });

    // A watcher that drops after two events...
    const first = await take(watching.follow(), 2);
    // ...comes back for the rest, live.
    const rest = await readAllThen(
      watching.follow({ from: 2 }),
      EXPECTED.length - 2,
      async () =>
        endAgents(watching, supervisorDir(provider, sandbox.sandboxId)),
    );
    expect(
      [...first, ...rest].map((event) => withoutTime(event)),
    ).toStrictEqual(EXPECTED);

    // Once the report is in the supervisor exits; the events are still there.
    await hook.first();
    const later = await reattach({
      provider: fakeSandbox({ rootDir }),
      sandboxId: sandbox.sandboxId,
    });
    const replayed = await readAll(later.follow({ session: "implement" }));
    expect(replayed).toStrictEqual([...first, ...rest]);
  }, 30_000);

  it("never shows a value the session's record would redact", async () => {
    const token = "tok-follow-very-secret";
    const password = "hunter2-follow";
    const sandbox = await createSandbox({ provider });
    await sandbox.session({
      name: "leaky",
      agent: fakeAgent({
        lines: [
          init("s-leaky"),
          toolUse(`curl -H "Authorization: ${token}" https://example.com`),
          assistant(`The password is "${password}".`),
        ],
      }),
      prompt: "Go.",
      env: { API_TOKEN: token },
      record: {
        onRecord: () => undefined,
        redact: { envVars: ["API_TOKEN"], values: [password] },
      },
    });

    const followed = await readAll(sandbox.follow({ session: "leaky" }));

    expect(followed.map((event) => withoutTime(event))).toStrictEqual([
      {
        type: "toolCall",
        name: "Bash",
        args: 'curl -H "Authorization: [REDACTED]" https://example.com',
      },
      { type: "text", text: 'The password is "[REDACTED]".' },
    ]);
    const files = await readAllFiles(
      supervisorDir(provider, sandbox.sandboxId),
    );
    expect(files).not.toContain(password);
    expect(files).not.toContain(token);
  }, 30_000);

  it("rejects a session it can't pick, a bad from, and a sandbox that has ended", async () => {
    const sandbox = await createSandbox({ provider });
    const done = fakeAgent({ lines: [init("s-done"), assistant("Done.")] });
    await sandbox.session({ name: "one", agent: done, prompt: "Go." });
    await sandbox.session({ name: "two", agent: done, prompt: "Go." });

    await expect(readAll(sandbox.follow())).rejects.toThrow(
      "follow: name the session to follow (sessions: one, two)",
    );
    await expect(readAll(sandbox.follow({ session: "three" }))).rejects.toThrow(
      'follow: no session named "three" (sessions: one, two)',
    );
    await expect(
      readAll(sandbox.follow({ session: "one", from: -1 })),
    ).rejects.toBeInstanceOf(RangeError);

    await sandbox.close();
    await expect(
      readAll(sandbox.follow({ session: "one" })),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  }, 30_000);
});
