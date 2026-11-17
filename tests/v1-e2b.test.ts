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
import { e2b } from "@ai-hero/sandcastle/v1/sandboxes/e2b";
import { z } from "zod";
import { fakeAgent } from "@ai-hero/sandcastle/v1/testing";
import { destroyAllFakeE2B, fakeE2B, resetFakeE2B } from "./helpers/fakeE2B.js";
import type { FinishReportReceiver } from "./helpers/finishReportReceiver.js";
import { finishReportReceiver } from "./helpers/finishReportReceiver.js";
import { providerContract } from "./helpers/providerContract.js";

// e2b() through its subpath, with `e2b`'s Sandbox module-mocked by a fake
// whose sandboxes are host directories running real `sh` processes, so
// createSandbox starts the real session supervisor in them. The supervisor
// bundle comes from the build and the fake needs POSIX process groups, so
// these skip on Windows.

vi.mock(import("e2b"), async (importOriginal) => {
  const actual = await importOriginal();
  const { fakeSandboxClass } = await import("./helpers/fakeE2B.js");
  return { ...actual, Sandbox: fakeSandboxClass(actual) };
});

const ANSWER = Output.object({
  tag: "answer",
  schema: z.object({ answer: z.number() }),
});

const SECRET = "whsec_c2FuZGNhc3RsZS1lMmItdGVzdC1zZWNyZXQ=";

const lastCreate = (): Record<string, unknown> => {
  const options = fakeE2B.createCalls.at(-1);
  if (options === undefined) {
    throw new Error("E2B's Sandbox.create was not called");
  }
  return options;
};

/** A session that prints its answer, then hangs until the completion timeout ends it. */
const answering = {
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
};

/** An E2B sandbox reattached by id, failing the test when its supervisor isn't there. */
const reattachOrFail = async (
  sandboxId: string,
): Promise<DetachableSandbox> => {
  const handle = await reattachSandbox({ provider: e2b(), sandboxId });
  if (handle === undefined) {
    throw new Error("the supervisor should be there");
  }
  return handle;
};

describe.skipIf(process.platform === "win32")("e2b() (v1)", () => {
  let receivers: FinishReportReceiver[] = [];

  beforeEach(async () => {
    await resetFakeE2B();
  });

  afterEach(async () => {
    await destroyAllFakeE2B();
    await Promise.all(receivers.map(async (made) => made.close()));
    receivers = [];
  });

  providerContract(async (env) => createSandbox({ provider: e2b(), env }));

  it("passes `create` through to E2B's Sandbox.create, with a timeout of the time limit, killed when it runs out", async () => {
    const provider = e2b({
      apiKey: "e2b-key",
      domain: "e2b.example",
      create: {
        template: "agent-runner",
        metadata: { run: "r-1" },
        network: { denyOut: ["10.0.0.0/8"] },
      },
    });

    await using sandbox = await createSandbox({
      provider,
      timeLimitMinutes: 90,
    });

    expect(sandbox.canDetach).toBe(true);
    expect(lastCreate()).toStrictEqual({
      template: "agent-runner",
      metadata: { run: "r-1" },
      network: { denyOut: ["10.0.0.0/8"] },
      apiKey: "e2b-key",
      domain: "e2b.example",
      timeoutMs: 5_400_000,
      lifecycle: { onTimeout: "kill", autoResume: false },
    });
  });

  it("makes sandboxes from E2B's claude template by default, and leaves an empty API key for the SDK to read from E2B_API_KEY", async () => {
    await using _sandbox = await createSandbox({
      provider: e2b({ apiKey: "" }),
      timeLimitMinutes: 0.5,
    });

    expect(lastCreate()).toStrictEqual({
      template: "claude",
      timeoutMs: 30_000,
      lifecycle: { onTimeout: "kill", autoResume: false },
    });
  });

  it("keeps the fields Sandcastle sets out of `create`", () => {
    // Types only: nothing is created.
    const typed = () => [
      // @ts-expect-error env goes to createSandbox, then to each command
      e2b({ create: { envs: { A: "1" } } }),
      // @ts-expect-error the timeout comes from timeLimitMinutes
      e2b({ create: { timeoutMs: 5000 } }),
      // @ts-expect-error a paused sandbox's supervisor couldn't report
      e2b({ create: { lifecycle: { onTimeout: "pause" } } }),
      // @ts-expect-error the API key is e2b()'s own option
      e2b({ create: { apiKey: "k" } }),
      // @ts-expect-error the domain is e2b()'s own option
      e2b({ create: { domain: "e2b.example" } }),
    ];

    expect(typed).toBeTypeOf("function");
  });

  it("reads the kill time back from E2B, even when the plan's cap made it shorter than the time limit", async () => {
    fakeE2B.planCapMs = 60 * 60_000;

    await using sandbox = await createSandbox({
      provider: e2b(),
      timeLimitMinutes: 90,
    });

    expect(sandbox.killTime).toStrictEqual(
      fakeE2B.sandboxes.get(sandbox.sandboxId)?.endAt,
    );
    expect(sandbox.killTime.getTime()).toBeLessThanOrEqual(
      Date.now() + 60 * 60_000,
    );
  });

  it("gives every command its env through E2B's per-command env, never through Sandbox.create or the command line", async () => {
    const secret = "tok-6b1f0c2e9a";
    await using sandbox = await createSandbox({
      provider: e2b(),
      env: { SANDBOX_TOKEN: secret },
    });

    const result = await sandbox.exec({
      command: 'printf "%s|%s" "$SANDBOX_TOKEN" "$ONE_OFF"',
      env: { ONE_OFF: "it's here" },
    });
    const elevated = await sandbox.exec({
      command: 'printf %s "$SANDBOX_TOKEN"',
      sudo: true,
    });

    expect(result.stdout).toBe(`${secret}|it's here`);
    expect(elevated.stdout).toBe(secret);
    expect(lastCreate()).not.toHaveProperty("envs");
    expect(
      fakeE2B.commands.filter(({ command }) => command.includes(secret)),
    ).toStrictEqual([]);
    const sandboxCommands = fakeE2B.commands.filter(
      ({ options }) => options.background === true,
    );
    expect(sandboxCommands).not.toHaveLength(0);
    expect(
      sandboxCommands.filter(
        ({ options }) =>
          !JSON.stringify(options.envs).includes(`"SANDBOX_TOKEN":"${secret}"`),
      ),
    ).toStrictEqual([]);
  });

  it("runs every command with no time limit of its own, and a sudo one as root", async () => {
    await using sandbox = await createSandbox({ provider: e2b() });

    await sandbox.exec({ command: "true", sudo: true });

    expect(
      fakeE2B.commands.filter(({ options }) => options.timeoutMs !== 0),
    ).toStrictEqual([]);
    expect(fakeE2B.commands.at(-1)?.options).toMatchObject({ user: "root" });
    expect(fakeE2B.commands.at(-2)?.options).not.toHaveProperty("user");
  });

  // A provider's stdin and onLine aren't on the public exec: the session
  // supervisor's client streams its replies through onLine, which every
  // session and detach test here depends on.
  it("keeps stderr apart from stdout, with the exit code", async () => {
    await using sandbox = await createSandbox({ provider: e2b() });

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

  it("kills a command when its abort signal fires", async () => {
    await using sandbox = await createSandbox({ provider: e2b() });
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 300);

    const result = await sandbox.exec({
      command: "sleep 30",
      allowFailure: true,
      abortSignal: controller.signal,
    });

    expect(result.exitCode).toBe(143);
  });

  it("starts commands in $HOME/workspace, and reads and writes text files relative to it, a missing one reading as null", async () => {
    await using sandbox = await createSandbox({ provider: e2b() });

    await sandbox.writeTextFile({ path: "notes/plan.md", content: "# Plan" });

    expect(sandbox.workingDirectory).toMatch(/\/home\/workspace$/u);
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

  it("kills the sandbox on close(), and a second close() does nothing", async () => {
    const sandbox = await createSandbox({ provider: e2b() });

    await sandbox.close();
    await sandbox.close();

    expect(fakeE2B.killed).toStrictEqual([sandbox.sandboxId]);
  });

  it("kills the sandbox when E2B can't say when it will end", async () => {
    fakeE2B.getInfoError = new Error("info unavailable");

    const created = createSandbox({ provider: e2b() });

    await expect(created).rejects.toThrow(CreateSandboxError);
    await expect(created).rejects.toThrow(/info unavailable/u);
    expect(fakeE2B.killed).toStrictEqual(["e2b-1"]);
  });

  it("kills the sandbox when its working directory can't be made", async () => {
    fakeE2B.failCommand = /workspace/u;

    await expect(createSandbox({ provider: e2b() })).rejects.toThrow(
      CreateSandboxError,
    );
    expect(fakeE2B.killed).toStrictEqual(["e2b-1"]);
  });

  it("kills the sandbox when the session supervisor can't start in it", async () => {
    fakeE2B.failCommand = /command -v node/u;

    await expect(createSandbox({ provider: e2b() })).rejects.toThrow(
      CreateSandboxError,
    );
    expect(fakeE2B.killed).toStrictEqual(["e2b-1"]);
  });

  it("rejects when E2B can't make the sandbox, leaving nothing to kill", async () => {
    fakeE2B.createError = new Error(
      "400: Timeout cannot be greater than 1 hours",
    );

    await expect(
      createSandbox({ provider: e2b(), timeLimitMinutes: 120 }),
    ).rejects.toThrow(/cannot be greater than 1 hours/u);
    expect(fakeE2B.killed).toStrictEqual([]);
  });

  it("detaches: the supervisor runs as a background command the host disconnects from, and delivers a signed finish report", async () => {
    const hook = await finishReportReceiver();
    receivers.push(hook);
    const sandbox = await createSandbox({
      provider: e2b(),
      env: { SANDBOX_TOKEN: "for-sessions" },
    });
    await sandbox.spawnSession({ name: "implement", ...answering });

    const receipt = await sandbox.detach({
      finishReport: { url: hook.url, secret: SECRET },
    });
    await sandbox.close();
    const delivery = await hook.first();
    const report = await verifyFinishReport({
      body: delivery.body,
      headers: delivery.headers,
      secret: SECRET,
      outputs: { implement: ANSWER },
    });

    expect(report.data).toMatchObject({
      status: "succeeded",
      sandboxId: sandbox.sandboxId,
      detachId: receipt.detachId,
    });
    expect(fakeE2B.killed).toStrictEqual([]);
    const daemons = fakeE2B.commands.filter(({ command }) =>
      command.includes("supervisor.mjs daemon"),
    );
    expect(
      daemons.map(({ options }) => [options.background, options.timeoutMs]),
    ).toStrictEqual([[true, 0]]);
    expect(fakeE2B.disconnected).toStrictEqual(
      daemons.map(({ command }) => command),
    );
  });

  it("reuses a sandbox after its report: a reattached handle restarts the supervisor and reports again", async () => {
    const hook = await finishReportReceiver();
    receivers.push(hook);
    const step = async (sandbox: DetachableSandbox) => {
      await sandbox.spawnSession({ name: "step", ...answering });
      return sandbox.detach({
        finishReport: { url: hook.url, secret: SECRET },
      });
    };
    const sandbox = await createSandbox({ provider: e2b() });
    const first = await step(sandbox);
    await hook.received(1);

    const second = await step(await reattachOrFail(sandbox.sandboxId));
    const deliveries = await hook.received(2);
    const reports = await Promise.all(
      deliveries.map(async ({ body, headers }) =>
        verifyFinishReport({
          body,
          headers,
          secret: SECRET,
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
    const daemons = fakeE2B.commands.filter(({ command }) =>
      command.includes("supervisor.mjs daemon"),
    );
    expect(daemons).toHaveLength(2);
  }, 30_000);

  it("reattaches by id, ignoring `create` and leaving the kill time where it was: status() reads the detached run, exec gets the env passed again, and a gone sandbox is unavailable", async () => {
    const sandbox = await createSandbox({
      provider: e2b({ apiKey: "e2b-key" }),
      env: { SANDBOX_TOKEN: "for-sessions" },
      // Shorter than the timeout E2B gives a connect that doesn't ask for one.
      timeLimitMinutes: 2,
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
    const creates = fakeE2B.createCalls.length;

    const reattached = await reattachSandbox({
      provider: e2b({ apiKey: "e2b-key", create: { template: "never-used" } }),
      sandboxId: receipt.sandboxId,
      env: { SANDBOX_TOKEN: "passed-again" },
    });

    expect(fakeE2B.createCalls).toHaveLength(creates);
    expect(fakeE2B.connectCalls).toStrictEqual([
      {
        sandboxId: sandbox.sandboxId,
        apiKey: "e2b-key",
        endAtMovedMs: 0,
      },
    ]);
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
    expect(fakeE2B.killed).toStrictEqual([sandbox.sandboxId]);
    await expect(
      reattachSandbox({ provider: e2b(), sandboxId: sandbox.sandboxId }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
    await expect(
      reattachSandbox({ provider: e2b(), sandboxId: "e2b-never-made" }),
    ).rejects.toMatchObject({
      _tag: "SandboxUnavailableError",
      sandboxId: "e2b-never-made",
    });
  });
});
