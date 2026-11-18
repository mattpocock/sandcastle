import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DetachableSandbox } from "@ai-hero/sandcastle/v1";
import {
  CreateSandboxError,
  createSandbox,
  Output,
  reattachSandbox,
  SandboxUnavailableError,
  verifyFinishReport,
} from "@ai-hero/sandcastle/v1";
import { docker } from "@ai-hero/sandcastle/v1/sandboxes/docker";
import { fakeAgent } from "@ai-hero/sandcastle/v1/testing";
import { z } from "zod";
import { detachDockerFromChild } from "./helpers/detachDockerFromChild.js";
import type { FakeDocker } from "./helpers/fakeDocker.js";
import { installFakeDocker } from "./helpers/fakeDocker.js";
import type { FinishReportReceiver } from "./helpers/finishReportReceiver.js";
import { finishReportReceiver } from "./helpers/finishReportReceiver.js";
import { providerContract } from "./helpers/providerContract.js";

// docker() through its subpath, against a fake `docker` CLI first on PATH
// (tests/helpers/fakeDockerCli.ts) whose containers are host directories
// running real `sh` processes, so createSandbox starts the real session
// supervisor in them. The fake needs POSIX process groups, so these skip on
// Windows. tests/local/v1-docker.test.ts runs a smaller suite on a real engine.

const IMAGE = "sandcastle-test:node";
const SECRET = "whsec_c2FuZGNhc3RsZS1kYXl0b25hLXRlc3Qtc2VjcmV0";

const ANSWER = Output.object({
  tag: "answer",
  schema: z.object({ answer: z.number() }),
});

/** A step that prints its answer, then hangs until the completion timeout ends it. */
const answeringSession = {
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
  completionTimeoutSeconds: 2,
};

const reattachOrFail = async (
  sandboxId: string,
): Promise<DetachableSandbox> => {
  const handle = await reattachSandbox({
    provider: docker({ image: IMAGE }),
    sandboxId,
  });
  if (handle === undefined) {
    throw new Error("the supervisor should be there");
  }
  return handle;
};

describe.skipIf(process.platform === "win32")("docker() (v1)", () => {
  let fake: FakeDocker;
  let receivers: FinishReportReceiver[] = [];

  beforeEach(async () => {
    fake = await installFakeDocker();
  });

  afterEach(async () => {
    await fake.cleanup();
    await Promise.all(receivers.map(async (made) => made.close()));
    receivers = [];
  });

  providerContract(async (env) =>
    createSandbox({ provider: docker({ image: IMAGE }), env }),
  );

  it("starts the container detached with --rm, a keep-alive entrypoint that ends at the kill time, and `create` as flags", async () => {
    await using sandbox = await createSandbox({
      provider: docker({
        image: IMAGE,
        create: {
          network: ["none"],
          cpus: 1.5,
          memory: "2g",
          pidsLimit: 256,
          user: "1000:1000",
          labels: { run: "r-1" },
          capAdd: ["SYS_PTRACE"],
          capDrop: ["NET_RAW", "MKNOD"],
        },
      }),
      timeLimitMinutes: 90,
    });

    const epoch = String(sandbox.killTime.getTime() / 1000);
    expect(sandbox.canDetach).toBe(true);
    await expect(fake.lastRun()).resolves.toStrictEqual([
      "run",
      "-d",
      "--rm",
      "--init",
      "--name",
      expect.stringMatching(/^sandcastle-/u),
      "--network",
      "none",
      "--cpus",
      "1.5",
      "--memory",
      "2g",
      "--memory-swap",
      "2g",
      "--pids-limit",
      "256",
      "--user",
      "1000:1000",
      "--label",
      "run=r-1",
      "--cap-add",
      "SYS_PTRACE",
      "--cap-drop",
      "NET_RAW",
      "--cap-drop",
      "MKNOD",
      "--label",
      `sandcastle.kill-time=${sandbox.killTime.toISOString()}`,
      "--entrypoint",
      "sh",
      IMAGE,
      "-c",
      expect.stringContaining("exec sleep"),
      "sh",
      epoch,
    ]);
  });

  it("sets the kill time from the time limit, and the engine ends the sandbox at it", async () => {
    const before = Date.now();
    const sandbox = await createSandbox({
      provider: docker({ image: IMAGE }),
      timeLimitMinutes: 2 / 60,
    });

    expect(sandbox.killTime.getTime()).toBeGreaterThanOrEqual(before + 2000);
    expect(sandbox.killTime.getTime()).toBeLessThanOrEqual(before + 3000);
    await delay(sandbox.killTime.getTime() - Date.now() + 1500);
    await expect(fake.containers()).resolves.toStrictEqual([]);
    await expect(
      reattachSandbox({
        provider: docker({ image: IMAGE }),
        sandboxId: sandbox.sandboxId,
      }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("takes only the settings Sandcastle doesn't control", () => {
    // Types only: nothing is created.
    const typed = () => [
      // @ts-expect-error there's no default image
      docker({}),
      // @ts-expect-error nothing of the host is mounted
      docker({ image: IMAGE, mounts: [{ hostPath: "/", sandboxPath: "/h" }] }),
      // @ts-expect-error nothing of the host is mounted
      docker({ image: IMAGE, create: { volumes: ["/:/host"] } }),
      // @ts-expect-error env goes to createSandbox, then to each command
      docker({ image: IMAGE, create: { env: { A: "1" } } }),
      // @ts-expect-error the entrypoint is the keep-alive that ends the container
      docker({ image: IMAGE, create: { entrypoint: "bash" } }),
    ];

    expect(typed).toBeTypeOf("function");
  });

  it("refuses to make a provider without an image", () => {
    expect(() => docker({ image: "" })).toThrow(/`image` is required/u);
  });

  it("gives every command its env through a file it removes, never through docker run or a command line", async () => {
    const secret = "tok-6b1f0c2e9a";
    await using sandbox = await createSandbox({
      provider: docker({ image: IMAGE }),
      env: { SANDBOX_TOKEN: secret },
    });

    const result = await sandbox.exec({
      command: 'printf "%s|%s" "$SANDBOX_TOKEN" "$ONE_OFF"',
      env: { ONE_OFF: "it's here" },
    });
    const later = await sandbox.exec('printf %s "$SANDBOX_TOKEN"');

    expect(result.stdout).toBe(`${secret}|it's here`);
    expect(later.stdout).toBe(secret);
    const calls = await fake.calls();
    expect(
      calls.filter((argv) => argv.join(" ").includes(secret)),
    ).toStrictEqual([]);
    const envFiles = await fake.envFiles();
    expect(envFiles).not.toHaveLength(0);
    expect(envFiles.filter(({ exists }) => exists)).toStrictEqual([]);
  });

  it("refuses an env value with a line break, which an env file can't carry", async () => {
    await using sandbox = await createSandbox({
      provider: docker({ image: IMAGE }),
    });

    await expect(
      sandbox.exec({ command: "true", env: { KEY: "line1\nline2" } }),
    ).rejects.toThrow(/line break/u);
  });

  // A provider's stdin and onLine aren't on the public exec. Files are
  // written through `docker exec -i`'s stdin (tested below), and the session
  // supervisor's client streams its replies through onLine, which every
  // session and detach test here depends on.
  it("keeps a command's stderr apart from its stdout, with its exit code, and runs it as root with sudo", async () => {
    await using sandbox = await createSandbox({
      provider: docker({ image: IMAGE }),
    });

    const result = await sandbox.exec({
      command: "echo one; echo oops >&2; printf tail; exit 3",
      allowFailure: true,
    });
    const root = await sandbox.exec({
      command: 'printf %s "$HOME"',
      sudo: true,
    });

    expect(result).toStrictEqual({
      exitCode: 3,
      stdout: "one\ntail",
      stderr: "oops\n",
    });
    expect(root.stdout).toMatch(/root$/u);
    const execs = await fake.callsOf("exec");
    expect(execs.filter((argv) => argv.includes("--user"))).toStrictEqual([
      expect.arrayContaining(["exec", "-i", "--user", "root"]),
    ]);
  });

  it("kills a command's whole process group in the container when its abort signal fires", async () => {
    await using sandbox = await createSandbox({
      provider: docker({ image: IMAGE }),
    });
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 500);

    const result = await sandbox.exec({
      command: "sleep 2 && echo too-late > late.txt",
      allowFailure: true,
      abortSignal: controller.signal,
    });
    await delay(2500);

    expect(result.exitCode).toBe(143);
    await expect(
      sandbox.readTextFile({ path: "late.txt" }),
    ).resolves.toBeNull();
  }, 15_000);

  it("reads and writes text files relative to the working directory, a missing one reading as null", async () => {
    await using sandbox = await createSandbox({
      provider: docker({ image: IMAGE }),
    });

    await sandbox.writeTextFile({ path: "notes/plan.md", content: "# Plan\n" });

    expect(sandbox.workingDirectory).toMatch(/\/workspace$/u);
    await expect(sandbox.exec("cat notes/plan.md")).resolves.toMatchObject({
      stdout: "# Plan\n",
    });
    await expect(
      sandbox.readTextFile({
        path: `${sandbox.workingDirectory}/notes/plan.md`,
      }),
    ).resolves.toBe("# Plan\n");
    await expect(
      sandbox.readTextFile({ path: "missing.md" }),
    ).resolves.toBeNull();
  });

  it("removes the container on close(), and a second close() does nothing", async () => {
    const sandbox = await createSandbox({ provider: docker({ image: IMAGE }) });

    await sandbox.close();
    await sandbox.close();

    await expect(fake.callsOf("rm")).resolves.toStrictEqual([
      ["rm", "-f", sandbox.sandboxId],
    ]);
    await expect(fake.containers()).resolves.toStrictEqual([]);
  });

  it.each([
    [
      "the container starts but its working directory can't be made",
      "mkdir -p",
    ],
    ["docker run fails after making the container", "run"],
  ])(
    "removes the container when creation fails partway: %s",
    async (_case, execFails) => {
      await fake.fault({ execFails });

      const created = createSandbox({ provider: docker({ image: IMAGE }) });

      await expect(created).rejects.toThrow(CreateSandboxError);
      await expect(created).rejects.toThrow(/failed/u);
      await expect(fake.containers()).resolves.toStrictEqual([]);
      const run = await fake.lastRun();
      const name = run[run.indexOf("--name") + 1];
      await expect(fake.calls()).resolves.toContainEqual(["rm", "-f", name]);
    },
  );

  it("says to start Docker when the daemon is down", async () => {
    await fake.fault({ daemonDown: true });

    await expect(
      createSandbox({ provider: docker({ image: IMAGE }) }),
    ).rejects.toThrow(/can't reach its engine\. Start Docker Desktop/u);
  });

  it("says so when there's no docker CLI on PATH", async () => {
    const path = process.env["PATH"];
    process.env["PATH"] = "/nonexistent";
    try {
      await expect(
        createSandbox({ provider: docker({ image: IMAGE }) }),
      ).rejects.toThrow(/no `docker` CLI on PATH/u);
    } finally {
      process.env["PATH"] = path;
    }
  });

  it("mounts nothing of the host: docker run gets no volume, mount or env flag, and no host path", async () => {
    await using _sandbox = await createSandbox({
      provider: docker({ image: IMAGE }),
      env: { SANDBOX_TOKEN: "tok" },
    });

    const run = await fake.lastRun();
    expect(
      run.filter((arg) =>
        /^(?:-v|--volume|--mount|-e|--env|--env-file|--volumes-from|-w|--workdir)(?:=|$)/u.test(
          arg,
        ),
      ),
    ).toStrictEqual([]);
    expect(
      run.filter((arg) =>
        [process.cwd(), import.meta.dirname].some((host) => arg.includes(host)),
      ),
    ).toStrictEqual([]);
  });

  it("detaches: a sandbox made by a process that has since exited delivers its signed finish report", async () => {
    const hook = await finishReportReceiver();
    receivers.push(hook);

    const detached = await detachDockerFromChild({
      image: IMAGE,
      url: hook.url,
      secret: SECRET,
    });
    const delivery = await hook.first();
    const report = await verifyFinishReport({
      body: delivery.body,
      headers: delivery.headers,
      secret: SECRET,
      outputs: { implement: ANSWER },
    });

    expect(report.data).toMatchObject({
      status: "succeeded",
      sandboxId: detached.sandboxId,
      detachId: detached.detachId,
    });
    await expect(fake.containers()).resolves.toStrictEqual([
      detached.sandboxId,
    ]);
    const execs = await fake.callsOf("exec");
    const daemons = execs.filter((argv) =>
      argv.join(" ").includes("supervisor.mjs daemon"),
    );
    expect(daemons).toHaveLength(1);
    expect(daemons[0]?.[1]).toBe("-d");
  }, 30_000);

  it("reuses a sandbox after its report: a reattached handle restarts the supervisor and reports again", async () => {
    const hook = await finishReportReceiver();
    receivers.push(hook);
    const step = async (sandbox: DetachableSandbox) => {
      await sandbox.spawnSession({ name: "step", ...answeringSession });
      return sandbox.detach({
        finishReport: { url: hook.url, secret: SECRET },
      });
    };
    const sandbox = await createSandbox({ provider: docker({ image: IMAGE }) });
    const first = await step(sandbox);
    await hook.received(1);

    const reattached = await reattachOrFail(sandbox.sandboxId);
    expect(reattached.killTime).toStrictEqual(sandbox.killTime);
    const second = await step(reattached);
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
  }, 30_000);

  it("reattaches by id from another process, ignoring `create`: status() reads the detached run, exec gets the env passed again, and a gone sandbox is unavailable", async () => {
    const hook = await finishReportReceiver();
    receivers.push(hook);
    const detached = await detachDockerFromChild({
      image: IMAGE,
      url: hook.url,
      secret: SECRET,
    });
    const runs = await fake.callsOf("run");

    const reattached = await reattachSandbox({
      provider: docker({ image: "never-used", create: { memory: "1g" } }),
      sandboxId: detached.sandboxId,
      env: { SANDBOX_TOKEN: "passed-again" },
    });

    await expect(fake.callsOf("run")).resolves.toHaveLength(runs.length);
    expect(reattached?.workingDirectory).toMatch(/\/workspace$/u);
    await expect(reattached?.status()).resolves.toMatchObject({
      detached: { detachId: detached.detachId },
    });
    await expect(
      reattached?.exec('printf %s "$SANDBOX_TOKEN"'),
    ).resolves.toMatchObject({ stdout: "passed-again" });

    await reattached?.close();
    await expect(fake.containers()).resolves.toStrictEqual([]);
    await expect(
      reattachSandbox({
        provider: docker({ image: IMAGE }),
        sandboxId: detached.sandboxId,
      }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
    await expect(
      reattachSandbox({
        provider: docker({ image: IMAGE }),
        sandboxId: "never-made",
      }),
    ).rejects.toMatchObject({
      _tag: "SandboxUnavailableError",
      sandboxId: "never-made",
    });
  }, 30_000);
});
