import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DetachableSandbox, DetachReceipt } from "@ai-hero/sandcastle/v1";
import {
  claudeCode,
  createSandbox,
  Output,
  reattachSandbox,
  verifyFinishReport,
} from "@ai-hero/sandcastle/v1";
import type { FakeSandboxProvider } from "@ai-hero/sandcastle/v1/testing";
import { fakeAgent, fakeSandbox } from "@ai-hero/sandcastle/v1/testing";
import type {
  Delivery,
  FinishReportReceiver,
} from "./helpers/finishReportReceiver.js";
import {
  finishReportReceiver,
  hostPath,
  procfsOf,
  supervisorDir,
} from "./helpers/finishReportReceiver.js";

// A sandbox used again after its detached work has been reported: the
// supervisor exits once its report is out, and a reattached handle starts a
// new one in the same sandbox on first use. The real supervisor bundle in a
// fake sandbox, reattached from a fresh fakeSandbox() on the same root, as a
// remote orchestrator would between steps. POSIX only.

const SECRET = "whsec_c2FuZGNhc3RsZS1yZXVzZS1hZnRlci1kZXRhY2g=";

const init = (sessionId: string): string =>
  JSON.stringify({ type: "system", subtype: "init", session_id: sessionId });

const result = (text: string): string =>
  JSON.stringify({ type: "result", is_error: false, result: text });

const answer = Output.string({ tag: "answer" });

/** A session that answers, then hangs until its agent is stopped. */
const hanging = fakeAgent({
  lines: [init("s-hanging"), result("<answer>never</answer>")],
  hang: true,
});

/** Reattaches from a fresh provider, failing the test when the supervisor isn't there. */
const reattach = async (
  rootDir: string,
  sandboxId: string,
): Promise<DetachableSandbox> => {
  const handle = await reattachSandbox({
    provider: fakeSandbox({ rootDir }),
    sandboxId,
  });
  if (handle === undefined) {
    throw new Error("the supervisor should be there");
  }
  return handle;
};

const verified = async (delivery: Delivery | undefined) => {
  if (delivery === undefined) {
    throw new Error("no finish report arrived");
  }
  return verifyFinishReport({
    body: delivery.body,
    headers: delivery.headers,
    secret: SECRET,
    outputs: { step: answer },
  });
};

/** Whether every process working in `dir` ends within about 10 seconds (Linux /proc). */
const processesGone = async (
  dir: string,
  triesLeft = 200,
): Promise<boolean> => {
  const found = await procfsOf(dir);
  if (found.length === 0) {
    return true;
  }
  if (triesLeft === 0) {
    return false;
  }
  await delay(50);
  return processesGone(dir, triesLeft - 1);
};

/**
 * A finish-report receiver that holds its answer to the first report until
 * `release()`, so the supervisor that sent it is still delivering.
 */
const heldReceiver = async () => {
  const bodies: string[] = [];
  const arrivals = new EventTarget();
  const released = new EventTarget();
  let held = true;
  const answerOnRelease = (response: ServerResponse): void => {
    const respond = (): void => {
      response.writeHead(200).end();
    };
    if (held) {
      released.addEventListener("release", respond, { once: true });
    } else {
      respond();
    }
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      arrivals.dispatchEvent(new Event("report"));
      answerOnRelease(response);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  const received = async (count: number): Promise<string[]> => {
    if (bodies.length >= count) {
      return bodies;
    }
    await once(arrivals, "report");
    return received(count);
  };
  return {
    url: `http://127.0.0.1:${port}/finished`,
    /** Resolves with every report body once `count` have arrived. */
    received,
    /** Answers the held report, and every later one at once. */
    release: (): void => {
      held = false;
      released.dispatchEvent(new Event("release"));
    },
    close: async (): Promise<void> => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
};

describe.skipIf(process.platform === "win32")(
  "reusing a sandbox after its finish report (v1)",
  { timeout: 30_000 },
  () => {
    let rootDir = "";
    let provider: FakeSandboxProvider = fakeSandbox();
    let receivers: FinishReportReceiver[] = [];
    let closers: (() => Promise<void>)[] = [];

    const listening = async () => {
      const made = await finishReportReceiver();
      receivers.push(made);
      return made;
    };

    beforeEach(async () => {
      rootDir = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-reuse-"));
      provider = fakeSandbox({ rootDir });
    });

    afterEach(async () => {
      await Promise.all(closers.map(async (close) => close()));
      closers = [];
      await provider.closeAll();
      await Promise.all(receivers.map(async (made) => made.close()));
      receivers = [];
      await rm(rootDir, { recursive: true, force: true });
    });

    /** What the supervisor's status file says about it right now. */
    const supervisorState = async (sandboxId: string): Promise<unknown> => {
      const file = path.join(supervisorDir(provider, sandboxId), "status.json");
      const parsed: unknown = JSON.parse(
        await readFile(file, "utf8").catch(() => "{}"),
      );
      return typeof parsed === "object" &&
        parsed !== null &&
        "supervisor" in parsed
        ? parsed.supervisor
        : undefined;
    };

    /** Resolves once the supervisor has exited, or fails after about 10 seconds. */
    const supervisorExited = async (
      sandboxId: string,
      triesLeft = 200,
    ): Promise<void> => {
      if ((await supervisorState(sandboxId)) === "exited") {
        return;
      }
      if (triesLeft === 0) {
        throw new Error("the supervisor never exited");
      }
      await delay(50);
      await supervisorExited(sandboxId, triesLeft - 1);
    };

    /** Spawns a step whose agent answers once `go()` is called, and detaches. */
    const runStep = async (
      sandbox: DetachableSandbox,
      url: string,
      reply: string,
    ): Promise<{ receipt: DetachReceipt; go: () => Promise<void> }> => {
      const signal = `go-${reply}`;
      const bin = `bin-${reply}`;
      await sandbox.writeTextFile({
        path: `${bin}/claude`,
        content: [
          "#!/bin/sh",
          // The prompt: the first stream-json message on stdin.
          "IFS= read -r _prompt",
          `printf '%s\\n' '${init(`s-${reply}`)}'`,
          `while [ ! -f "$HOME/${signal}" ]; do sleep 0.05; done`,
          `printf '%s\\n' '${result(`<answer>${reply}</answer>`)}'`,
          "exec sleep 3600",
        ].join("\n"),
      });
      await sandbox.exec(`chmod +x ${bin}/claude`);
      await sandbox.spawnSession({
        name: "step",
        agent: claudeCode("claude-opus-4-8"),
        env: { PATH: `${sandbox.workingDirectory}/${bin}:${hostPath()}` },
        prompt: "Reply in <answer> tags.",
        output: answer,
        completionTimeoutSeconds: 0.5,
      });
      const receipt = await sandbox.detach({
        finishReport: { url, secret: SECRET },
      });
      const home = path.join(provider.pathOf(sandbox.sandboxId), "home");
      return {
        receipt,
        go: async () => writeFile(path.join(home, signal), ""),
      };
    };

    /** Runs one step to its delivered report, and waits for the supervisor to exit. */
    const reportedStep = async (
      sandbox: DetachableSandbox,
      hook: FinishReportReceiver,
      reply: string,
    ): Promise<DetachReceipt> => {
      const step = await runStep(sandbox, hook.url, reply);
      const before = hook.deliveries.length;
      await step.go();
      await hook.received(before + 1);
      await supervisorExited(sandbox.sandboxId);
      return step.receipt;
    };

    it("a reattached handle restarts the supervisor: a second step detaches and reports with its own detach id", async () => {
      const hook = await listening();
      const sandbox = await createSandbox({ provider });
      const first = await reportedStep(sandbox, hook, "one");

      const again = await reattach(rootDir, sandbox.sandboxId);
      const second = await reportedStep(again, hook, "two");
      const [one, two] = hook.deliveries;

      expect(second.detachId).not.toBe(first.detachId);
      expect(second.deadline.getTime()).toBeLessThan(
        sandbox.killTime.getTime(),
      );
      await expect(verified(one)).resolves.toMatchObject({
        data: {
          detachId: first.detachId,
          status: "succeeded",
          sessions: { step: { output: "one" } },
        },
      });
      await expect(verified(two)).resolves.toMatchObject({
        data: {
          detachId: second.detachId,
          status: "succeeded",
          sessions: { step: { output: "two" } },
        },
      });
    });

    it("a reattach that reaches the supervisor while it's still reporting starts the next step once it has exited", async () => {
      const hook = await heldReceiver();
      closers.push(hook.close);
      const sandbox = await createSandbox({ provider });
      const first = await runStep(sandbox, hook.url, "one");
      await first.go();
      await hook.received(1);

      const again = await reattach(rootDir, sandbox.sandboxId);
      const next = runStep(again, hook.url, "two");
      // The supervisor is still delivering (and running) while the next
      // step starts; it exits once the report is answered.
      await delay(1500);
      hook.release();
      const second = await next;
      await second.go();
      const [, two] = await hook.received(2);

      expect(two).toContain(second.receipt.detachId);
      expect(two).toContain('"status":"succeeded"');
    });

    it.runIf(process.platform === "linux")(
      "no supervisor runs between a step's report and the next reattach's first session",
      async () => {
        const hook = await listening();
        const sandbox = await createSandbox({ provider });
        await reportedStep(sandbox, hook, "one");
        const dir = supervisorDir(provider, sandbox.sandboxId);
        // It writes `exited` just before its process ends.
        const gone = await processesGone(dir);

        const again = await reattach(rootDir, sandbox.sandboxId);
        await again.status();
        const idle = await procfsOf(dir);
        await runStep(again, hook.url, "two");
        const restarted = await procfsOf(dir);

        expect(gone).toBe(true);
        expect(idle).toHaveLength(0);
        expect(restarted).not.toHaveLength(0);
      },
    );

    it("status() keeps every detach's report and every ended session across the restart", async () => {
      const hook = await listening();
      const sandbox = await createSandbox({ provider });
      const first = await reportedStep(sandbox, hook, "one");
      const again = await reattach(rootDir, sandbox.sandboxId);
      const second = await reportedStep(again, hook, "two");

      const later = await reattach(rootDir, sandbox.sandboxId);
      const status = await later.status();

      expect(status.detached?.detachId).toBe(second.detachId);
      expect(status.detaches).toMatchObject([
        {
          detachId: first.detachId,
          delivery: "delivered",
          finishReport: { data: { detachId: first.detachId } },
        },
        {
          detachId: second.detachId,
          delivery: "delivered",
          finishReport: { data: { detachId: second.detachId } },
        },
      ]);
      expect(status.ended).toMatchObject([
        { name: "step", exitReason: "closing-tag" },
        { name: "step", exitReason: "closing-tag" },
      ]);
    });

    it("spawnSession on a reattached handle still rejects while a detach's work runs", async () => {
      const sandbox = await createSandbox({ provider });
      await sandbox.spawnSession({
        name: "step",
        agent: hanging,
        prompt: "Work.",
        completionTimeoutSeconds: 600,
      });
      await sandbox.detach();

      const again = await reattach(rootDir, sandbox.sandboxId);

      await expect(
        again.spawnSession({ name: "next", agent: hanging, prompt: "Work." }),
      ).rejects.toThrow(/detached/u);
      await expect(again.status()).resolves.toMatchObject({
        running: [{ name: "step" }],
      });
    });
  },
);
