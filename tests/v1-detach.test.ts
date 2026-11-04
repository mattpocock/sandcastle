import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  FinishReport,
  OutputMap,
  SucceededDetachedWork,
} from "@ai-hero/sandcastle/v1";
import {
  claudeCode,
  createSandbox,
  DetachError,
  FinishReportVerificationError,
  Output,
  SandboxDetachedError,
  verifyFinishReport,
} from "@ai-hero/sandcastle/v1";
import type { FakeSandboxProvider } from "@ai-hero/sandcastle/v1/testing";
import { fakeAgent, fakeSandbox } from "@ai-hero/sandcastle/v1/testing";
import type { FinishReportReceiver } from "./helpers/finishReportReceiver.js";
import {
  finishReportReceiver,
  hostPath,
  procfsOf,
  supervisorDir,
  supervisorSays,
} from "./helpers/finishReportReceiver.js";

// detach() and the finish report, end to end: the real supervisor bundle in a
// fake sandbox carries the work on after the handle lets go, and POSTs a
// signed finish report to a local HTTP receiver, which checks it with
// verifyFinishReport. The fake sandbox needs `sh` and POSIX process groups,
// and the supervisor bundle comes from the build (the Windows job runs from
// src without one), so these skip on Windows.

const freshSecret = (): string => `whsec_${randomBytes(24).toString("base64")}`;

/** The part of a `whsec_` secret that would show up if it leaked. */
const keyOf = (secret: string): string => secret.slice("whsec_".length);

const init = (sessionId: string): string =>
  JSON.stringify({ type: "system", subtype: "init", session_id: sessionId });

const result = (text: string): string =>
  JSON.stringify({ type: "result", is_error: false, result: text });

const ANSWER = Output.object({
  tag: "answer",
  schema: z.object({ answer: z.number() }),
});

/** A session that prints its answer, then hangs until the completion timeout ends it. */
const answering = (answer: string) =>
  fakeAgent({
    lines: [init("s-detached"), result(`<answer>${answer}</answer>`)],
    hang: true,
  });

/** A session that prints nothing useful and never ends by itself. */
const stuck = (sessionId: string) =>
  fakeAgent({ lines: [init(sessionId)], hang: true });

/** The report's work, which must have succeeded. */
const succeeded = <O extends OutputMap>(
  report: FinishReport<O>,
): SucceededDetachedWork<O> => {
  if (report.data.status !== "succeeded") {
    throw new Error(`the work failed: ${report.data.failure.message}`);
  }
  return report.data;
};

const listRecursive = async (dir: string): Promise<string[]> =>
  readdir(dir, { recursive: true }).catch((): string[] => []);

describe.skipIf(process.platform === "win32")("detach (v1)", () => {
  let rootDir = "";
  let provider: FakeSandboxProvider = fakeSandbox();
  let receivers: FinishReportReceiver[] = [];

  const listening = async (statuses?: readonly number[]) => {
    const made = await finishReportReceiver(statuses);
    receivers.push(made);
    return made;
  };

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-detach-"));
    provider = fakeSandbox({ rootDir });
  });

  afterEach(async () => {
    await provider.closeAll();
    await Promise.all(receivers.map(async (made) => made.close()));
    receivers = [];
    await rm(rootDir, { recursive: true, force: true });
  });

  it("carries a running session on and POSTs a signed finish report that verifyFinishReport accepts", async () => {
    const hook = await listening();
    const secret = freshSecret();
    const sandbox = await createSandbox({ provider });
    await sandbox.spawnSession({
      name: "implement",
      agent: answering('{"answer": 42}'),
      prompt: "Reply in <answer> tags.",
      output: ANSWER,
      completionTimeoutSeconds: 0.5,
    });

    const receipt = await sandbox.detach({
      finishReport: { url: hook.url, secret },
    });

    expect(receipt).toMatchObject({
      sandboxId: sandbox.sandboxId,
      carriedOn: [{ kind: "session", name: "implement", agent: "claude-code" }],
      reportsTo: hook.url,
    });
    expect(receipt.detachId).toMatch(/\S/u);
    expect(receipt.deadline.getTime()).toBeLessThan(sandbox.killTime.getTime());
    const delivery = await hook.first();
    expect(delivery.headers["webhook-id"]).toBe(receipt.detachId);
    const report = await verifyFinishReport({
      body: delivery.body,
      headers: delivery.headers,
      secret,
      outputs: { implement: ANSWER },
    });
    expect(report.type).toBe("sandcastle.detached.finished");
    const work = succeeded(report);
    expect(work).toMatchObject({
      sandboxId: sandbox.sandboxId,
      detachId: receipt.detachId,
      processes: [],
    });
    const answer: number = work.sessions.implement.output.answer;
    expect(answer).toBe(42);
    expect(work.sessions.implement).toMatchObject({
      name: "implement",
      agent: "claude-code",
      sessionId: "s-detached",
      exitReason: "closing-tag",
      finalMessage: '<answer>{"answer": 42}</answer>',
    });
    // The report is also written to a file in the sandbox.
    const reportFile = path.join(
      supervisorDir(provider, sandbox.sandboxId),
      "reports",
      `${receipt.detachId}.json`,
    );
    await expect(readFile(reportFile, "utf8")).resolves.toBe(delivery.body);
  });

  it("after detach every handle call rejects with SandboxDetachedError, close() does nothing, and the work carries on", async () => {
    const hook = await listening();
    const sandbox = await createSandbox({ provider });
    const spawned = await sandbox.spawnSession({
      name: "implement",
      agent: answering('{"answer": 1}'),
      prompt: "Reply in <answer> tags.",
      output: ANSWER,
      completionTimeoutSeconds: 1,
    });

    const receipt = await sandbox.detach({
      finishReport: { url: hook.url, secret: freshSecret() },
    });
    await sandbox.close();

    const detached = {
      _tag: "SandboxDetachedError",
      sandboxId: sandbox.sandboxId,
      detachId: receipt.detachId,
    };
    await expect(sandbox.exec("true")).rejects.toBeInstanceOf(
      SandboxDetachedError,
    );
    await expect(sandbox.readTextFile({ path: "x" })).rejects.toMatchObject(
      detached,
    );
    await expect(
      sandbox.writeTextFile({ path: "x", content: "" }),
    ).rejects.toMatchObject(detached);
    await expect(
      sandbox.session({ agent: answering("{}"), prompt: "x" }),
    ).rejects.toMatchObject(detached);
    await expect(
      sandbox.spawnSession({ agent: answering("{}"), prompt: "x" }),
    ).rejects.toMatchObject(detached);
    await expect(sandbox.detach()).rejects.toMatchObject(detached);
    await expect(spawned.wait()).rejects.toMatchObject(detached);
    await expect(spawned.kill()).rejects.toMatchObject(detached);
    // close() left the sandbox and its session alone: the report still comes.
    const delivery = await hook.first();
    expect(JSON.parse(delivery.body)).toMatchObject({
      data: {
        status: "succeeded",
        sessions: { implement: { output: { answer: 1 } } },
      },
    });
  });

  it("rejects with DetachError when nothing is running or an awaited call is pending", async () => {
    const sandbox = await createSandbox({ provider });

    await expect(sandbox.detach()).rejects.toBeInstanceOf(DetachError);
    await expect(sandbox.detach()).rejects.toMatchObject({
      reason: "nothing-running",
    });

    await sandbox.spawnSession({ agent: stuck("s-held"), prompt: "Work." });
    const pending = sandbox.exec("sleep 0.5");
    await expect(sandbox.detach()).rejects.toMatchObject({
      _tag: "DetachError",
      reason: "awaited-call-pending",
    });
    await pending;
    // Still held: the handle works.
    await expect(sandbox.exec("echo held")).resolves.toMatchObject({
      stdout: "held\n",
    });
  });

  it("retries a 5xx with backoff and stops on 410", async () => {
    const flaky = await listening([500, 503]);
    const gone = await listening([410]);
    const detachedTo = async (url: string) => {
      const sandbox = await createSandbox({ provider });
      await sandbox.spawnSession({
        agent: answering('{"answer": 1}'),
        prompt: "Reply in <answer> tags.",
        output: ANSWER,
        completionTimeoutSeconds: 0.5,
      });
      const receipt = await sandbox.detach({
        finishReport: { url, secret: freshSecret() },
      });
      return { sandboxId: sandbox.sandboxId, detachId: receipt.detachId };
    };

    const toFlaky = await detachedTo(flaky.url);
    const toGone = await detachedTo(gone.url);

    await supervisorSays(provider, toFlaky.sandboxId, "delivered");
    await supervisorSays(provider, toGone.sandboxId, "gone");
    expect(
      flaky.deliveries.map((delivery) => delivery.headers["webhook-id"]),
    ).toStrictEqual([toFlaky.detachId, toFlaky.detachId, toFlaky.detachId]);
    expect(gone.deliveries).toHaveLength(1);
  });

  it("verifyFinishReport rejects a tampered body, a stale timestamp and output that fails its schema", async () => {
    const hook = await listening();
    const secret = freshSecret();
    const sandbox = await createSandbox({ provider });
    await sandbox.spawnSession({
      name: "implement",
      agent: answering('{"answer": 42}'),
      prompt: "Reply in <answer> tags.",
      output: ANSWER,
      completionTimeoutSeconds: 1,
    });
    const { detachId } = await sandbox.detach({
      finishReport: { url: hook.url, secret },
    });
    const { body, headers } = await hook.first();

    await expect(
      verifyFinishReport({ body: body.replace("42", "43"), headers, secret }),
    ).rejects.toMatchObject({
      _tag: "FinishReportVerificationError",
      reason: "bad-signature",
    });
    await expect(
      verifyFinishReport({ body, headers, secret: freshSecret() }),
    ).rejects.toMatchObject({ reason: "bad-signature" });
    // Signed correctly, an hour ago.
    const hourAgo = String(Math.floor(Date.now() / 1000) - 3600);
    const stale = createHmac("sha256", Buffer.from(keyOf(secret), "base64"))
      .update(`${detachId}.${hourAgo}.${body}`)
      .digest("base64");
    await expect(
      verifyFinishReport({
        body,
        headers: {
          ...headers,
          "webhook-timestamp": hourAgo,
          "webhook-signature": `v1,${stale}`,
        },
        secret,
      }),
    ).rejects.toMatchObject({ reason: "stale-timestamp" });
    await expect(
      verifyFinishReport({ body, headers: { "webhook-id": detachId }, secret }),
    ).rejects.toBeInstanceOf(FinishReportVerificationError);
    await expect(
      verifyFinishReport({
        body,
        headers,
        secret,
        outputs: {
          implement: Output.object({
            tag: "answer",
            schema: z.object({ answer: z.string() }),
          }),
        },
      }),
    ).rejects.toMatchObject({ reason: "output-invalid" });
    // A Headers object works as well as a plain record.
    await expect(
      verifyFinishReport({ body, headers: new Headers(headers), secret }),
    ).resolves.toMatchObject({ data: { status: "succeeded" } });
  });

  it("the default deadline fires before the kill time and reports time-limit", async () => {
    const hook = await listening();
    const secret = freshSecret();
    // 6 seconds: the default margin shrinks to a quarter of that.
    const sandbox = await createSandbox({ provider, timeLimitMinutes: 0.1 });
    await sandbox.spawnSession({
      name: "stuck",
      agent: stuck("s-stuck"),
      prompt: "Work.",
    });

    const receipt = await sandbox.detach({
      finishReport: { url: hook.url, secret },
    });

    expect(receipt.deadline.getTime()).toBe(sandbox.killTime.getTime() - 1500);
    const { body, headers } = await hook.first();
    expect(Date.now()).toBeLessThan(sandbox.killTime.getTime());
    const report = await verifyFinishReport({ body, headers, secret });
    expect(report.data).toMatchObject({
      status: "failed",
      failure: { reason: "time-limit", name: "stuck" },
      sessions: { stuck: { exitReason: "time-limit", sessionId: "s-stuck" } },
    });
  });

  it("deadlineMinutes sets an earlier deadline, clamped to the default", async () => {
    const hook = await listening();
    const sandbox = await createSandbox({ provider });
    await sandbox.spawnSession({ agent: stuck("s-quick"), prompt: "Work." });
    const clamped = await createSandbox({ provider });
    await clamped.spawnSession({ agent: stuck("s-long"), prompt: "Work." });

    const before = Date.now();
    const receipt = await sandbox.detach({
      finishReport: { url: hook.url, secret: freshSecret() },
      deadlineMinutes: 0.02,
    });
    const late = await clamped.detach({ deadlineMinutes: 24 * 60 });

    expect(receipt.deadline.getTime()).toBeGreaterThanOrEqual(before + 1200);
    expect(receipt.deadline.getTime()).toBeLessThan(before + 5000);
    expect(late.deadline.getTime()).toBe(
      clamped.killTime.getTime() - 5 * 60_000,
    );
    const delivery = await hook.first();
    expect(JSON.parse(delivery.body)).toMatchObject({
      data: { status: "failed", failure: { reason: "time-limit" } },
    });
  });

  it("detach() with no destination is fire-and-forget: the report is only written to a file", async () => {
    const sandbox = await createSandbox({ provider });
    await sandbox.spawnSession({
      agent: answering('{"answer": 1}'),
      prompt: "Reply in <answer> tags.",
      output: ANSWER,
      completionTimeoutSeconds: 1,
    });

    const receipt = await sandbox.detach();

    expect(receipt.reportsTo).toBe(false);
    await supervisorSays(provider, sandbox.sandboxId, "written");
    const reportFile = path.join(
      supervisorDir(provider, sandbox.sandboxId),
      "reports",
      `${receipt.detachId}.json`,
    );
    const report: unknown = JSON.parse(await readFile(reportFile, "utf8"));
    expect(report).toMatchObject({
      type: "sandcastle.detached.finished",
      data: { detachId: receipt.detachId, status: "succeeded" },
    });
  });

  it("the secret never reaches a session's env, a log or a file", async () => {
    const hook = await listening();
    const secret = freshSecret();
    const sandbox = await createSandbox({ provider });
    const sandboxDir = provider.pathOf(sandbox.sandboxId);
    // A stand-in `claude` that waits for a go-ahead, then records its env.
    await sandbox.writeTextFile({
      path: "bin/claude",
      content: [
        "#!/bin/sh",
        "cat > /dev/null",
        `echo '${init("s-env")}'`,
        'while [ ! -f "$HOME/go" ]; do sleep 0.05; done',
        'env > "$HOME/session-env.txt"',
        `echo '${result("done")}'`,
      ].join("\n"),
    });
    await sandbox.exec("chmod +x bin/claude");
    await sandbox.spawnSession({
      agent: claudeCode("claude-opus-4-8"),
      prompt: "Record your env.",
      env: { PATH: `${sandbox.workingDirectory}/bin:${hostPath()}` },
    });

    await sandbox.detach({ finishReport: { url: hook.url, secret } });
    await writeFile(path.join(sandboxDir, "home", "go"), "");

    const delivery = await hook.first();
    expect(delivery.body).toContain('"status":"succeeded"');
    await supervisorSays(provider, sandbox.sandboxId, "delivered");
    const sessionEnv = await readFile(
      path.join(sandboxDir, "home", "session-env.txt"),
      "utf8",
    );
    expect(sessionEnv).toContain("HOME=");
    const files = await listRecursive(sandboxDir);
    const texts = await Promise.all(
      files.map(async (file) =>
        readFile(path.join(sandboxDir, file), "utf8").catch(() => ""),
      ),
    );
    expect(texts.join("\n")).not.toContain(keyOf(secret));
  });

  it.runIf(process.platform === "linux")(
    "the secret never reaches the supervisor's env or argv",
    async () => {
      const hook = await listening();
      const secret = freshSecret();
      const sandbox = await createSandbox({ provider });
      await sandbox.spawnSession({ agent: stuck("s-proc"), prompt: "Work." });

      await sandbox.detach({ finishReport: { url: hook.url, secret } });

      const exposed = await procfsOf(
        supervisorDir(provider, sandbox.sandboxId),
      );
      expect(exposed).not.toHaveLength(0);
      expect(exposed.join("\n")).not.toContain(keyOf(secret));
    },
  );
});
