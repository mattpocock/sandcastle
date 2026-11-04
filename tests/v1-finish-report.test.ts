import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  FailedDetachedWork,
  FinishReport,
  OutputMap,
} from "@ai-hero/sandcastle/v1";
import {
  claudeCode,
  createSandbox,
  Output,
  verifyFinishReport,
} from "@ai-hero/sandcastle/v1";
import type { FakeSandboxProvider } from "@ai-hero/sandcastle/v1/testing";
import { fakeSandbox } from "@ai-hero/sandcastle/v1/testing";
import type { FinishReportReceiver } from "./helpers/finishReportReceiver.js";
import {
  finishReportReceiver,
  hostPath,
} from "./helpers/finishReportReceiver.js";

// A finish report for detached work where one session failed: the sessions
// that ended well still hand back their outputs, validated and typed. The
// real supervisor bundle runs in a fake sandbox, so these skip on Windows.
//
// Both sessions are still running at detach(): a stand-in `claude` waits for
// a file before it answers (or fails), so nothing depends on timing.

const init = (sessionId: string): string =>
  JSON.stringify({ type: "system", subtype: "init", session_id: sessionId });

const result = (text: string): string =>
  JSON.stringify({ type: "result", is_error: false, result: text });

const ANSWER = Output.object({
  tag: "answer",
  schema: z.object({ answer: z.number() }),
});

/** The report's work, which must have failed. */
const failed = <O extends OutputMap>(
  report: FinishReport<O>,
): FailedDetachedWork<O> => {
  if (report.data.status !== "failed") {
    throw new Error("the work succeeded");
  }
  return report.data;
};

describe.skipIf(process.platform === "win32")(
  "a failed finish report (v1)",
  { timeout: 30_000 },
  () => {
    let rootDir = "";
    let provider: FakeSandboxProvider = fakeSandbox();
    let receivers: FinishReportReceiver[] = [];

    beforeEach(async () => {
      rootDir = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-failed-"));
      provider = fakeSandbox({ rootDir });
    });

    afterEach(async () => {
      await provider.closeAll();
      await Promise.all(receivers.map(async (made) => made.close()));
      receivers = [];
      await rm(rootDir, { recursive: true, force: true });
    });

    it("keeps the typed output of the session that succeeded", async () => {
      const hook = await finishReportReceiver();
      receivers.push(hook);
      const secret = `whsec_${randomBytes(24).toString("base64")}`;
      const sandbox = await createSandbox({ provider });
      // Prompts with "BREAK" in them fail; the rest answer 42.
      await sandbox.writeTextFile({
        path: "bin/claude",
        content: [
          "#!/bin/sh",
          'prompt="$(cat)"',
          `printf '%s\\n' '${init("s-held")}'`,
          'while [ ! -f "$HOME/go" ]; do sleep 0.05; done',
          'case "$prompt" in *BREAK*) exit 1 ;; esac',
          `printf '%s\\n' '${result('<answer>{"answer": 42}</answer>')}'`,
          "exec sleep 3600",
        ].join("\n"),
      });
      await sandbox.exec("chmod +x bin/claude");
      const agent = claudeCode("claude-opus-4-8");
      const env = { PATH: `${sandbox.workingDirectory}/bin:${hostPath()}` };
      await sandbox.spawnSession({
        name: "answers",
        agent,
        env,
        prompt: "Answer in <answer>.",
        output: ANSWER,
        completionTimeoutSeconds: 0.5,
      });
      await sandbox.spawnSession({
        name: "breaks",
        agent,
        env,
        prompt: "BREAK, then answer in <answer>.",
        output: ANSWER,
      });

      await sandbox.detach({ finishReport: { url: hook.url, secret } });
      await writeFile(
        path.join(provider.pathOf(sandbox.sandboxId), "home", "go"),
        "",
      );
      const delivery = await hook.first();
      const report = await verifyFinishReport({
        body: delivery.body,
        headers: delivery.headers,
        secret,
        outputs: { answers: ANSWER, breaks: ANSWER },
      });

      const work = failed(report);
      expect(work.failure).toMatchObject({
        reason: "session-failed",
        name: "breaks",
      });
      const answer: number | undefined = work.sessions.answers?.output?.answer;
      expect(answer).toBe(42);
      expect(work.sessions.breaks?.output).toBeUndefined();
    });
  },
);
