import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
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
import { seatbelt } from "@ai-hero/sandcastle/v1/sandboxes/seatbelt";
import {
  ANSWER,
  answeringAgent,
  hangingAgent,
  seatbeltSkipsHere,
} from "./helpers/localAgents.js";
import {
  connectCommand,
  detachFromNewProcess,
  eventually,
  exists,
  hostListener,
  isGone,
  LOOKUP,
  processesMentioning,
  someProcessMentions,
} from "./helpers/localHost.js";
import type { FinishReportReceiver } from "./helpers/finishReportReceiver.js";
import { finishReportReceiver } from "./helpers/finishReportReceiver.js";
import { providerContract } from "./helpers/providerContract.js";

// seatbelt() through its subpath, on the real `sandbox-exec`: skipped off
// macOS and where sandbox-exec doesn't work, but a broken one fails when CI
// is set. The macOS CI job is where this runs. Each test gets its own
// XDG_STATE_HOME, so the sandboxes' folders (and their keepers) are its
// own. It's under /tmp, not the (long) per-user temp dir, so the keeper's
// socket path stays inside macOS's 104-byte limit.

const SECRET = "whsec_c2FuZGNhc3RsZS1zZWF0YmVsdC10ZXN0LXNlY3JldA==";

/** A seatbelt() sandbox reattached by id, failing the test when its supervisor isn't there. */
const reattachOrFail = async (
  sandboxId: string,
): Promise<DetachableSandbox> => {
  const handle = await reattachSandbox({ provider: seatbelt(), sandboxId });
  if (handle === undefined) {
    throw new Error("the supervisor should be there");
  }
  return handle;
};

describe.skipIf(seatbeltSkipsHere())("seatbelt() (v1)", () => {
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
    state = await realpath(await mkdtemp("/tmp/v1-sb-"));
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
        reattachSandbox({ provider: seatbelt(), sandboxId }).then(
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
    const sandbox = await createSandbox({ provider: seatbelt(), env });
    opened.push(sandbox);
    return sandbox;
  });

  it("creates a detachable sandbox with an empty working directory in its own folder, and a kill time of the time limit", async () => {
    const before = Date.now();
    await using sandbox = await createSandbox({
      provider: seatbelt(),
      timeLimitMinutes: 90,
    });

    expect(sandbox.canDetach).toBe(true);
    expect(sandbox.sandboxId).toMatch(/^seatbelt-[0-9a-f]{16}$/u);
    expect(sandbox.native.stateDirectory).toBe(
      path.join(sandboxesDir(), sandbox.sandboxId),
    );
    // Seatbelt can't remap paths: the sandbox's folders are at their host paths.
    expect(sandbox.workingDirectory).toBe(
      path.join(sandbox.native.stateDirectory, "home", "workspace"),
    );
    const limit = sandbox.killTime.getTime() - before;
    expect(limit).toBeGreaterThanOrEqual(90 * 60_000 - 1000);
    expect(limit).toBeLessThanOrEqual(90 * 60_000 + 60_000);
    await expect(sandbox.exec("ls -A")).resolves.toMatchObject({ stdout: "" });
    await expect(sandbox.exec('printf %s "$HOME"')).resolves.toMatchObject({
      stdout: path.join(sandbox.native.stateDirectory, "home"),
    });
  });

  it('shares the host network by default, and `network: "none"` allows no IP traffic, not even to the host loopback', async () => {
    const { server, port } = await hostListener();
    await using shared = await createSandbox({ provider: seatbelt() });
    await using none = await createSandbox({
      provider: seatbelt({ create: { network: "none" } }),
    });

    const sharedReach = await shared.exec({
      command: `${connectCommand(port)} && ${LOOKUP}`,
      allowFailure: true,
    });
    const noneReach = await none.exec({
      command: connectCommand(port),
      allowFailure: true,
    });
    server.close();

    expect(sharedReach).toMatchObject({ exitCode: 0 });
    expect(noneReach.exitCode).toBe(3);
  });

  it("keeps the fields Sandcastle sets out of `create`", () => {
    // Types only: nothing is created.
    const typed = () => [
      // @ts-expect-error env goes to createSandbox, then to each command
      seatbelt({ create: { env: { A: "1" } } }),
      // @ts-expect-error the time limit is createSandbox's timeLimitMinutes
      seatbelt({ create: { timeLimitMinutes: 5 } }),
      // @ts-expect-error nothing of the host's is mounted: clone repos in
      seatbelt({ create: { mounts: [{ hostPath: "/repo" }] } }),
      // @ts-expect-error there's no current-directory opt-in either
      seatbelt({ create: { cwd: "/repo" } }),
      // @ts-expect-error the network is shared or none
      seatbelt({ create: { network: "bridge" } }),
    ];

    expect(typed).toBeTypeOf("function");
  });

  it("shows nothing of the caller's: not its checkout, its home or its tmp, not even their metadata, and the host toolchain only read-only", async () => {
    const callerTmp = await mkdtemp(path.join(tmpdir(), "v1-seatbelt-caller-"));
    await writeFile(path.join(callerTmp, "secret.txt"), "the caller's");
    await using sandbox = await createSandbox({ provider: seatbelt() });
    const run = async (command: string): Promise<number> => {
      const result = await sandbox.exec({ command, allowFailure: true });
      return result.exitCode;
    };
    const quoted = (hostPath: string): string => JSON.stringify(hostPath);
    const checkoutFile = path.join(process.cwd(), "package.json");
    const secret = path.join(callerTmp, "secret.txt");
    const metadata = path.join(sandbox.native.stateDirectory, "sandbox.json");

    const seen = {
      checkout: await run(`ls ${quoted(process.cwd())}`),
      checkoutExists: await run(`test -e ${quoted(checkoutFile)}`),
      checkoutFile: await run(`cat ${quoted(checkoutFile)}`),
      home: await run(`ls ${quoted(homedir())}`),
      callerTmpExists: await run(`test -e ${quoted(secret)}`),
      callerTmpFile: await run(`cat ${quoted(secret)}`),
      metadata: await run(`cat ${quoted(metadata)}`),
      writeToolchain: await run(
        'touch "$(dirname "$(command -v node)")/sandcastle-probe"',
      ),
      writeUsr: await run("touch /usr/local/sandcastle-probe"),
    };
    await rm(callerTmp, { recursive: true, force: true });

    expect(
      Object.entries(seen).filter(([, exitCode]) => exitCode === 0),
    ).toStrictEqual([]);
  });

  it("can't reach its keeper's socket, which would run commands outside it", async () => {
    await using sandbox = await createSandbox({ provider: seatbelt() });
    const socket = path.join(sandbox.native.stateDirectory, "keeper.sock");

    const reach = await sandbox.exec({
      command: connectCommand(socket),
      allowFailure: true,
    });

    await expect(exists(socket)).resolves.toBe(true);
    expect(reach.exitCode).toBe(3);
  });

  it("has no root: a `sudo` command rejects, saying so", async () => {
    await using sandbox = await createSandbox({ provider: seatbelt() });

    await expect(
      sandbox.exec({ command: "id -u", sudo: true }),
    ).rejects.toThrow(/seatbelt\(\) has no root/u);
  });

  it("gives every command the sandbox's env and its own, never through the create step or a command line", async () => {
    const secret = "tok-6b1f0c2e9a-seatbelt";
    await using sandbox = await createSandbox({
      provider: seatbelt(),
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
    await using sandbox = await createSandbox({ provider: seatbelt() });

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
    await using sandbox = await createSandbox({ provider: seatbelt() });
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

  it("kills what a command left behind in its process group as the command exits", async () => {
    await using sandbox = await createSandbox({ provider: seatbelt() });

    const started = await sandbox.exec("sleep 31411 > /dev/null 2>&1 &");

    await eventually(async () => {
      const running = await someProcessMentions("31411");
      return !running;
    }, 10_000);
    expect(started.exitCode).toBe(0);
  });

  it("kills the commands, even what left their process group, and removes the sandbox's folder on close(), and a second close() does nothing", async () => {
    const sandbox = await createSandbox({ provider: seatbelt() });
    const running = sandbox.exec({
      command: "sleep 31417",
      allowFailure: true,
    });
    // A child in a session of its own, which a process-group kill misses.
    const escaping = sandbox.exec({
      command: `node -e 'require("child_process").spawn("sleep", ["31419"], { detached: true, stdio: "ignore" }); setInterval(() => {}, 1000)'`,
      allowFailure: true,
    });
    await eventually(async () => someProcessMentions("31417"), 10_000);
    await eventually(async () => someProcessMentions("31419"), 10_000);

    await sandbox.close();
    await sandbox.close();

    // Killed, as a shell reports SIGKILL.
    await expect(running).resolves.toMatchObject({ exitCode: 137 });
    await escaping;
    await expect(exists(sandbox.native.stateDirectory)).resolves.toBe(false);
    await expect(processesMentioning("31417")).resolves.toStrictEqual([]);
    await eventually(async () => {
      const left = await someProcessMentions("31419");
      return !left;
    }, 5000);
    await expect(
      reattachSandbox({ provider: seatbelt(), sandboxId: sandbox.sandboxId }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("ends the sandbox at its kill time, whoever holds it: its commands are killed and its folder removed", async () => {
    const sandbox = await createSandbox({
      provider: seatbelt(),
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
      reattachSandbox({ provider: seatbelt(), sandboxId: sandbox.sandboxId }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  }, 60_000);

  it("removes the sandbox's folder when creation fails after making it", async () => {
    // node isn't on this PATH, so the toolchain check fails once the folder exists.
    process.env["PATH"] = "/usr/bin:/bin";

    const created = createSandbox({ provider: seatbelt() });

    await expect(created).rejects.toThrow(CreateSandboxError);
    await expect(created).rejects.toThrow(/has no node/u);
    await expect(leftBehind()).resolves.toStrictEqual([]);
  });

  it("removes the sandbox's folder and stops its keeper when creation is aborted", async () => {
    const controller = new AbortController();
    const created = createSandbox({
      provider: seatbelt(),
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

    const receipt = await detachFromNewProcess("seatbelt", hook.url, SECRET);
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
      reattachSandbox({ provider: seatbelt(), sandboxId: receipt.sandboxId }),
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
    const sandbox = await createSandbox({ provider: seatbelt() });
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
      provider: seatbelt(),
      env: { SANDBOX_TOKEN: "for-sessions" },
    });
    await sandbox.spawnSession({
      name: "implement",
      agent: hangingAgent(),
      prompt: "Work.",
    });
    const receipt = await sandbox.detach();

    const reattached = await reattachSandbox({
      provider: seatbelt({ create: { network: "none" } }),
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
    await expect(
      reattached?.exec({ command: LOOKUP, allowFailure: true }),
    ).resolves.toMatchObject({ exitCode: 0 });

    await reattached?.close();
    await expect(exists(sandbox.native.stateDirectory)).resolves.toBe(false);
    await expect(
      reattachSandbox({ provider: seatbelt(), sandboxId: sandbox.sandboxId }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
    await expect(
      reattachSandbox({
        provider: seatbelt(),
        sandboxId: "seatbelt-0000000000000000",
      }),
    ).rejects.toMatchObject({
      _tag: "SandboxUnavailableError",
      sandboxId: "seatbelt-0000000000000000",
    });
    // Another provider's id, or a path, never reaches a folder.
    await expect(
      reattachSandbox({
        provider: seatbelt(),
        sandboxId: "bwrap-0000000000000000",
      }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
    await expect(
      reattachSandbox({ provider: seatbelt(), sandboxId: "../../etc" }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  }, 30_000);
});
