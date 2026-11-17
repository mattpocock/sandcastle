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
import { modal } from "@ai-hero/sandcastle/v1/sandboxes/modal";
import type { ModalClientParams } from "modal";
import { z } from "zod";
import { fakeAgent } from "@ai-hero/sandcastle/v1/testing";
import {
  destroyAllFakeModal,
  fakeModal,
  resetFakeModal,
} from "./helpers/fakeModal.js";
import type { FinishReportReceiver } from "./helpers/finishReportReceiver.js";
import { finishReportReceiver } from "./helpers/finishReportReceiver.js";
import { providerContract } from "./helpers/providerContract.js";

// modal() through its subpath, with the `modal` SDK module-mocked by a fake
// whose sandboxes are host directories running real processes, so
// createSandbox starts the real session supervisor in them. The supervisor
// bundle comes from the build and the fake needs POSIX process groups, so
// these skip on Windows.

vi.mock(import("modal"), async () => {
  const { fakeModalClient } = await import("./helpers/fakeModal.js");
  // `new ModalClient(params)` gives the fake client: a constructor that
  // returns an object makes `new` give that object. The fake covers only what
  // modal() calls, so it returns what vitest's own untyped mock returns, not
  // a real ModalClient.
  type UntypedMock = NonNullable<Parameters<typeof vi.fn>[0]>;
  const ModalClient =
    vi.fn<(params: ModalClientParams) => ReturnType<UntypedMock>>(
      fakeModalClient,
    );
  return { ModalClient };
});

const ANSWER = Output.object({
  tag: "answer",
  schema: z.object({ answer: z.number() }),
});

const lastCreate = () => {
  const call = fakeModal.createCalls.at(-1);
  if (call === undefined) {
    throw new Error("Modal's create was not called");
  }
  return call;
};

/** The commands the fake ran whose command line includes `text`. */
const execsWith = (text: string) =>
  fakeModal.execs.filter(({ argv }) => argv.join(" ").includes(text));

/** A Modal sandbox reattached by id, failing the test when its supervisor isn't there. */
const reattachOrFail = async (
  sandboxId: string,
): Promise<DetachableSandbox> => {
  const handle = await reattachSandbox({ provider: modal(), sandboxId });
  if (handle === undefined) {
    throw new Error("the supervisor should be there");
  }
  return handle;
};

/** A fake agent that prints its answer, then hangs until the completion timeout ends it. */
const answering = () =>
  fakeAgent({
    lines: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
      JSON.stringify({
        type: "result",
        is_error: false,
        result: '<answer>{"answer": 42}</answer>',
      }),
    ],
    hang: true,
  });

describe.skipIf(process.platform === "win32")("modal() (v1)", () => {
  let receivers: FinishReportReceiver[] = [];

  beforeEach(async () => {
    await resetFakeModal();
  });

  afterEach(async () => {
    await destroyAllFakeModal();
    await Promise.all(receivers.map(async (made) => made.close()));
    receivers = [];
  });

  providerContract(async (env) => createSandbox({ provider: modal(), env }));

  it("passes `create` through to Modal's create, with the lifetime from the time limit, in the app it names", async () => {
    const provider = modal({
      tokenId: "ak-id",
      tokenSecret: "as-secret",
      environment: "staging",
      appName: "runner",
      image: "node:22-bookworm",
      create: { cpu: 2, memoryMiB: 4096, blockNetwork: false },
    });

    await using sandbox = await createSandbox({
      provider,
      timeLimitMinutes: 90.5,
    });

    expect(sandbox.canDetach).toBe(true);
    expect(sandbox.workingDirectory).toBe("/workspace");
    expect(fakeModal.clientParams).toStrictEqual([
      { tokenId: "ak-id", tokenSecret: "as-secret", environment: "staging" },
    ]);
    expect(fakeModal.apps).toStrictEqual([
      { name: "runner", params: { createIfMissing: true } },
    ]);
    expect(lastCreate().image.tag).toBe("node:22-bookworm");
    expect(lastCreate().params).toStrictEqual({
      command: ["sleep", "infinity"],
      cpu: 2,
      memoryMiB: 4096,
      blockNetwork: false,
      timeoutMs: 5_430_000,
    });
  });

  it("builds the default image on node:24-bookworm with Claude Code and a non-root user, in the `sandcastle` app", async () => {
    await using _sandbox = await createSandbox({ provider: modal() });

    expect(fakeModal.clientParams).toStrictEqual([{}]);
    expect(fakeModal.apps.map(({ name }) => name)).toStrictEqual([
      "sandcastle",
    ]);
    const { image } = lastCreate();
    expect(image.tag).toBe("node:24-bookworm");
    expect(image.commands.join("\n")).toContain("@anthropic-ai/claude-code");
    expect(image.commands.join("\n")).toContain("useradd");
  });

  it("rejects a time limit over Modal's 24 hours before making anything", async () => {
    await expect(
      createSandbox({ provider: modal(), timeLimitMinutes: 24 * 60 + 1 }),
    ).rejects.toThrow(/24 hours/u);
    expect(fakeModal.createCalls).toStrictEqual([]);
  });

  it("keeps the fields Sandcastle sets out of `create`", () => {
    // Types only: nothing is created.
    const typed = () => [
      // @ts-expect-error the lifetime comes from timeLimitMinutes
      modal({ create: { timeoutMs: 60_000 } }),
      // @ts-expect-error an idle timeout would end a detached run
      modal({ create: { idleTimeoutMs: 60_000 } }),
      // @ts-expect-error env goes to createSandbox, then to each command
      modal({ create: { env: { A: "1" } } }),
      // @ts-expect-error secrets would reach the sandbox unredacted
      modal({ create: { secrets: [] } }),
    ];

    expect(typed).toBeTypeOf("function");
  });

  it("gives every command its env in Modal's exec call, never in Modal's create or on the command line", async () => {
    const secret = "tok-6b1f0c2e9a";
    await using sandbox = await createSandbox({
      provider: modal(),
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
    expect(lastCreate().params).not.toHaveProperty("env");
    expect(JSON.stringify(lastCreate())).not.toContain(secret);
    expect(execsWith(secret)).toStrictEqual([]);
  });

  it("runs commands as the image's `sandcastle` user, and as root with sudo", async () => {
    await using sandbox = await createSandbox({ provider: modal() });
    const before = fakeModal.execs.length;

    await sandbox.exec("echo plain");
    await sandbox.exec({ command: "echo elevated", sudo: true });

    const [plain, elevated] = fakeModal.execs.slice(before);
    expect(plain?.argv.slice(0, 5)).toStrictEqual([
      "setpriv",
      "--reuid=sandcastle",
      "--regid=sandcastle",
      "--init-groups",
      "--",
    ]);
    expect(plain?.env).toMatchObject({
      HOME: "/home/sandcastle",
      USER: "sandcastle",
    });
    expect(elevated?.argv[0]).toBe("sh");
    expect(elevated?.env).not.toHaveProperty("HOME");
  });

  it("runs commands as root in an image without the `sandcastle` user, adding nothing to their env", async () => {
    await using sandbox = await createSandbox({
      provider: modal({ image: "python:3.12" }),
      env: { A: "1" },
    });
    const before = fakeModal.execs.length;

    await sandbox.exec("echo plain");

    const [plain] = fakeModal.execs.slice(before);
    expect(plain?.argv[0]).toBe("sh");
    expect(plain?.env).toStrictEqual({ A: "1" });
  });

  it("keeps a command's stderr apart from its stdout", async () => {
    await using sandbox = await createSandbox({ provider: modal() });

    const result = await sandbox.exec({
      command: "echo one; echo oops >&2; printf two; exit 3",
      allowFailure: true,
    });
    const elsewhere = await sandbox.exec({
      command: "pwd",
      workingDirectory: "/",
    });

    expect(result).toStrictEqual({
      exitCode: 3,
      stdout: "one\ntwo",
      stderr: "oops\n",
    });
    expect(elsewhere.stdout.trim()).toBe("/");
  });

  it("kills a command and what it started on abort, resolving with exit code 143", async () => {
    await using sandbox = await createSandbox({ provider: modal() });

    const result = await sandbox.exec({
      command: "(sleep 1 && touch after) & sleep 30",
      allowFailure: true,
      abortSignal: AbortSignal.timeout(300),
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 1500);
    });

    expect(result.exitCode).toBe(143);
    await expect(sandbox.readTextFile({ path: "after" })).resolves.toBeNull();
  });

  it("reads and writes text files relative to the working directory, a missing one reading as null", async () => {
    await using sandbox = await createSandbox({ provider: modal() });

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
    // Written through stdin, by the user commands run as, so they can change it.
    expect(execsWith("cat > ")[0]?.argv[0]).toBe("setpriv");
  });

  it("terminates the sandbox and closes its client on close(), safely twice", async () => {
    const sandbox = await createSandbox({ provider: modal() });

    await sandbox.close();
    await sandbox.close();

    expect(fakeModal.terminated).toStrictEqual([sandbox.sandboxId]);
    expect(fakeModal.clientsClosed).toBe(1);
  });

  it("closes the client when Modal's create fails", async () => {
    fakeModal.createError = new Error("quota reached");

    await expect(createSandbox({ provider: modal() })).rejects.toThrow(
      /quota reached/u,
    );
    expect(fakeModal.clientsClosed).toBe(1);
  });

  it.each([
    [
      "making the working directory",
      () => {
        fakeModal.execErrors.set("mkdir -p /workspace", new Error("disk full"));
      },
    ],
    [
      "writing the state file",
      () => {
        fakeModal.writeTextError = new Error("disk full");
      },
    ],
    [
      "starting the supervisor",
      () => {
        fakeModal.execErrors.set(
          "supervisor.mjs daemon",
          new Error("disk full"),
        );
      },
    ],
  ])(
    "terminates the sandbox when creation fails after Modal made it: %s",
    async (_step, fail) => {
      fail();

      const created = createSandbox({ provider: modal() });

      await expect(created).rejects.toThrow(CreateSandboxError);
      await expect(created).rejects.toThrow(/disk full/u);
      expect(fakeModal.terminated).toStrictEqual(["sb-1"]);
      expect(fakeModal.clientsClosed).toBe(1);
    },
  );

  it("detaches: the supervisor runs in an exec the host never waits on and delivers a signed finish report", async () => {
    const hook = await finishReportReceiver();
    receivers.push(hook);
    const secret = "whsec_c2FuZGNhc3RsZS1kYXl0b25hLXRlc3Qtc2VjcmV0";
    const sandbox = await createSandbox({
      provider: modal(),
      env: { SANDBOX_TOKEN: "for-sessions" },
    });
    await sandbox.spawnSession({
      name: "implement",
      agent: answering(),
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
    expect(fakeModal.terminated).toStrictEqual([]);
    expect(execsWith("supervisor.mjs daemon")).toHaveLength(1);
  });

  it("reuses a sandbox after its report: a reattached handle restarts the supervisor and reports again", async () => {
    const hook = await finishReportReceiver();
    receivers.push(hook);
    const secret = "whsec_c2FuZGNhc3RsZS1kYXl0b25hLXRlc3Qtc2VjcmV0";
    const step = async (sandbox: DetachableSandbox) => {
      await sandbox.spawnSession({
        name: "step",
        agent: answering(),
        prompt: "Reply in <answer> tags.",
        output: ANSWER,
        completionTimeoutSeconds: 2,
      });
      return sandbox.detach({ finishReport: { url: hook.url, secret } });
    };
    const sandbox = await createSandbox({ provider: modal() });
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
    expect(execsWith("supervisor.mjs daemon")).toHaveLength(2);
  }, 30_000);

  it("reattaches by id, ignoring `create`: the kill time is the one from create, status() reads the detached run, exec gets the env passed again, and a gone sandbox is unavailable", async () => {
    const sandbox = await createSandbox({
      provider: modal(),
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
    const creates = fakeModal.createCalls.length;

    const reattached = await reattachSandbox({
      provider: modal({ image: "never-used", create: { cpu: 8 } }),
      sandboxId: receipt.sandboxId,
      env: { SANDBOX_TOKEN: "passed-again" },
    });

    expect(fakeModal.createCalls).toHaveLength(creates);
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
    expect(fakeModal.terminated).toStrictEqual([sandbox.sandboxId]);
    await expect(
      reattachSandbox({ provider: modal(), sandboxId: sandbox.sandboxId }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
    await expect(
      reattachSandbox({ provider: modal(), sandboxId: "sb-never-made" }),
    ).rejects.toMatchObject({
      _tag: "SandboxUnavailableError",
      sandboxId: "sb-never-made",
    });
  });

  it("fails a reattach clearly when the state file holding the kill time is gone, never guessing one", async () => {
    const sandbox = await createSandbox({ provider: modal() });
    await sandbox.spawnSession({
      name: "implement",
      agent: answering(),
      prompt: "Work.",
    });
    await sandbox.detach();
    // Removed behind Sandcastle's back, through Modal's own client.
    const { ModalClient } = await import("modal");
    const found = await new ModalClient().sandboxes.fromId(sandbox.sandboxId);
    await found.filesystem.remove("/var/lib/sandcastle/sandbox.json");

    await expect(
      reattachSandbox({ provider: modal(), sandboxId: sandbox.sandboxId }),
    ).rejects.toThrow(/kill time is unknown/u);
  });
});
