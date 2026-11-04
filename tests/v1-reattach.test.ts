import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DetachableSandbox, SandboxStatus } from "@ai-hero/sandcastle/v1";
import {
  createSandbox,
  Output,
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

// reattachSandbox() and status(), end to end: the real supervisor bundle in a
// fake sandbox, reattached by id from a fresh fakeSandbox() on the same root,
// as a remote orchestrator would after its function has returned. POSIX only,
// and the bundle comes from the build, so these skip on Windows.

const init = (sessionId: string): string =>
  JSON.stringify({ type: "system", subtype: "init", session_id: sessionId });

const result = (text: string): string =>
  JSON.stringify({ type: "result", is_error: false, result: text });

/**
 * A session that answers, then hangs: with a long completion timeout it runs
 * until `endAgents` stops it, so "still running" never depends on timing.
 */
const answering = fakeAgent({
  lines: [init("s-reattach"), result("<answer>done</answer>")],
  hang: true,
});

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

/** Polls `status()` until `done` holds, or fails after about 10 seconds. */
const statusUntil = async (
  sandbox: DetachableSandbox,
  done: (status: SandboxStatus) => boolean,
  triesLeft = 200,
): Promise<SandboxStatus> => {
  const status = await sandbox.status();
  if (done(status)) {
    return status;
  }
  if (triesLeft === 0) {
    throw new Error(`status never got there: ${JSON.stringify(status)}`);
  }
  await delay(50);
  return statusUntil(sandbox, done, triesLeft - 1);
};

describe.skipIf(process.platform === "win32")(
  "reattachSandbox() and status() (v1)",
  () => {
    let rootDir = "";
    let provider: FakeSandboxProvider = fakeSandbox();
    let receivers: FinishReportReceiver[] = [];
    let closers: (() => Promise<void>)[] = [];

    const listening = async (statuses?: readonly number[]) => {
      const made = await finishReportReceiver(statuses);
      receivers.push(made);
      return made;
    };

    beforeEach(async () => {
      rootDir = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-reattach-"));
      provider = fakeSandbox({ rootDir });
    });

    /** A receiver that always answers 503 with `Retry-After: 60`. */
    /** A receiver that always answers 503, asking for a retry after `retryAfter` seconds. */
    const busyReceiver = async (retryAfter = "60") => {
      let attempts = 0;
      const server = createServer((request, response) => {
        attempts += 1;
        request.resume();
        response.writeHead(503, { "retry-after": retryAfter }).end();
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      const port =
        address === null || typeof address === "string" ? 0 : address.port;
      closers.push(async () => {
        server.closeAllConnections();
        server.close();
        await once(server, "close");
      });
      return {
        url: `http://127.0.0.1:${port}/finished`,
        attempts: () => attempts,
      };
    };

    afterEach(async () => {
      await Promise.all(closers.map(async (close) => close()));
      closers = [];
      await provider.closeAll();
      await Promise.all(receivers.map(async (made) => made.close()));
      receivers = [];
      await rm(rootDir, { recursive: true, force: true });
    });

    it("status() shows the running work, deadline and delivery state before and after the finish", async () => {
      const hook = await listening();
      const sandbox = await createSandbox({ provider });
      const held = await sandbox.status();
      expect(held).toMatchObject({
        sandboxId: sandbox.sandboxId,
        killTime: sandbox.killTime,
        running: [],
        ended: [],
      });
      expect(held.detached).toBeUndefined();
      await sandbox.spawnSession({
        name: "implement",
        agent: answering,
        prompt: "Reply in <answer> tags.",
        output: Output.string({ tag: "answer" }),
        completionTimeoutSeconds: 600,
      });
      const receipt = await sandbox.detach({
        finishReport: {
          url: hook.url,
          secret: "whsec_c2FuZGNhc3RsZS1yZWF0dGFjaC10ZXN0",
        },
      });

      const reattached = await reattach({
        provider: fakeSandbox({ rootDir }),
        sandboxId: receipt.sandboxId,
      });
      const before = await reattached.status();
      expect(before).toMatchObject({
        sandboxId: sandbox.sandboxId,
        killTime: sandbox.killTime,
        running: [{ kind: "session", name: "implement", agent: "claude-code" }],
        detached: {
          detachId: receipt.detachId,
          reportsTo: hook.url,
          delivery: "not-finished",
        },
      });
      expect(before.detached?.finishReport).toBeUndefined();
      expect(before.detached?.deadline.getTime()).toBeLessThan(
        sandbox.killTime.getTime(),
      );
      // The sandbox's clock, here the same as the host's.
      expect(before.detached?.deadline.getTime()).toBeCloseTo(
        receipt.deadline.getTime(),
        -4,
      );

      await endAgents(reattached, supervisorDir(provider, sandbox.sandboxId));
      await hook.first();
      const after = await statusUntil(
        reattached,
        (status) => status.detached?.delivery === "delivered",
      );
      expect(after).toMatchObject({
        running: [],
        ended: [
          {
            kind: "session",
            name: "implement",
            agent: "claude-code",
            // Stopped from outside, so it failed: what status() reports.
            exitReason: "failed",
          },
        ],
        detached: {
          detachId: receipt.detachId,
          finishReport: {
            type: "sandcastle.detached.finished",
            data: { detachId: receipt.detachId, status: "failed" },
          },
        },
      });
      expect(after.logs.join("\n")).toContain(
        `finish report ${receipt.detachId}: delivered`,
      );
      await expect(reattached.status({ logLines: 1 })).resolves.toMatchObject({
        logs: [expect.any(String)],
      });
    });

    it("an undelivered finish report is readable through status() from a fresh reattach", async () => {
      // The receiver asks for a retry a minute from now, past the kill time,
      // so delivery gives up after one try, well before the sandbox ends.
      const down = await busyReceiver();
      const sandbox = await createSandbox({ provider, timeLimitMinutes: 1 });
      await sandbox.spawnSession({
        name: "implement",
        agent: answering,
        prompt: "Reply in <answer> tags.",
        output: Output.string({ tag: "answer" }),
        completionTimeoutSeconds: 600,
      });
      const receipt = await sandbox.detach({
        finishReport: {
          url: down.url,
          secret: "whsec_c2FuZGNhc3RsZS1yZWF0dGFjaC10ZXN0",
        },
      });
      const watching = await reattach({
        provider,
        sandboxId: sandbox.sandboxId,
      });
      await endAgents(watching, supervisorDir(provider, sandbox.sandboxId));
      await statusUntil(
        watching,
        (status) => status.detached?.delivery === "gave-up",
      );

      // After the supervisor has exited, a new reattach still reads it.
      const later = await reattach({
        provider: fakeSandbox({ rootDir }),
        sandboxId: sandbox.sandboxId,
      });
      const status = await later.status();
      expect(status.detached).toMatchObject({
        detachId: receipt.detachId,
        delivery: "gave-up",
        finishReport: { data: { detachId: receipt.detachId } },
      });
      expect(down.attempts()).toBe(1);
    });

    it("delivery gives up rather than start an attempt whose timeout could run past the kill time", async () => {
      // A retry in 35 s lands inside the one-minute kill time, but that
      // attempt's own 30 s timeout could not: it is never started.
      const down = await busyReceiver("35");
      const sandbox = await createSandbox({ provider, timeLimitMinutes: 1 });
      await sandbox.spawnSession({
        agent: answering,
        prompt: "Reply in <answer> tags.",
        completionTimeoutSeconds: 600,
      });
      await sandbox.detach({
        finishReport: {
          url: down.url,
          secret: "whsec_c2FuZGNhc3RsZS1yZWF0dGFjaC10ZXN0",
        },
      });
      const watching = await reattach({
        provider,
        sandboxId: sandbox.sandboxId,
      });

      await endAgents(watching, supervisorDir(provider, sandbox.sandboxId));
      await statusUntil(
        watching,
        (status) => status.detached?.delivery === "gave-up",
      );

      expect(down.attempts()).toBe(1);
    });

    it("rejects with SandboxUnavailableError when the sandbox is gone, and resolves undefined when its supervisor is", async () => {
      await expect(
        reattachSandbox({ provider, sandboxId: "fake-never-made" }),
      ).rejects.toBeInstanceOf(SandboxUnavailableError);
      const closed = await createSandbox({ provider });
      await closed.close();
      await expect(
        reattachSandbox({ provider, sandboxId: closed.sandboxId }),
      ).rejects.toMatchObject({
        _tag: "SandboxUnavailableError",
        sandboxId: closed.sandboxId,
      });

      const sandbox = await createSandbox({ provider });
      await rm(supervisorDir(provider, sandbox.sandboxId), {
        recursive: true,
        force: true,
      });
      await expect(
        reattachSandbox({ provider, sandboxId: sandbox.sandboxId }),
      ).resolves.toBeUndefined();
    });

    it("a reattached handle is a full handle: exec with the env passed again, sessions with their records' delivery in status(), and close() ends the sandbox", async () => {
      const hook = await listening();
      const sandbox = await createSandbox({
        provider,
        env: { FROM_CREATE: "created" },
      });
      const reattached = await reattach({
        provider: fakeSandbox({ rootDir }),
        sandboxId: sandbox.sandboxId,
        env: { FROM_REATTACH: "again" },
      });
      expect(reattached).toMatchObject({
        sandboxId: sandbox.sandboxId,
        workingDirectory: sandbox.workingDirectory,
        killTime: sandbox.killTime,
        canDetach: true,
      });
      const { stdout } = await reattached.exec(
        'echo "$FROM_REATTACH $FROM_CREATE"',
      );
      expect(stdout).toBe("again created\n");
      const answered = await reattached.session({
        name: "again",
        agent: fakeAgent({
          lines: [init("s-again"), result("hello")],
        }),
        prompt: "Say hello.",
        record: {
          webhook: {
            url: hook.url,
            secret: "whsec_c2FuZGNhc3RsZS1yZWF0dGFjaC10ZXN0",
          },
        },
      });
      expect(answered.finalMessage).toBe("hello");
      await expect(reattached.status()).resolves.toMatchObject({
        running: [],
        ended: [
          {
            kind: "session",
            name: "again",
            exitReason: "completed",
            record: { webhook: { url: hook.url, status: "delivered" } },
          },
        ],
      });

      await reattached.close();
      await expect(
        reattachSandbox({ provider, sandboxId: sandbox.sandboxId }),
      ).rejects.toBeInstanceOf(SandboxUnavailableError);
    });
  },
);
