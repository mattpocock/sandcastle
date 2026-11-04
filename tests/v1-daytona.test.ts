import { access } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CreateSandboxError,
  createSandbox,
  Output,
  reattachSandbox,
  SandboxUnavailableError,
  verifyFinishReport,
} from "@ai-hero/sandcastle/v1";
import { daytona } from "@ai-hero/sandcastle/v1/sandboxes/daytona";
import type { DaytonaConfig } from "@daytona/sdk";
import { z } from "zod";
import { fakeAgent } from "@ai-hero/sandcastle/v1/testing";
import {
  destroyAllFakeDaytona,
  fakeDaytona,
  orphanFakeDaytona,
  resetFakeDaytona,
} from "./helpers/fakeDaytona.js";
import type { FinishReportReceiver } from "./helpers/finishReportReceiver.js";
import { finishReportReceiver } from "./helpers/finishReportReceiver.js";

// daytona() through its subpath, with `@daytona/sdk` module-mocked by a fake
// whose sandboxes are host directories running real `sh` processes, so
// createSandbox starts the real session supervisor in them. The supervisor
// bundle comes from the build and the fake needs POSIX process groups, so
// these skip on Windows.

vi.mock(import("@daytona/sdk"), async (importOriginal) => {
  const actual = await importOriginal();
  const { fakeDaytonaClient } = await import("./helpers/fakeDaytona.js");
  // The real client class, built against a dead endpoint (so it never needs
  // a real key), with the calls daytona() makes swapped for the fake's. The
  // config daytona() passed is recorded instead.
  class Daytona extends actual.Daytona {
    constructor(config?: DaytonaConfig) {
      super({ apiKey: "unused", apiUrl: "http://127.0.0.1:9", target: "x" });
      Object.assign(this, fakeDaytonaClient(config));
    }
  }
  return { Daytona };
});

const ANSWER = Output.object({
  tag: "answer",
  schema: z.object({ answer: z.number() }),
});

const lastCreate = (): Record<string, unknown> => {
  const params = fakeDaytona.createCalls.at(-1);
  if (params === undefined) {
    throw new Error("Daytona's create was not called");
  }
  return params;
};

const exists = async (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

describe.skipIf(process.platform === "win32")("daytona() (v1)", () => {
  let receivers: FinishReportReceiver[] = [];

  beforeEach(async () => {
    await resetFakeDaytona();
  });

  afterEach(async () => {
    await destroyAllFakeDaytona();
    await Promise.all(receivers.map(async (made) => made.close()));
    receivers = [];
  });

  it("passes `create` through to Daytona's create, with auto-stop and auto-pause off and a TTL of the time limit", async () => {
    const provider = daytona({
      apiKey: "dtn-key",
      apiUrl: "https://daytona.example",
      target: "eu",
      create: {
        snapshot: "factory-runner",
        labels: { run: "r-1" },
        networkBlockAll: false,
      },
    });

    await using sandbox = await createSandbox({
      provider,
      timeLimitMinutes: 90,
    });

    expect(sandbox.canDetach).toBe(true);
    expect(fakeDaytona.clientConfigs).toStrictEqual([
      { apiKey: "dtn-key", apiUrl: "https://daytona.example", target: "eu" },
    ]);
    expect(lastCreate()).toStrictEqual({
      snapshot: "factory-runner",
      labels: { run: "r-1" },
      networkBlockAll: false,
      autoStopInterval: 0,
      autoPauseInterval: 0,
      ttlMinutes: 90,
    });
  });

  it("passes an image create through to Daytona's create, rounding a fractional time limit up to whole TTL minutes", async () => {
    await using _sandbox = await createSandbox({
      provider: daytona({
        create: { image: "node:22", resources: { cpu: 2 } },
      }),
      timeLimitMinutes: 0.5,
    });

    expect(lastCreate()).toStrictEqual({
      image: "node:22",
      resources: { cpu: 2 },
      autoStopInterval: 0,
      autoPauseInterval: 0,
      ttlMinutes: 1,
    });
  });

  it("reads the kill time back from the sandbox Daytona made", async () => {
    fakeDaytona.autoDestroyAt = "2031-02-03T04:05:06.000Z";

    await using sandbox = await createSandbox({ provider: daytona() });

    expect(sandbox.killTime.toISOString()).toBe("2031-02-03T04:05:06.000Z");
  });

  it("keeps the fields Sandcastle sets out of `create`", () => {
    // Types only: nothing is created.
    const typed = () => [
      // @ts-expect-error Sandcastle turns auto-stop off itself
      daytona({ create: { snapshot: "s", autoStopInterval: 15 } }),
      // @ts-expect-error env goes to createSandbox, then to each command
      daytona({ create: { snapshot: "s", envVars: { A: "1" } } }),
      // @ts-expect-error the TTL comes from timeLimitMinutes
      daytona({ create: { image: "node:22", ttlMinutes: 5 } }),
      // @ts-expect-error auto-pause would stop a detached run too
      daytona({ create: { autoPauseInterval: 60 } }),
    ];

    expect(typed).toBeTypeOf("function");
  });

  it("gives a command its env through a file it removes, never through Daytona's create or the command line", async () => {
    const secret = "tok-6b1f0c2e9a";
    await using sandbox = await createSandbox({
      provider: daytona(),
      env: { SANDBOX_TOKEN: secret },
    });

    const result = await sandbox.exec({
      command: 'printf "%s|%s" "$SANDBOX_TOKEN" "$ONE_OFF"',
      env: { ONE_OFF: "it's here" },
    });

    expect(result.stdout).toBe(`${secret}|it's here`);
    expect(lastCreate()).not.toHaveProperty("envVars");
    expect(
      fakeDaytona.commands.filter(({ command }) => command.includes(secret)),
    ).toStrictEqual([]);
    const envFiles = fakeDaytona.uploads.filter(({ content }) =>
      content.includes("ONE_OFF"),
    );
    // Removed as the command started.
    await expect(
      Promise.all(envFiles.map(async (file) => exists(file.path))),
    ).resolves.toStrictEqual([false]);
  });

  it("writes a command's env file where only the sandbox user can read it", async () => {
    await using sandbox = await createSandbox({
      provider: daytona(),
      env: { SANDBOX_TOKEN: "tok-mode" },
    });

    await sandbox.exec("true");

    const envFiles = fakeDaytona.uploads
      .filter(({ content }) => content.includes("SANDBOX_TOKEN"))
      .map((upload) => upload.path);
    expect(envFiles).not.toHaveLength(0);
    expect(fakeDaytona.folders).toStrictEqual(
      expect.arrayContaining(
        envFiles.map((file) => ({
          path: path.posix.dirname(file),
          mode: "700",
        })),
      ),
    );
    expect(fakeDaytona.permissions).toStrictEqual(
      expect.arrayContaining(
        envFiles.map((file) => ({ path: file, mode: "600" })),
      ),
    );
  });

  it("removes a command's env file when its session can't be created", async () => {
    await using sandbox = await createSandbox({
      provider: daytona(),
      env: { SANDBOX_TOKEN: "tok-orphan" },
    });
    const before = fakeDaytona.uploads.length;
    fakeDaytona.createSessionError = new Error("session quota reached");

    await expect(
      sandbox.exec({
        command: "true",
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("session quota reached");

    fakeDaytona.createSessionError = undefined;
    const left = fakeDaytona.uploads.slice(before);
    expect(left).toHaveLength(1);
    await expect(
      Promise.all(left.map(async (file) => exists(file.path))),
    ).resolves.toStrictEqual([false]);
  });

  it("fails a streamed command whose exit code Daytona doesn't report", async () => {
    await using sandbox = await createSandbox({ provider: daytona() });
    fakeDaytona.exitCodeUnknown = true;

    const result = await sandbox.exec({
      command: "echo done",
      allowFailure: true,
      abortSignal: new AbortController().signal,
    });

    fakeDaytona.exitCodeUnknown = false;
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("done\n");
    expect(result.stderr).toMatch(/no exit code/u);
  });

  it("keeps a streamed command's stderr apart from its stdout", async () => {
    await using sandbox = await createSandbox({ provider: daytona() });

    const result = await sandbox.exec({
      command: "echo one; echo oops >&2; echo two; exit 3",
      allowFailure: true,
      abortSignal: new AbortController().signal,
    });
    const elsewhere = await sandbox.exec({
      command: "pwd",
      workingDirectory: "/",
    });

    expect(result).toStrictEqual({
      exitCode: 3,
      stdout: "one\ntwo\n",
      stderr: "oops\n",
    });
    expect(elsewhere.stdout.trim()).toBe("/");
  });

  it("reads and writes text files relative to the working directory, a missing one reading as null", async () => {
    await using sandbox = await createSandbox({ provider: daytona() });

    await sandbox.writeTextFile({ path: "notes/plan.md", content: "# Plan" });

    await expect(sandbox.exec("cat notes/plan.md")).resolves.toMatchObject({
      stdout: "# Plan",
    });
    await expect(
      sandbox.readTextFile({
        path: `${sandbox.workingDirectory}/notes/plan.md`,
      }),
    ).resolves.toBe("# Plan");
    await expect(
      sandbox.readTextFile({ path: "missing.md" }),
    ).resolves.toBeNull();
  });

  it("deletes the sandbox on close()", async () => {
    const sandbox = await createSandbox({ provider: daytona() });

    await sandbox.close();
    await sandbox.close();

    expect(fakeDaytona.deleted).toStrictEqual([sandbox.sandboxId]);
  });

  it("deletes the sandbox when creation fails after Daytona made it", async () => {
    fakeDaytona.createFolderError = new Error("disk full");

    const created = createSandbox({ provider: daytona() });

    await expect(created).rejects.toThrow(CreateSandboxError);
    await expect(created).rejects.toThrow(/disk full/u);
    expect(fakeDaytona.deleted).toStrictEqual(["dtn-1"]);
  });

  it("deletes the sandbox when Daytona doesn't report a kill time", async () => {
    fakeDaytona.autoDestroyAt = undefined;

    await expect(createSandbox({ provider: daytona() })).rejects.toThrow(
      /autoDestroyAt/u,
    );
    expect(fakeDaytona.deleted).toStrictEqual(["dtn-1"]);
  });

  it("deletes a sandbox Daytona made before its create timed out", async () => {
    await orphanFakeDaytona("dtn-slow");
    fakeDaytona.createError = Object.assign(
      new Error("Failed to create and start sandbox within 60 seconds."),
      { sandboxId: "dtn-slow" },
    );

    await expect(createSandbox({ provider: daytona() })).rejects.toThrow(
      /within 60 seconds/u,
    );
    expect(fakeDaytona.deleted).toStrictEqual(["dtn-slow"]);
  });

  it("detaches: the supervisor runs in a session the host never deletes and delivers a signed finish report", async () => {
    const hook = await finishReportReceiver();
    receivers.push(hook);
    const secret = "whsec_c2FuZGNhc3RsZS1kYXl0b25hLXRlc3Qtc2VjcmV0";
    const sandbox = await createSandbox({
      provider: daytona(),
      env: { SANDBOX_TOKEN: "for-sessions" },
    });
    await sandbox.spawnSession({
      name: "implement",
      // Prints its answer, then hangs until the completion timeout ends it.
      agent: fakeAgent({
        lines: [
          JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
          JSON.stringify({
            type: "result",
            is_error: false,
            result: '<answer>{"answer": 42}</answer>',
          }),
        ],
        hang: true,
      }),
      prompt: "Reply in <answer> tags.",
      output: ANSWER,
      // Long enough that it is still running when detach() checks, under load.
      completionTimeoutSeconds: 2,
    });

    const receipt = await sandbox.detach({
      finishReport: { url: hook.url, secret },
    });
    await sandbox.close();
    const delivery = await hook.first();
    const report = await verifyFinishReport({
      body: delivery.body,
      headers: delivery.headers,
      secret,
      outputs: { implement: ANSWER },
    });

    expect(report.data).toMatchObject({
      status: "succeeded",
      sandboxId: sandbox.sandboxId,
      detachId: receipt.detachId,
    });
    expect(fakeDaytona.deleted).toStrictEqual([]);
    const supervisorSessions = fakeDaytona.commands
      .filter(({ command }) => command.includes("supervisor.mjs daemon"))
      .map(({ sessionId }) => sessionId);
    expect(supervisorSessions).toHaveLength(1);
    expect(supervisorSessions).not.toContain(undefined);
    expect(
      fakeDaytona.sessionsDeleted.filter((id) =>
        supervisorSessions.includes(id),
      ),
    ).toStrictEqual([]);
  });

  it("reattaches by id, ignoring `create`: status() reads the detached run, exec gets the env passed again, and a gone sandbox is unavailable", async () => {
    const sandbox = await createSandbox({
      provider: daytona(),
      env: { SANDBOX_TOKEN: "for-sessions" },
    });
    await sandbox.spawnSession({
      name: "implement",
      agent: fakeAgent({
        lines: [
          JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
        ],
        hang: true,
      }),
      prompt: "Work.",
    });
    const receipt = await sandbox.detach();
    const creates = fakeDaytona.createCalls.length;

    const reattached = await reattachSandbox({
      provider: daytona({ create: { snapshot: "never-used" } }),
      sandboxId: receipt.sandboxId,
      env: { SANDBOX_TOKEN: "passed-again" },
    });

    expect(fakeDaytona.createCalls).toHaveLength(creates);
    expect(reattached).toMatchObject({
      sandboxId: sandbox.sandboxId,
      workingDirectory: sandbox.workingDirectory,
      killTime: sandbox.killTime,
    });
    await expect(reattached?.status()).resolves.toMatchObject({
      running: [{ kind: "session", name: "implement", agent: "claude-code" }],
      detached: { detachId: receipt.detachId, delivery: "not-finished" },
    });
    await expect(
      reattached?.exec('printf %s "$SANDBOX_TOKEN"'),
    ).resolves.toMatchObject({
      stdout: "passed-again",
    });

    await reattached?.close();
    expect(fakeDaytona.deleted).toStrictEqual([sandbox.sandboxId]);
    await expect(
      reattachSandbox({ provider: daytona(), sandboxId: sandbox.sandboxId }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
    await expect(
      reattachSandbox({ provider: daytona(), sandboxId: "dtn-never-made" }),
    ).rejects.toMatchObject({
      _tag: "SandboxUnavailableError",
      sandboxId: "dtn-never-made",
    });
  });
});
