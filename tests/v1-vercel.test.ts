import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DetachableSandbox } from "@ai-hero/sandcastle/v1";
import {
  CreateSandboxError,
  createSandbox,
  Output,
  reattachSandbox,
  SandboxUnavailableError,
  verifyFinishReport,
} from "@ai-hero/sandcastle/v1";
import { vercel } from "@ai-hero/sandcastle/v1/sandboxes/vercel";
import { z } from "zod";
import { fakeAgent } from "@ai-hero/sandcastle/v1/testing";
import {
  destroyAllFakeVercel,
  extendFakeVercel,
  fakeVercel,
  resetFakeVercel,
} from "./helpers/fakeVercel.js";
import type { FinishReportReceiver } from "./helpers/finishReportReceiver.js";
import { finishReportReceiver } from "./helpers/finishReportReceiver.js";
import { providerContract } from "./helpers/providerContract.js";

// vercel() through its subpath, with `@vercel/sandbox` module-mocked by a
// fake whose sandboxes are host directories running real `sh` processes, so
// createSandbox starts the real session supervisor in them. The supervisor
// bundle comes from the build and the fake needs POSIX process groups, so
// these skip on Windows.

vi.mock("@vercel/sandbox", async () => {
  const { FakeVercelSandbox } = await import("./helpers/fakeVercel.js");
  return { Sandbox: FakeVercelSandbox };
});

const ANSWER = Output.object({
  tag: "answer",
  schema: z.object({ answer: z.number() }),
});

const ANSWERING_AGENT_LINES = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
  JSON.stringify({
    type: "result",
    is_error: false,
    result: '<answer>{"answer": 42}</answer>',
  }),
];

const lastCreate = (): Record<string, unknown> => {
  const params = fakeVercel.createCalls.at(-1);
  if (params === undefined) {
    throw new Error("Vercel's create was not called");
  }
  return params;
};

/** A Vercel sandbox reattached by id, failing the test when its supervisor isn't there. */
const reattachOrFail = async (
  sandboxId: string,
): Promise<DetachableSandbox> => {
  const handle = await reattachSandbox({ provider: vercel(), sandboxId });
  if (handle === undefined) {
    throw new Error("the supervisor should be there");
  }
  return handle;
};

describe.skipIf(process.platform === "win32")("vercel() (v1)", () => {
  let receivers: FinishReportReceiver[] = [];

  beforeEach(async () => {
    await resetFakeVercel();
    vi.stubEnv("VERCEL_TOKEN", "");
    vi.stubEnv("VERCEL_TEAM_ID", "");
    vi.stubEnv("VERCEL_PROJECT_ID", "");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await destroyAllFakeVercel();
    await Promise.all(receivers.map(async (made) => made.close()));
    receivers = [];
  });

  providerContract(async (env) => createSandbox({ provider: vercel(), env }));

  it("passes `create` through to Vercel's create, with a timeout of the time limit and persistent off", async () => {
    const provider = vercel({
      token: "vc-token",
      teamId: "team_1",
      projectId: "prj_1",
      create: {
        image: "vercel/sandbox/universal",
        resources: { vcpus: 4 },
        ports: [3000],
        networkPolicy: "deny-all",
        tags: { run: "r-1" },
        // New in @vercel/sandbox 4.0.0.
        credentials: { npm: true },
      },
    });

    await using sandbox = await createSandbox({
      provider,
      timeLimitMinutes: 30,
    });

    expect(sandbox.canDetach).toBe(true);
    expect(lastCreate()).toStrictEqual({
      image: "vercel/sandbox/universal",
      resources: { vcpus: 4 },
      ports: [3000],
      networkPolicy: "deny-all",
      tags: { run: "r-1" },
      credentials: { npm: true },
      token: "vc-token",
      teamId: "team_1",
      projectId: "prj_1",
      timeout: 1_800_000,
      persistent: false,
    });
  });

  it("reads the token, team and project from the environment, else leaves auth to the SDK's OIDC", async () => {
    await using _plain = await createSandbox({ provider: vercel() });
    const oidc = lastCreate();
    vi.stubEnv("VERCEL_TOKEN", "env-token");
    vi.stubEnv("VERCEL_TEAM_ID", "env-team");
    vi.stubEnv("VERCEL_PROJECT_ID", "env-project");

    await using _fromEnv = await createSandbox({ provider: vercel() });

    expect(oidc).not.toHaveProperty("token");
    expect(lastCreate()).toMatchObject({
      token: "env-token",
      teamId: "env-team",
      projectId: "env-project",
      persistent: false,
    });
  });

  it("rejects a token without a team and project id, before Vercel is called", async () => {
    await expect(
      createSandbox({ provider: vercel({ token: "vc-token" }) }),
    ).rejects.toThrow(/VERCEL_TEAM_ID.*VERCEL_PROJECT_ID/u);
    expect(fakeVercel.createCalls).toStrictEqual([]);
  });

  it("keeps the fields Sandcastle sets out of `create`", () => {
    // Types only: nothing is created.
    const typed = () => [
      // @ts-expect-error the timeout comes from timeLimitMinutes
      vercel({ create: { timeout: 60_000 } }),
      // @ts-expect-error env goes to createSandbox, then to each command
      vercel({ create: { env: { A: "1" } } }),
      // @ts-expect-error a persistent sandbox leaves a snapshot on every stop
      vercel({ create: { persistent: true } }),
      // @ts-expect-error auth is vercel()'s own `token` option
      vercel({ create: { token: "t" } }),
      // @ts-expect-error auth is vercel()'s own `teamId` option
      vercel({ create: { teamId: "t" } }),
      // @ts-expect-error auth is vercel()'s own `projectId` option
      vercel({ create: { projectId: "p" } }),
    ];

    expect(typed).toBeTypeOf("function");
  });

  it("reads the kill time back from the sandbox Vercel made", async () => {
    fakeVercel.expiresAt = new Date("2031-02-03T04:05:06.000Z");

    await using sandbox = await createSandbox({ provider: vercel() });

    expect(sandbox.killTime.toISOString()).toBe("2031-02-03T04:05:06.000Z");
  });

  it("reports Vercel's own refusal of a time limit over the plan's cap", async () => {
    fakeVercel.createError = Object.assign(
      new Error(
        "Status code 400 is not ok: `timeout` restricted to <= 45m on Hobby plans.",
      ),
      { response: { status: 400 } },
    );

    const created = createSandbox({ provider: vercel(), timeLimitMinutes: 60 });

    await expect(created).rejects.toThrow(CreateSandboxError);
    await expect(created).rejects.toThrow(/restricted to <= 45m on Hobby/u);
    expect(lastCreate()).toMatchObject({ timeout: 3_600_000 });
  });

  it("gives a command its env through Vercel's per-command env, never through its create or the command line", async () => {
    const secret = "tok-6b1f0c2e9a";
    await using sandbox = await createSandbox({
      provider: vercel(),
      env: { SANDBOX_TOKEN: secret },
    });

    const result = await sandbox.exec({
      command: 'printf "%s|%s" "$SANDBOX_TOKEN" "$ONE_OFF"',
      env: { ONE_OFF: "it's here" },
    });

    expect(result.stdout).toBe(`${secret}|it's here`);
    expect(lastCreate()).not.toHaveProperty("env");
    expect(JSON.stringify(lastCreate())).not.toContain(secret);
    expect(
      fakeVercel.commands.filter(({ cmd, args }) =>
        [cmd, ...args].join(" ").includes(secret),
      ),
    ).toStrictEqual([]);
    expect(
      fakeVercel.commands.filter(({ env }) => env.SANDBOX_TOKEN === secret),
    ).not.toHaveLength(0);
  });

  it("runs a command with sudo through Vercel's own sudo", async () => {
    await using sandbox = await createSandbox({ provider: vercel() });

    await sandbox.exec({ command: "true", sudo: true });

    expect(fakeVercel.commands.at(-1)).toMatchObject({
      cmd: "sh",
      args: ["-c", "true"],
      sudo: true,
    });
  });

  it("keeps a command's stderr apart from its stdout, a last line with no newline included", async () => {
    await using sandbox = await createSandbox({ provider: vercel() });

    const result = await sandbox.exec({
      command: "echo one; echo oops >&2; printf tail; exit 3",
      allowFailure: true,
    });
    const elsewhere = await sandbox.exec({
      command: "pwd",
      workingDirectory: "/",
    });

    expect(result).toStrictEqual({
      exitCode: 3,
      stdout: "one\ntail",
      stderr: "oops\n",
    });
    expect(elsewhere.stdout.trim()).toBe("/");
  });

  it("ends an aborted command and everything it started", async () => {
    await using sandbox = await createSandbox({ provider: vercel() });
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => {
      controller.abort();
    }, 500);

    const result = await sandbox.exec({
      command: "echo start; sleep 30; echo never",
      allowFailure: true,
      abortSignal: controller.signal,
    });

    expect(result.exitCode).toBe(143);
    expect(result.stdout).toBe("start\n");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("reads and writes text files relative to the working directory, a missing one reading as null", async () => {
    await using sandbox = await createSandbox({ provider: vercel() });

    await sandbox.writeTextFile({ path: "notes/plan.md", content: "# Plan" });

    expect(sandbox.workingDirectory).toMatch(/\/sandbox\/workspace$/u);
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

  it("stops the sandbox on close(), safely twice", async () => {
    const sandbox = await createSandbox({ provider: vercel() });

    await sandbox.close();
    await sandbox.close();

    expect(fakeVercel.stopped).toStrictEqual([sandbox.sandboxId]);
  });

  it("stops the sandbox when its working directory can't be made", async () => {
    fakeVercel.mkdirFails = true;

    const created = createSandbox({ provider: vercel() });

    await expect(created).rejects.toThrow(CreateSandboxError);
    await expect(created).rejects.toThrow(/read-only file system/u);
    expect(fakeVercel.stopped).toStrictEqual(["sbx-1"]);
  });

  it("stops the sandbox when Vercel doesn't report a kill time", async () => {
    fakeVercel.expiresAt = undefined;

    await expect(createSandbox({ provider: vercel() })).rejects.toThrow(
      /expiresAt/u,
    );
    expect(fakeVercel.stopped).toStrictEqual(["sbx-1"]);
  });

  it("stops the sandbox when creation is aborted after Vercel made it", async () => {
    const controller = new AbortController();
    fakeVercel.afterCreate = () => {
      controller.abort();
    };

    await expect(
      createSandbox({ provider: vercel(), abortSignal: controller.signal }),
    ).rejects.toThrow(CreateSandboxError);
    expect(fakeVercel.stopped).toStrictEqual(["sbx-1"]);
  });

  it("detaches: the supervisor runs as a detached command with no timeout and delivers a signed finish report", async () => {
    const hook = await finishReportReceiver();
    receivers.push(hook);
    const secret = "whsec_c2FuZGNhc3RsZS12ZXJjZWwtdGVzdC1zZWNyZXQtb2s=";
    const sandbox = await createSandbox({
      provider: vercel(),
      env: { SANDBOX_TOKEN: "for-sessions" },
    });
    await sandbox.spawnSession({
      name: "implement",
      // Prints its answer, then hangs until the completion timeout ends it.
      agent: fakeAgent({ lines: ANSWERING_AGENT_LINES, hang: true }),
      prompt: "Reply in <answer> tags.",
      output: ANSWER,
      // Long enough that it is still running when detach() checks, under load.
      completionTimeoutSeconds: 2,
    });

    const receipt = await sandbox.detach({
      finishReport: { url: hook.url, secret },
    });
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
    expect(fakeVercel.stopped).toStrictEqual([]);
    const daemons = fakeVercel.commands.filter(({ args }) =>
      args.join(" ").includes("supervisor.mjs daemon"),
    );
    expect(daemons).toHaveLength(1);
    expect(
      daemons.map(({ detached, timeoutMs }) => [detached, timeoutMs]),
    ).toStrictEqual([[true, undefined]]);
  });

  it("reuses a sandbox after its report: a reattached handle restarts the supervisor and reports again", async () => {
    const hook = await finishReportReceiver();
    receivers.push(hook);
    const secret = "whsec_c2FuZGNhc3RsZS12ZXJjZWwtdGVzdC1zZWNyZXQtb2s=";
    const step = async (sandbox: DetachableSandbox) => {
      await sandbox.spawnSession({
        name: "step",
        agent: fakeAgent({ lines: ANSWERING_AGENT_LINES, hang: true }),
        prompt: "Reply in <answer> tags.",
        output: ANSWER,
        completionTimeoutSeconds: 2,
      });
      return sandbox.detach({ finishReport: { url: hook.url, secret } });
    };
    const sandbox = await createSandbox({ provider: vercel() });
    const first = await step(sandbox);
    await hook.received(1);

    const second = await step(await reattachOrFail(sandbox.sandboxId));
    const deliveries = await hook.received(2);
    const reports = await Promise.all(
      deliveries.map(async ({ body, headers }) =>
        verifyFinishReport({
          body,
          headers,
          secret,
          outputs: { step: ANSWER },
        }),
      ),
    );

    expect(
      reports.map(({ data }) => [data.detachId, data.status]),
    ).toStrictEqual([
      [first.detachId, "succeeded"],
      [second.detachId, "succeeded"],
    ]);
    const daemons = fakeVercel.commands.filter(({ args }) =>
      args.join(" ").includes("supervisor.mjs daemon"),
    );
    expect(daemons).toHaveLength(2);
  }, 30_000);

  it("reattaches by id, ignoring `create`: the kill time is read afresh, exec gets the env passed again, and a gone sandbox is unavailable", async () => {
    const sandbox = await createSandbox({
      provider: vercel({
        token: "vc-token",
        teamId: "team_1",
        projectId: "prj_1",
      }),
      env: { SANDBOX_TOKEN: "for-sessions" },
    });
    await sandbox.spawnSession({
      name: "implement",
      agent: fakeAgent({
        lines: ANSWERING_AGENT_LINES.slice(0, 1),
        hang: true,
      }),
      prompt: "Work.",
    });
    const receipt = await sandbox.detach();
    const creates = fakeVercel.createCalls.length;
    // Another handle extended the sandbox's timeout.
    const extended = new Date(sandbox.killTime.getTime() + 15 * 60_000);
    extendFakeVercel(sandbox.sandboxId, extended);

    const reattached = await reattachSandbox({
      provider: vercel({
        token: "vc-token",
        teamId: "team_1",
        projectId: "prj_1",
        create: { image: "never-used" },
      }),
      sandboxId: receipt.sandboxId,
      env: { SANDBOX_TOKEN: "passed-again" },
    });

    expect(fakeVercel.createCalls).toHaveLength(creates);
    expect(fakeVercel.getCalls.at(-1)).toStrictEqual({
      token: "vc-token",
      teamId: "team_1",
      projectId: "prj_1",
      name: sandbox.sandboxId,
    });
    expect(reattached).toMatchObject({
      sandboxId: sandbox.sandboxId,
      workingDirectory: sandbox.workingDirectory,
      killTime: extended,
    });
    await expect(reattached?.status()).resolves.toMatchObject({
      running: [{ kind: "session", name: "implement", agent: "claude-code" }],
      detached: { detachId: receipt.detachId, delivery: "not-finished" },
    });
    await expect(
      reattached?.exec('printf %s "$SANDBOX_TOKEN"'),
    ).resolves.toMatchObject({ stdout: "passed-again" });

    await reattached?.close();
    expect(fakeVercel.stopped).toStrictEqual([sandbox.sandboxId]);
    await expect(
      reattachSandbox({ provider: vercel(), sandboxId: sandbox.sandboxId }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
    await expect(
      reattachSandbox({ provider: vercel(), sandboxId: "sbx-never-made" }),
    ).rejects.toMatchObject({
      _tag: "SandboxUnavailableError",
      sandboxId: "sbx-never-made",
    });
  });
});
