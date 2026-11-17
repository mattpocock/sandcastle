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
import {
  parseSpriteName,
  sprites,
} from "@ai-hero/sandcastle/v1/sandboxes/sprites";
import { z } from "zod";
import { fakeAgent } from "@ai-hero/sandcastle/v1/testing";
import {
  destroyAllFakeSprites,
  fakeSprites,
  resetFakeSprites,
  spriteFileExists,
  taskCalls,
} from "./helpers/fakeSprites.js";
import type { FinishReportReceiver } from "./helpers/finishReportReceiver.js";
import { finishReportReceiver } from "./helpers/finishReportReceiver.js";
import { providerContract } from "./helpers/providerContract.js";

// sprites() through its subpath, with `@fly/sprites` module-mocked by a fake
// whose sprites are host directories running real `sh` processes, so
// createSandbox starts the real session supervisor in them. The supervisor
// bundle comes from the build and the fake needs POSIX process groups, so
// these skip on Windows.

vi.mock("@fly/sprites", async () => {
  const { FakeSpritesClient } = await import("./helpers/fakeSprites.js");
  return { SpritesClient: FakeSpritesClient };
});

const ANSWER = Output.object({
  tag: "answer",
  schema: z.object({ answer: z.number() }),
});

const TOKEN = "sprites-test-token";

/** A provider with a token, as the tests' host has none in its env. */
const provider = (options: Parameters<typeof sprites>[0] = {}) =>
  sprites({ token: TOKEN, ...options });

/** The error a promise rejected with; fails the test if it resolved. */
const rejection = async (pending: Promise<unknown>): Promise<Error> => {
  const outcome: unknown = await pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof Error)) {
    throw new TypeError("it didn't reject");
  }
  return outcome;
};

/** An error, its causes and their stacks, as one string. */
const everything = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return String(error);
  }
  return [error.message, error.stack ?? "", everything(error.cause)].join("\n");
};

/** A sprite reattached by name, failing the test when its supervisor isn't there. */
const reattachOrFail = async (
  sandboxId: string,
): Promise<DetachableSandbox> => {
  const handle = await reattachSandbox({ provider: provider(), sandboxId });
  if (handle === undefined) {
    throw new Error("the supervisor should be there");
  }
  return handle;
};

const answering = (hang: boolean) =>
  fakeAgent({
    lines: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
      JSON.stringify({
        type: "result",
        is_error: false,
        result: '<answer>{"answer": 42}</answer>',
      }),
    ],
    hang,
  });

describe.skipIf(process.platform === "win32")("sprites() (v1)", () => {
  let receivers: FinishReportReceiver[] = [];

  beforeEach(async () => {
    await resetFakeSprites();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await destroyAllFakeSprites();
    await Promise.all(receivers.map(async (made) => made.close()));
    receivers = [];
  });

  providerContract(async (env) => createSandbox({ provider: provider(), env }));

  it("passes `create` through to the SDK's create, naming the sprite with its kill time", async () => {
    const before = Date.now();
    await using sandbox = await createSandbox({
      provider: provider({
        create: {
          config: { ramMB: 4096, cpus: 2, region: "ord" },
          labels: ["run-1"],
        },
      }),
      timeLimitMinutes: 90,
    });

    expect(sandbox.canDetach).toBe(true);
    expect(fakeSprites.tokens).toStrictEqual([TOKEN]);
    expect(fakeSprites.createCalls).toStrictEqual([
      {
        name: sandbox.sandboxId,
        config: { ramMB: 4096, cpus: 2, region: "ord" },
        options: { labels: ["run-1"] },
      },
    ]);
    expect(sandbox.sandboxId).toMatch(
      /^sandcastle-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    const ninety = 90 * 60_000;
    expect(sandbox.killTime.getTime()).toBeGreaterThan(before + ninety - 1000);
    expect(sandbox.killTime.getTime()).toBeLessThanOrEqual(Date.now() + ninety);
    expect(parseSpriteName(sandbox.sandboxId)).toStrictEqual({
      killTime: sandbox.killTime,
    });
    expect(sandbox.workingDirectory).toBe("/home/sprite/workspace");
  });

  it("reads the token from SPRITES_TOKEN, then SPRITE_TOKEN, and fails without one", async () => {
    vi.stubEnv("SPRITES_TOKEN", "");
    vi.stubEnv("SPRITE_TOKEN", "from-the-cli-name");
    await using _first = await createSandbox({ provider: sprites() });
    vi.stubEnv("SPRITES_TOKEN", "from-the-plural");
    await using _second = await createSandbox({ provider: sprites() });
    vi.stubEnv("SPRITES_TOKEN", "");
    vi.stubEnv("SPRITE_TOKEN", "");

    expect(fakeSprites.tokens).toStrictEqual([
      "from-the-cli-name",
      "from-the-plural",
    ]);
    await expect(createSandbox({ provider: sprites() })).rejects.toThrow(
      /SPRITES_TOKEN/u,
    );
  });

  it("keeps the fields Sandcastle sets out of `create`", () => {
    // Types only: nothing is created.
    const typed = () => [
      // @ts-expect-error Sandcastle names the sprite: the name carries its kill time
      sprites({ create: { name: "mine" } }),
      // @ts-expect-error env goes to createSandbox, then to each command
      sprites({ create: { environment: { A: "1" } } }),
    ];

    expect(typed).toBeTypeOf("function");
  });

  it("parses only the names Sandcastle gives", () => {
    expect(
      parseSpriteName(
        "sandcastle-1794931200-0b9d5c7e-3f1a-4c2e-9d8b-6a5f4e3d2c1b",
      ),
    ).toStrictEqual({ killTime: new Date("2026-11-17T16:00:00.000Z") });
    expect(
      parseSpriteName("sandcastle-0b9d5c7e-3f1a-4c2e-9d8b-6a5f4e3d2c1b"),
    ).toBeUndefined();
    expect(parseSpriteName("my-dev-box")).toBeUndefined();
  });

  it("gives a command its env through a file it removes, never through the SDK's create, its exec env or the command line", async () => {
    const secret = "tok-6b1f0c2e9a";
    await using sandbox = await createSandbox({
      provider: provider(),
      env: { SANDBOX_TOKEN: secret },
    });

    const result = await sandbox.exec({
      command: 'printf "%s|%s" "$SANDBOX_TOKEN" "$ONE_OFF"',
      env: { ONE_OFF: "it's here" },
    });

    expect(result.stdout).toBe(`${secret}|it's here`);
    expect(JSON.stringify(fakeSprites.createCalls)).not.toContain(secret);
    expect(JSON.stringify(fakeSprites.spawns)).not.toContain(secret);
    const envFiles = fakeSprites.writes.filter(({ content }) =>
      content.includes("ONE_OFF"),
    );
    expect(envFiles.map(({ mode }) => mode)).toStrictEqual([0o600]);
    // Removed as the command started.
    await expect(
      Promise.all(
        envFiles.map(async (file) =>
          spriteFileExists(sandbox.sandboxId, file.path),
        ),
      ),
    ).resolves.toStrictEqual([false]);
  });

  it("keeps env out of a failed connection's error, its cause and their stacks", async () => {
    const secret = "tok-never-in-a-url-51c0";
    await using sandbox = await createSandbox({
      provider: provider(),
      env: { SANDBOX_TOKEN: secret },
    });
    fakeSprites.connectFails = true;

    const error = await rejection(
      sandbox.exec({ command: "true", env: { STEP_TOKEN: "step-7d2e" } }),
    );

    fakeSprites.connectFails = false;
    expect(everything(error)).toMatch(/failed to connect/u);
    expect(everything(error)).not.toContain(secret);
    expect(everything(error)).not.toContain("step-7d2e");
    expect(everything(error)).not.toContain("?");
  });

  it("closes stdin, so a command reading it ends, keeps stderr apart from stdout, and runs sudo through sudo sh -c", async () => {
    await using sandbox = await createSandbox({ provider: provider() });

    const result = await sandbox.exec({
      command: "cat; echo one; echo oops >&2; echo two; exit 3",
      allowFailure: true,
    });
    const elevated = await sandbox.exec({ command: "echo root", sudo: true });

    expect(result).toStrictEqual({
      exitCode: 3,
      stdout: "one\ntwo\n",
      stderr: "oops\n",
    });
    expect(elevated.stdout).toBe("root\n");
    expect(fakeSprites.spawns.at(-1)?.line).toMatch(/^sudo sh -c '/u);
  });

  it("reads and writes text files relative to the working directory, a missing one reading as null", async () => {
    await using sandbox = await createSandbox({ provider: provider() });

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

  it("deletes the sprite on close(), and is safe to call twice", async () => {
    const sandbox = await createSandbox({ provider: provider() });

    await sandbox.close();
    await sandbox.close();

    expect(fakeSprites.deleted).toStrictEqual([sandbox.sandboxId]);
  });

  it("deletes the sprite when its create fails after the sprite was made", async () => {
    fakeSprites.createError = new Error("create timed out");

    await expect(createSandbox({ provider: provider() })).rejects.toThrow(
      /create timed out/u,
    );
    expect(fakeSprites.deleted).toStrictEqual(
      fakeSprites.createCalls.map(({ name }) => name),
    );
  });

  it("deletes the sprite when its working directory can't be made", async () => {
    fakeSprites.failCommands = /mkdir -p \/home\/sprite\/workspace/u;

    const created = createSandbox({ provider: provider() });

    await expect(created).rejects.toThrow(CreateSandboxError);
    await expect(created).rejects.toThrow(/could not create/u);
    expect(fakeSprites.deleted).toHaveLength(1);
  });

  it("deletes the sprite when the session supervisor can't start", async () => {
    fakeSprites.failCommands = /supervisor\.mjs daemon/u;

    await expect(createSandbox({ provider: provider() })).rejects.toThrow(
      CreateSandboxError,
    );
    expect(fakeSprites.deleted).toHaveLength(1);
  });

  it("leaves no exit-time delete behind once the handle exists, so a host that exits after detach() leaves the sprite be", async () => {
    const listeners = process.listenerCount("exit");
    const sandbox = await createSandbox({ provider: provider() });
    await sandbox.spawnSession({
      name: "implement",
      agent: answering(true),
      prompt: "Work.",
    });

    await sandbox.detach();

    expect(process.listenerCount("exit")).toBe(listeners);
    expect(fakeSprites.deleted).toStrictEqual([]);
  });

  it("detaches: the supervisor holds a Task while it runs, outlives the host's hold and delivers a signed finish report", async () => {
    const hook = await finishReportReceiver();
    receivers.push(hook);
    const secret = "whsec_c2FuZGNhc3RsZS1zcHJpdGVzLXRlc3Qtc2VjcmV0";
    const sandbox = await createSandbox({
      provider: provider(),
      env: { SANDBOX_TOKEN: "for-sessions" },
    });
    await sandbox.spawnSession({
      name: "implement",
      // Prints its answer, then hangs until the completion timeout ends it.
      agent: answering(true),
      prompt: "Reply in <answer> tags.",
      output: ANSWER,
      completionTimeoutSeconds: 2,
    });
    const held = await taskCalls(sandbox.sandboxId);

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
    expect(fakeSprites.deleted).toStrictEqual([]);
    const daemons = fakeSprites.spawns.filter(({ line }) =>
      line.includes("supervisor.mjs daemon"),
    );
    expect(daemons).toHaveLength(1);
    expect(daemons.map(({ options }) => Object.keys(options))).toStrictEqual([
      ["maxRunAfterDisconnect"],
    ]);
    expect(daemons[0]?.options.maxRunAfterDisconnect).toMatch(/^\d+s$/u);
    expect(held).toStrictEqual([
      expect.stringMatching(/-X PUT .*\/v1\/tasks\/sandcastle-/u),
    ]);
    await vi.waitFor(async () => {
      const calls = await taskCalls(sandbox.sandboxId);
      expect(calls.at(-1)).toMatch(/-X DELETE .*\/v1\/tasks\/sandcastle-/u);
    });
  });

  it("reuses a sprite after its report: a reattached handle restarts the supervisor and reports again", async () => {
    const hook = await finishReportReceiver();
    receivers.push(hook);
    const secret = "whsec_c2FuZGNhc3RsZS1zcHJpdGVzLXRlc3Qtc2VjcmV0";
    const step = async (sandbox: DetachableSandbox) => {
      await sandbox.spawnSession({
        name: "step",
        agent: answering(true),
        prompt: "Reply in <answer> tags.",
        output: ANSWER,
        completionTimeoutSeconds: 2,
      });
      return sandbox.detach({ finishReport: { url: hook.url, secret } });
    };
    const sandbox = await createSandbox({ provider: provider() });
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
    expect(
      fakeSprites.spawns.filter(({ line }) =>
        line.includes("supervisor.mjs daemon"),
      ),
    ).toHaveLength(2);
  }, 30_000);

  it("reattaches by name, ignoring `create`: the kill time comes from the name, status() reads the detached run, exec gets the env passed again, and a gone sprite is unavailable", async () => {
    const sandbox = await createSandbox({
      provider: provider(),
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
    const creates = fakeSprites.createCalls.length;

    const reattached = await reattachSandbox({
      provider: provider({ create: { config: { cpus: 8 } } }),
      sandboxId: receipt.sandboxId,
      env: { SANDBOX_TOKEN: "passed-again" },
    });

    expect(fakeSprites.createCalls).toHaveLength(creates);
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
    expect(fakeSprites.deleted).toStrictEqual([sandbox.sandboxId]);
    await expect(
      reattachSandbox({ provider: provider(), sandboxId: sandbox.sandboxId }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
    const neverMade =
      "sandcastle-1794931200-00000000-0000-4000-8000-000000000000";
    await expect(
      reattachSandbox({ provider: provider(), sandboxId: neverMade }),
    ).rejects.toMatchObject({
      _tag: "SandboxUnavailableError",
      sandboxId: neverMade,
    });
  });
});
