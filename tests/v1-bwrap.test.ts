import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DetachableSandbox, Sandbox } from "@ai-hero/sandcastle/v1";
import {
  CreateSandboxError,
  createSandbox,
  reattachSandbox,
  SandboxUnavailableError,
  verifyFinishReport,
} from "@ai-hero/sandcastle/v1";
import { bwrap } from "@ai-hero/sandcastle/v1/sandboxes/bwrap";
import {
  ANSWER,
  answeringAgent,
  bwrapSkipsHere,
  hangingAgent,
} from "./helpers/bwrapAgents.js";
import {
  detachFromNewProcess,
  eventually,
  exists,
  isGone,
  processesMentioning,
  someProcessMentions,
} from "./helpers/bwrapHost.js";
import type { FinishReportReceiver } from "./helpers/finishReportReceiver.js";
import { finishReportReceiver } from "./helpers/finishReportReceiver.js";
import { providerContract } from "./helpers/providerContract.js";

// bwrap() through its subpath, on the real Bubblewrap: skipped off Linux and
// where bwrap is missing, but a missing bwrap fails when CI is set. Each test
// gets its own XDG_STATE_HOME, so the sandboxes' folders (and their
// keepers) are its own.

const SECRET = "whsec_c2FuZGNhc3RsZS1id3JhcC10ZXN0LXNlY3JldA==";
const INTERFACES =
  'node -e \'console.log(Object.keys(require("os").networkInterfaces()).sort().join(","))\'';

/** A bwrap() sandbox reattached by id, failing the test when its supervisor isn't there. */
const reattachOrFail = async (
  sandboxId: string,
): Promise<DetachableSandbox> => {
  const handle = await reattachSandbox({ provider: bwrap(), sandboxId });
  if (handle === undefined) {
    throw new Error("the supervisor should be there");
  }
  return handle;
};

describe.skipIf(bwrapSkipsHere())("bwrap() (v1)", () => {
  let state = "";
  let receivers: FinishReportReceiver[] = [];
  const opened: Sandbox[] = [];
  const originalState = process.env["XDG_STATE_HOME"];
  const originalPath = process.env["PATH"];

  const sandboxesDir = (): string =>
    path.join(state, "sandcastle", "sandboxes");
  const leftBehind = async (): Promise<string[]> =>
    readdir(sandboxesDir()).catch(() => []);

  beforeEach(async () => {
    state = await mkdtemp(path.join(tmpdir(), "v1-bwrap-state-"));
    process.env["XDG_STATE_HOME"] = state;
  });

  afterEach(async () => {
    process.env["PATH"] = originalPath;
    await Promise.all(opened.splice(0).map(async (made) => made.close()));
    await Promise.all(receivers.map(async (made) => made.close()));
    receivers = [];
    // Anything a test left open is closed through its keeper.
    const left = await leftBehind();
    await Promise.all(
      left.map(async (sandboxId) =>
        reattachSandbox({ provider: bwrap(), sandboxId }).then(
          async (handle) => handle?.close(),
          () => undefined,
        ),
      ),
    );
    // Nothing is left behind: every keeper has exited.
    await eventually(async () => {
      const running = await someProcessMentions(state);
      return !running;
    }, 10_000);
    process.env["XDG_STATE_HOME"] = originalState;
    await rm(state, { recursive: true, force: true });
  });

  providerContract(async (env) => {
    const sandbox = await createSandbox({ provider: bwrap(), env });
    opened.push(sandbox);
    return sandbox;
  });

  it("creates a detachable sandbox with an empty working directory in its own folder, and a kill time of the time limit", async () => {
    const before = Date.now();
    await using sandbox = await createSandbox({
      provider: bwrap(),
      timeLimitMinutes: 90,
    });

    expect(sandbox.canDetach).toBe(true);
    expect(sandbox.sandboxId).toMatch(/^bwrap-[0-9a-f]{16}$/u);
    expect(sandbox.workingDirectory).toBe("/home/agent/workspace");
    expect(sandbox.native.stateDirectory).toBe(
      path.join(sandboxesDir(), sandbox.sandboxId),
    );
    const limit = sandbox.killTime.getTime() - before;
    expect(limit).toBeGreaterThanOrEqual(90 * 60_000 - 1000);
    expect(limit).toBeLessThanOrEqual(90 * 60_000 + 60_000);
    await expect(sandbox.exec("ls -A")).resolves.toMatchObject({ stdout: "" });
    await expect(sandbox.exec('printf %s "$HOME"')).resolves.toMatchObject({
      stdout: "/home/agent",
    });
  });

  it('shares the host network by default, and gives `network: "none"` only a loopback', async () => {
    await using shared = await createSandbox({ provider: bwrap() });
    await using none = await createSandbox({
      provider: bwrap({ create: { network: "none" } }),
    });

    const sharedInterfaces = await shared.exec(INTERFACES);
    const noneInterfaces = await none.exec(INTERFACES);

    expect(sharedInterfaces.stdout.trim()).not.toBe("lo");
    expect(noneInterfaces.stdout).toBe("lo\n");
  });

  it("keeps the fields Sandcastle sets out of `create`", () => {
    // Types only: nothing is created.
    const typed = () => [
      // @ts-expect-error env goes to createSandbox, then to each command
      bwrap({ create: { env: { A: "1" } } }),
      // @ts-expect-error the time limit is createSandbox's timeLimitMinutes
      bwrap({ create: { timeLimitMinutes: 5 } }),
      // @ts-expect-error nothing of the host's is mounted: clone repos in
      bwrap({ create: { mounts: [{ hostPath: "/repo" }] } }),
      // @ts-expect-error there's no current-directory opt-in either
      bwrap({ create: { cwd: "/repo" } }),
      // @ts-expect-error the network is shared or none
      bwrap({ create: { network: "bridge" } }),
    ];

    expect(typed).toBeTypeOf("function");
  });

  it("refuses a toolchain path that would show the home folder, or isn't absolute", () => {
    expect(() => bwrap({ create: { toolchainPaths: [homedir()] } })).toThrow(
      /home folder/u,
    );
    expect(() => bwrap({ create: { toolchainPaths: ["/"] } })).toThrow(
      /home folder/u,
    );
    expect(() => bwrap({ create: { toolchainPaths: ["opt/tool"] } })).toThrow(
      /absolute/u,
    );
  });

  it("shows nothing of the caller's: not its checkout, its home or its tmp, and the host toolchain only read-only", async () => {
    const callerTmp = await mkdtemp(path.join(tmpdir(), "v1-bwrap-caller-"));
    await writeFile(path.join(callerTmp, "secret.txt"), "the caller's");
    await using sandbox = await createSandbox({ provider: bwrap() });
    const visible = async (hostPath: string): Promise<boolean> => {
      const test = await sandbox.exec({
        command: `test -e ${JSON.stringify(hostPath)}`,
        allowFailure: true,
      });
      return test.exitCode === 0;
    };
    const home = homedir();
    // Only the folders on the host PATH that hold the toolchain may show
    // through the home: the first step down to each.
    const toolchainSteps = new Set(
      String(originalPath)
        .split(":")
        .filter((dir) => dir.startsWith(`${home}/`))
        .map((dir) => dir.slice(home.length + 1).split("/")[0]),
    );

    const homeListing = await sandbox.exec({
      command: `ls -A ${JSON.stringify(home)}`,
      allowFailure: true,
    });
    const writeToolchain = await sandbox.exec({
      command: 'touch "$(dirname "$(command -v node)")/sandcastle-probe"',
      allowFailure: true,
    });
    const seen = {
      checkout: await visible(process.cwd()),
      checkoutFile: await visible(path.join(process.cwd(), "package.json")),
      callerTmp: await visible(path.join(callerTmp, "secret.txt")),
      stateFolder: await visible(sandbox.native.stateDirectory),
    };
    await rm(callerTmp, { recursive: true, force: true });

    expect(seen).toStrictEqual({
      checkout: false,
      checkoutFile: false,
      callerTmp: false,
      stateFolder: false,
    });
    const shown = homeListing.stdout.split("\n").filter((name) => name !== "");
    expect(shown.filter((name) => !toolchainSteps.has(name))).toStrictEqual([]);
    expect(writeToolchain.exitCode).not.toBe(0);
  });

  it("runs `sudo` commands as root in the sandbox's own user namespace, with the host's folders still read-only", async () => {
    await using sandbox = await createSandbox({ provider: bwrap() });

    const root = await sandbox.exec({ command: "id -u", sudo: true });
    const writeUsr = await sandbox.exec({
      command: "touch /usr/sandcastle-probe",
      sudo: true,
      allowFailure: true,
    });
    await sandbox.exec({ command: "touch made-by-root", sudo: true });

    expect(root.stdout.trim()).toBe("0");
    expect(writeUsr.exitCode).not.toBe(0);
    // Root in there is this user out here: what it makes, the sandbox's user owns.
    await expect(sandbox.exec("test -O made-by-root")).resolves.toMatchObject({
      exitCode: 0,
    });
  });

  it("gives every command the sandbox's env and its own, never through the create step or a command line", async () => {
    const secret = "tok-6b1f0c2e9a-bwrap";
    await using sandbox = await createSandbox({
      provider: bwrap(),
      env: { SANDBOX_TOKEN: secret },
    });

    const result = await sandbox.exec({
      command: 'printf "%s|%s" "$SANDBOX_TOKEN" "$ONE_OFF"',
      env: { ONE_OFF: "it's here" },
    });
    const running = sandbox.exec({
      command: "sleep 31413",
      env: { ONE_OFF: secret },
      allowFailure: true,
      abortSignal: AbortSignal.timeout(20_000),
    });
    await eventually(async () => someProcessMentions("31413"), 10_000);
    const mentioning = await processesMentioning(secret);
    const metadata = await readFile(
      path.join(sandbox.native.stateDirectory, "sandbox.json"),
      "utf8",
    );
    await sandbox.close();
    await running.catch(() => undefined);

    expect(result.stdout).toBe(`${secret}|it's here`);
    expect(mentioning).toStrictEqual([]);
    expect(metadata).not.toContain(secret);
  });

  it("closes a command's stdin, and keeps its stderr apart from its stdout", async () => {
    await using sandbox = await createSandbox({ provider: bwrap() });

    const result = await sandbox.exec({
      command: "cat; echo one; echo oops >&2; echo two; exit 3",
      allowFailure: true,
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
    await using sandbox = await createSandbox({ provider: bwrap() });
    const big = "line of a big file\n".repeat(50_000);

    await sandbox.writeTextFile({ path: "notes/plan.md", content: "# Plan" });
    await sandbox.writeTextFile({ path: "big.txt", content: big });

    await expect(sandbox.exec("cat notes/plan.md")).resolves.toMatchObject({
      stdout: "# Plan",
    });
    await expect(
      sandbox.readTextFile({
        path: `${sandbox.workingDirectory}/notes/plan.md`,
      }),
    ).resolves.toBe("# Plan");
    await expect(sandbox.readTextFile({ path: "big.txt" })).resolves.toBe(big);
    await expect(
      sandbox.readTextFile({ path: "missing.md" }),
    ).resolves.toBeNull();
  });

  it("kills the commands and removes the sandbox's folder on close(), and a second close() does nothing", async () => {
    const sandbox = await createSandbox({ provider: bwrap() });
    const running = sandbox.exec({
      command: "sleep 31417",
      allowFailure: true,
    });
    await eventually(async () => someProcessMentions("31417"), 10_000);

    await sandbox.close();
    await sandbox.close();

    // Killed, as a shell reports SIGKILL.
    await expect(running).resolves.toMatchObject({ exitCode: 137 });
    await expect(exists(sandbox.native.stateDirectory)).resolves.toBe(false);
    await expect(processesMentioning("31417")).resolves.toStrictEqual([]);
    await expect(
      reattachSandbox({ provider: bwrap(), sandboxId: sandbox.sandboxId }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("ends the sandbox at its kill time, whoever holds it: its commands are killed and its folder removed", async () => {
    const sandbox = await createSandbox({
      provider: bwrap(),
      timeLimitMinutes: 0.15,
    });
    opened.push(sandbox);
    const running = sandbox.exec({
      command: "sleep 31415",
      allowFailure: true,
    });
    await eventually(async () => someProcessMentions("31415"), 10_000);

    await eventually(
      async () => isGone(sandbox.native.stateDirectory),
      sandbox.killTime.getTime() - Date.now() + 15_000,
    );

    expect(Date.now()).toBeGreaterThanOrEqual(sandbox.killTime.getTime());
    await expect(running).resolves.toMatchObject({ exitCode: 137 });
    await expect(processesMentioning("31415")).resolves.toStrictEqual([]);
    await expect(
      reattachSandbox({ provider: bwrap(), sandboxId: sandbox.sandboxId }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  }, 60_000);

  it("removes the sandbox's folder when creation fails after making it", async () => {
    // node isn't on this PATH, so the toolchain check fails once the folder exists.
    process.env["PATH"] = "/usr/bin:/bin";

    const created = createSandbox({ provider: bwrap() });

    await expect(created).rejects.toThrow(CreateSandboxError);
    await expect(created).rejects.toThrow(/has no node/u);
    await expect(leftBehind()).resolves.toStrictEqual([]);
  });

  it("removes the sandbox's folder and stops its keeper when creation is aborted", async () => {
    const controller = new AbortController();
    const created = createSandbox({
      provider: bwrap(),
      abortSignal: controller.signal,
    });
    controller.abort();

    await expect(created).rejects.toThrow(CreateSandboxError);
    await eventually(async () => {
      const left = await leftBehind();
      return left.length === 0;
    }, 10_000);
    await expect(processesMentioning(sandboxesDir())).resolves.toStrictEqual(
      [],
    );
  });

  it("detaches: the run carries on under the keeper after the process that created the sandbox exits, and delivers a signed finish report", async () => {
    const hook = await finishReportReceiver();
    receivers.push(hook);

    const receipt = await detachFromNewProcess(hook.url, SECRET);
    const delivery = await hook.first();
    const report = await verifyFinishReport({
      body: delivery.body,
      headers: delivery.headers,
      secret: SECRET,
      outputs: { implement: ANSWER },
    });
    const reattached = await reattachOrFail(receipt.sandboxId);

    expect(report.data).toMatchObject({
      status: "succeeded",
      sandboxId: receipt.sandboxId,
      detachId: receipt.detachId,
    });
    await expect(reattached.status()).resolves.toMatchObject({
      detached: { detachId: receipt.detachId },
    });
    await reattached.close();
    await expect(
      reattachSandbox({ provider: bwrap(), sandboxId: receipt.sandboxId }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  }, 60_000);

  it("reuses a sandbox after its report: a reattached handle restarts the supervisor under the keeper and reports again", async () => {
    const hook = await finishReportReceiver();
    receivers.push(hook);
    const step = async (sandbox: DetachableSandbox) => {
      await sandbox.spawnSession({
        name: "step",
        agent: answeringAgent(),
        prompt: "Reply in <answer> tags.",
        output: ANSWER,
        completionTimeoutSeconds: 2,
      });
      return sandbox.detach({
        finishReport: { url: hook.url, secret: SECRET },
      });
    };
    const sandbox = await createSandbox({ provider: bwrap() });
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
  }, 60_000);

  it("reattaches by id, ignoring `create`: status() reads the detached run, exec gets the env passed again, and a gone sandbox is unavailable", async () => {
    const sandbox = await createSandbox({
      provider: bwrap(),
      env: { SANDBOX_TOKEN: "for-sessions" },
    });
    await sandbox.spawnSession({
      name: "implement",
      agent: hangingAgent(),
      prompt: "Work.",
    });
    const receipt = await sandbox.detach();

    const reattached = await reattachSandbox({
      provider: bwrap({ create: { network: "none" } }),
      sandboxId: receipt.sandboxId,
      env: { SANDBOX_TOKEN: "passed-again" },
    });

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
    ).resolves.toMatchObject({ stdout: "passed-again" });
    // `create` is ignored: the sandbox keeps the network it was made with.
    const interfaces = await reattached?.exec(INTERFACES);
    expect(interfaces?.stdout.trim()).not.toBe("lo");

    await reattached?.close();
    await expect(exists(sandbox.native.stateDirectory)).resolves.toBe(false);
    await expect(
      reattachSandbox({ provider: bwrap(), sandboxId: sandbox.sandboxId }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
    await expect(
      reattachSandbox({
        provider: bwrap(),
        sandboxId: "bwrap-0000000000000000",
      }),
    ).rejects.toMatchObject({
      _tag: "SandboxUnavailableError",
      sandboxId: "bwrap-0000000000000000",
    });
  }, 30_000);
});
