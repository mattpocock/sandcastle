import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionRecord } from "@ai-hero/sandcastle/v1";
import { createSandbox, verifyFinishReport } from "@ai-hero/sandcastle/v1";
import type { FakeSandboxProvider } from "@ai-hero/sandcastle/v1/testing";
import { fakeAgent, fakeSandbox } from "@ai-hero/sandcastle/v1/testing";
import type {
  Delivery,
  FinishReportReceiver,
} from "./helpers/finishReportReceiver.js";
import { finishReportReceiver } from "./helpers/finishReportReceiver.js";

// Session records, end to end: the real supervisor bundle in a fake sandbox
// builds each session's record (its native transcript plus its events) when
// the session ends, redacts it, and sends it to the session's sinks: a signed
// webhook and an upload URL (PUT) from inside the sandbox, held or detached,
// and a directory or a function on the host while the handle is held. POSIX
// only, like the other supervisor tests.

const freshSecret = (): string => `whsec_${randomBytes(24).toString("base64")}`;

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

const API_TOKEN = "tok-4f9a-very-secret";
const PASSWORD = "hunter2-literal";

/** A session that leaks both secrets into its transcript and events. */
const leaky = (sessionId: string) =>
  fakeAgent({
    lines: [
      init(sessionId),
      toolUse(`curl -H "Authorization: ${API_TOKEN}" https://example.com`),
      assistant(`The password is ${PASSWORD}.`),
      result("Done."),
    ],
  });

const REDACT = { envVars: ["API_TOKEN"], patterns: [PASSWORD] };

const isRecord = (value: unknown): value is SessionRecord =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  value.type === "sandcastle.session-record";

const parseRecord = (body: string): SessionRecord => {
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed)) {
    throw new Error(`not a session record: ${body.slice(0, 200)}`);
  }
  return parsed;
};

const nativeText = (record: SessionRecord): string =>
  Buffer.from(record.native?.content ?? "", "base64").toString("utf8");

/** Fails the test if a secret survived anywhere in the record. */
const expectRedacted = (record: SessionRecord): void => {
  const everything = `${JSON.stringify(record)}\n${nativeText(record)}`;
  expect(everything).not.toContain(API_TOKEN);
  expect(everything).not.toContain(PASSWORD);
  expect(nativeText(record)).toContain("[REDACTED]");
};

const signatureOf = (secret: string, delivery: Delivery): string => {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const id = delivery.headers["webhook-id"] ?? "";
  const timestamp = delivery.headers["webhook-timestamp"] ?? "";
  const mac = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${delivery.body}`)
    .digest("base64");
  return `v1,${mac}`;
};

/** The one item in a list, failing the test when there isn't exactly one. */
const only = <T>(items: readonly T[]): T => {
  const [item] = items;
  if (items.length !== 1 || item === undefined) {
    throw new Error(`expected exactly one, got ${items.length}`);
  }
  return item;
};

const listRecursive = async (dir: string): Promise<string[]> =>
  readdir(dir, { recursive: true }).catch((): string[] => []);

describe.skipIf(process.platform === "win32")("session records (v1)", () => {
  let rootDir = "";
  let provider: FakeSandboxProvider = fakeSandbox();
  let receivers: FinishReportReceiver[] = [];

  const listening = async () => {
    const made = await finishReportReceiver();
    receivers.push(made);
    return made;
  };

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-records-"));
    provider = fakeSandbox({ rootDir });
  });

  afterEach(async () => {
    await provider.closeAll();
    await Promise.all(receivers.map(async (made) => made.close()));
    receivers = [];
    await rm(rootDir, { recursive: true, force: true });
  });

  it("a detached session's record arrives at a webhook sink and an upload URL, redacted, and the finish report points to it", async () => {
    const [hook, bucket, reports] = await Promise.all([
      listening(),
      listening(),
      listening(),
    ]);
    const recordSecret = freshSecret();
    const reportSecret = freshSecret();
    const sandbox = await createSandbox({
      provider,
      env: { API_TOKEN },
    });
    await sandbox.spawnSession({
      name: "implement",
      agent: fakeAgent({
        lines: [
          init("s-detached"),
          toolUse(`echo ${API_TOKEN}`),
          assistant(`The password is ${PASSWORD}.`),
          result("Done."),
        ],
        hang: true,
      }),
      prompt: "Work.",
      idleTimeoutSeconds: 1,
      record: {
        webhook: { url: hook.url, secret: recordSecret },
        upload: { url: `${bucket.url}/runs/r1.json?X-Amz-Signature=abc` },
        labels: { runId: "r1", task: "implement" },
        redact: REDACT,
      },
    });

    const receipt = await sandbox.detach({
      finishReport: { url: reports.url, secret: reportSecret },
    });

    const [posted, put, finished] = await Promise.all([
      hook.first(),
      bucket.first(),
      reports.first(),
    ]);
    expect(posted.method).toBe("POST");
    expect(posted.headers["webhook-signature"]).toBe(
      signatureOf(recordSecret, posted),
    );
    expect(put.method).toBe("PUT");
    expect(put.url).toBe("/finished/runs/r1.json?X-Amz-Signature=abc");
    const record = parseRecord(put.body);
    expect(parseRecord(posted.body)).toStrictEqual(record);
    expect(posted.headers["webhook-id"]).toBe(record.id);
    expect(record).toMatchObject({
      version: 1,
      sandboxId: sandbox.sandboxId,
      detachId: receipt.detachId,
      name: "implement",
      agent: "claude-code",
      model: "fake",
      sessionId: "s-detached",
      exitReason: "idle-timeout",
      labels: { runId: "r1", task: "implement" },
      eventsVersion: 1,
      native: { format: "claude-code-jsonl", fileName: "s-detached.jsonl" },
    });
    expect(Date.parse(record.endedAt)).toBeGreaterThanOrEqual(
      Date.parse(record.startedAt),
    );
    expect(record.events.map((event) => event.type)).toStrictEqual([
      "toolCall",
      "text",
    ]);
    expectRedacted(record);
    expect(nativeText(record)).toContain('"session_id":"s-detached"');

    const report = await verifyFinishReport({
      body: finished.body,
      headers: finished.headers,
      secret: reportSecret,
    });
    expect(report.data.sessions.implement?.record).toStrictEqual({
      id: record.id,
      webhook: { url: hook.url, status: "delivered" },
      upload: { url: `${bucket.url}/runs/r1.json`, status: "delivered" },
    });
    // The webhook secret and the upload URL's credential crossed sealed.
    const sandboxDir = provider.pathOf(sandbox.sandboxId);
    const files = await listRecursive(sandboxDir);
    const texts = await Promise.all(
      files.map(async (file) =>
        readFile(path.join(sandboxDir, file), "utf8").catch(() => ""),
      ),
    );
    expect(texts.join("\n")).not.toContain(recordSecret.slice("whsec_".length));
    expect(texts.join("\n")).not.toContain("X-Amz-Signature");
  });

  it("a held session's record lands in a directory sink and a function sink, and nothing is written to the host's agent directories", async () => {
    const directory = path.join(rootDir, "records");
    const received: SessionRecord[] = [];
    const hostProjects = path.join(homedir(), ".claude", "projects");
    const before = await listRecursive(hostProjects);
    const sandbox = await createSandbox({ provider, env: { API_TOKEN } });

    const done = await sandbox.session({
      name: "plan",
      agent: leaky("s-held"),
      prompt: "Plan it.",
      record: {
        directory: { path: directory },
        onRecord: (record) => {
          received.push(record);
        },
        labels: { runId: "r2" },
        redact: REDACT,
      },
    });

    expect(done.finalMessage).toBe("Done.");
    const record = only(received);
    expect(record).toMatchObject({
      sandboxId: sandbox.sandboxId,
      name: "plan",
      sessionId: "s-held",
      exitReason: "completed",
      labels: { runId: "r2" },
    });
    expect(record).not.toHaveProperty("detachId");
    expectRedacted(record);
    const saved = path.join(directory, sandbox.sandboxId);
    await expect(readdir(saved)).resolves.toStrictEqual(
      expect.arrayContaining(["plan.json", "plan.jsonl"]),
    );
    expect(
      parseRecord(await readFile(path.join(saved, "plan.json"), "utf8")),
    ).toStrictEqual(record);
    await expect(
      readFile(path.join(saved, "plan.jsonl"), "utf8"),
    ).resolves.toBe(nativeText(record));
    await expect(listRecursive(hostProjects)).resolves.toStrictEqual(before);
  });

  it("a held session sends its record to a webhook sink too, before the session resolves", async () => {
    const hook = await listening();
    const secret = freshSecret();
    const sandbox = await createSandbox({ provider, env: { API_TOKEN } });

    await sandbox.session({
      agent: leaky("s-held-hook"),
      prompt: "Go.",
      record: { webhook: { url: hook.url, secret }, redact: REDACT },
    });

    const posted = only(hook.deliveries);
    expect(posted.headers["webhook-signature"]).toBe(
      signatureOf(secret, posted),
    );
    const record = parseRecord(posted.body);
    expect(record).toMatchObject({ sessionId: "s-held-hook", labels: {} });
    expectRedacted(record);
  });

  it("a function sink that throws fails the session's wait()", async () => {
    const sandbox = await createSandbox({ provider });

    await expect(
      sandbox.session({
        agent: leaky("s-throws"),
        prompt: "Go.",
        record: {
          onRecord: () => {
            throw new Error("sink is down");
          },
        },
      }),
    ).rejects.toThrow("sink is down");
  });

  it("rejects bad sink options before the session starts", async () => {
    const sandbox = await createSandbox({ provider });
    const agent = leaky("s-bad");

    await expect(
      sandbox.session({
        agent,
        prompt: "Go.",
        record: { webhook: { url: "ftp://nope", secret: freshSecret() } },
      }),
    ).rejects.toThrow(/record\.webhook\.url/u);
    await expect(
      sandbox.session({
        agent,
        prompt: "Go.",
        record: { webhook: { url: "http://127.0.0.1/", secret: "not!" } },
      }),
    ).rejects.toThrow(/record\.webhook\.secret/u);
    await expect(
      sandbox.session({
        agent,
        prompt: "Go.",
        record: { upload: { url: "not a url" } },
      }),
    ).rejects.toThrow(/record\.upload\.url/u);
    await expect(
      sandbox.session({
        agent,
        prompt: "Go.",
        record: { directory: { path: "relative/dir" } },
      }),
    ).rejects.toThrow(/record\.directory\.path/u);
  });
});
