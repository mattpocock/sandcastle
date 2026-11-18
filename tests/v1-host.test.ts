import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Sandbox } from "@ai-hero/sandcastle/v1";
import {
  CreateSandboxError,
  createSandbox,
  reattachSandbox,
} from "@ai-hero/sandcastle/v1";
import type { HostNative } from "@ai-hero/sandcastle/v1/sandboxes/host";
import { host } from "@ai-hero/sandcastle/v1/sandboxes/host";
import {
  eventually,
  isGone,
  processesMentioning,
} from "./helpers/localHost.js";
import { providerContract } from "./helpers/providerContract.js";

// host() through its subpath, for real, on Linux, macOS and Windows: its
// sandboxes are folders on this machine and its commands run as this user.
// Every command here is a `node -e` script in single quotes, which runs
// unchanged everywhere: through `sh` on Linux and macOS, and spawned from its
// argv on Windows, which has no `sh`.

const isWindows = process.platform === "win32";

/** `node -e` running `script`, which must not hold a single quote. */
const node = (script: string): string => `node -e '${script}'`;

/** Runs until killed, its pid written to the file in $PID_FILE first. */
const FOREVER = node(
  'require("node:fs").writeFileSync(process.env.PID_FILE, String(process.pid)); setInterval(() => {}, 1000)',
);

/** Starts a grandchild that runs forever, writes the grandchild's pid to $PID_FILE, and runs forever too. */
const WITH_GRANDCHILD = node(
  'const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); require("node:fs").writeFileSync(process.env.PID_FILE, String(child.pid)); setInterval(() => {}, 1000)',
);

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The pid a command wrote to `file`, once it has. */
const pidIn = async (file: string): Promise<number> => {
  let pid = 0;
  await eventually(async () => {
    pid = Number(await readFile(file, "utf8").catch(() => ""));
    return pid > 0;
  }, 15_000);
  return pid;
};

const TSX_LOADER = pathToFileURL(
  createRequire(import.meta.url).resolve("tsx"),
).href;
const TESTS_TSCONFIG = path.join(import.meta.dirname, "tsconfig.json");
/** A script handed to a subprocess, not an import. */
const HOLDER = path.join(import.meta.dirname, "helpers", "holdHostSandbox.ts");

describe("host() (v1)", () => {
  let rootDir = "";
  let scratch = "";
  const opened: Sandbox<HostNative>[] = [];

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "h-"));
    scratch = await mkdtemp(path.join(tmpdir(), "s-"));
  });

  afterEach(async () => {
    await Promise.all(opened.splice(0).map(async (made) => made.close()));
    delete process.env["SANDCASTLE_HOST_CANARY"];
    await rm(rootDir, { recursive: true, force: true, maxRetries: 20 });
    await rm(scratch, { recursive: true, force: true, maxRetries: 20 });
  });

  const open = async (
    options: {
      readonly env?: Readonly<Record<string, string>>;
      readonly timeLimitMinutes?: number;
    } = {},
  ): Promise<Sandbox<HostNative>> => {
    const sandbox = await createSandbox({
      provider: host({ create: { rootDir } }),
      ...options,
    });
    opened.push(sandbox);
    return sandbox;
  };

  providerContract(async (env) => open({ env }));

  it("creates an attached-only sandbox, its folder in rootDir and its kill time the time limit away", async () => {
    const before = Date.now();
    const sandbox = await open({ timeLimitMinutes: 90 });
    const after = Date.now();

    expect(host().canDetach).toBe(false);
    expect(sandbox.canDetach).toBe(false);
    expect(sandbox.native.folder).toBe(path.join(rootDir, sandbox.sandboxId));
    await expect(readdir(sandbox.native.folder)).resolves.toStrictEqual(
      expect.arrayContaining(["workspace", "home", "tmp"]),
    );
    expect(sandbox.killTime.getTime()).toBeGreaterThanOrEqual(
      before + 90 * 60_000,
    );
    expect(sandbox.killTime.getTime()).toBeLessThanOrEqual(after + 90 * 60_000);
  });

  it("puts sandboxes in <tmpdir>/sandcastle-host by default", async () => {
    const sandbox = await createSandbox({ provider: host() });
    opened.push(sandbox);

    expect(path.dirname(sandbox.native.folder)).toBe(
      path.join(tmpdir(), "sandcastle-host"),
    );
  });

  it("keeps the fields Sandcastle sets out of `create`, and can't detach or reattach (types)", async () => {
    // Types only, past the first line: nothing is detached.
    const sandbox = await open();
    const typed = () => [
      // @ts-expect-error env goes to createSandbox, then to each command
      host({ create: { env: { A: "1" } } }),
      // @ts-expect-error the time limit comes from timeLimitMinutes
      host({ create: { timeLimitMinutes: 5 } }),
      // @ts-expect-error each sandbox starts in an empty working directory of its own
      host({ create: { cwd: "/repo" } }),
      // @ts-expect-error each sandbox starts in an empty working directory of its own
      host({ create: { workingDirectory: "/repo" } }),
      // @ts-expect-error a host() sandbox is a child of this process: it can't detach
      reattachSandbox({ provider: host(), sandboxId: "host-1" }),
    ];

    expect(typed).toBeTypeOf("function");
    // @ts-expect-error a provider without a detach capability makes handles without detach
    expect(sandbox.detach).toBeUndefined();
    await expect(
      // @ts-expect-error at runtime too
      reattachSandbox({ provider: host(), sandboxId: sandbox.sandboxId }),
    ).rejects.toThrow();
  });

  it("starts in an empty working directory, <rootDir>/<sandboxId>/workspace", async () => {
    const sandbox = await open();

    const cwd = await sandbox.exec(node("process.stdout.write(process.cwd())"));

    expect(sandbox.workingDirectory).toBe(
      path.join(rootDir, sandbox.sandboxId, "workspace"),
    );
    await expect(readdir(sandbox.workingDirectory)).resolves.toStrictEqual([]);
    await expect(realpath(cwd.stdout)).resolves.toBe(
      await realpath(sandbox.workingDirectory),
    );
  });

  it("ends the sandbox at its kill time, whoever holds it: its commands are killed and its folder removed", async () => {
    const sandbox = await open({ timeLimitMinutes: 0.05 });
    const pidFile = path.join(scratch, "pid");
    const running = sandbox.exec({
      command: FOREVER,
      env: { PID_FILE: pidFile },
      allowFailure: true,
    });
    const pid = await pidIn(pidFile);

    const ended = await running;

    expect(Date.now()).toBeGreaterThanOrEqual(sandbox.killTime.getTime());
    expect(ended.exitCode).not.toBe(0);
    await eventually(async () => isGone(sandbox.native.folder), 10_000);
    await eventually(async () => !isAlive(pid), 5000);
  }, 30_000);

  it("gives every command the sandbox's env and its own, never the command line, and nothing else of the caller's env", async () => {
    const secret = "tok-6b1f0c2e9a-host";
    process.env["SANDCASTLE_HOST_CANARY"] = "from-the-caller";
    const sandbox = await open({
      env: { SANDBOX_TOKEN: secret, HOME: "/not/the/home" },
    });

    const result = await sandbox.exec({
      command: node(
        'const e = process.env; process.stdout.write([e.SANDBOX_TOKEN, e.ONE_OFF, String(e.SANDCASTLE_HOST_CANARY), e.HOME, e.TMPDIR].join("|"))',
      ),
      env: { ONE_OFF: "its own" },
    });
    const pidFile = path.join(scratch, "pid");
    const running = sandbox.exec({
      command: FOREVER,
      env: { PID_FILE: pidFile, ONE_OFF: secret },
      allowFailure: true,
    });
    await pidIn(pidFile);
    // Off Windows, the process list: no process's command line holds it.
    const mentioning = isWindows ? [] : await processesMentioning(secret);
    await sandbox.close();
    await running;

    const folder = sandbox.native.folder;
    expect(result.stdout).toBe(
      [
        secret,
        "its own",
        "undefined",
        path.join(folder, "home"),
        path.join(folder, "tmp"),
      ].join("|"),
    );
    expect(mentioning).toStrictEqual([]);
  });

  it("closes a command's stdin, and keeps its stderr apart from its stdout", async () => {
    const sandbox = await open();

    const result = await sandbox.exec({
      command: node(
        'process.stdin.resume(); process.stdin.on("end", () => { console.log("one"); console.error("oops"); console.log("two"); process.exit(3); })',
      ),
      allowFailure: true,
    });

    expect(result).toStrictEqual({
      exitCode: 3,
      stdout: "one\ntwo\n",
      stderr: "oops\n",
    });
  });

  it("reads and writes text files relative to the working directory, a missing one reading as null", async () => {
    const sandbox = await open();
    const big = "line of a big file\n".repeat(50_000);

    await sandbox.writeTextFile({ path: "notes/plan.md", content: "# Plan" });
    await sandbox.writeTextFile({ path: "big.txt", content: big });

    await expect(
      sandbox.exec(
        node(
          'process.stdout.write(require("node:fs").readFileSync("notes/plan.md", "utf8"))',
        ),
      ),
    ).resolves.toMatchObject({ stdout: "# Plan" });
    await expect(
      sandbox.readTextFile({
        path: path.join(sandbox.workingDirectory, "notes", "plan.md"),
      }),
    ).resolves.toBe("# Plan");
    await expect(sandbox.readTextFile({ path: "big.txt" })).resolves.toBe(big);
    await expect(
      sandbox.readTextFile({ path: "missing.md" }),
    ).resolves.toBeNull();
  });

  it("has no root: a `sudo` command rejects, saying so", async () => {
    const sandbox = await open();

    await expect(
      sandbox.exec({ command: node("1"), sudo: true }),
    ).rejects.toThrow(/host\(\) has no root/u);
  });

  it("close() kills a running command's whole tree, grandchild included, and removes the folder; a second close() does nothing", async () => {
    const sandbox = await open();
    const pidFile = path.join(scratch, "pid");
    const running = sandbox.exec({
      command: WITH_GRANDCHILD,
      env: { PID_FILE: pidFile },
      allowFailure: true,
    });
    const grandchild = await pidIn(pidFile);

    await sandbox.close();
    await sandbox.close();

    const ended = await running;
    expect(ended.exitCode).not.toBe(0);
    await expect(isGone(sandbox.native.folder)).resolves.toBe(true);
    await eventually(async () => !isAlive(grandchild), 5000);
    await expect(sandbox.exec(node("1"))).rejects.toThrow(/closed/u);
  });

  it("removes the sandbox's folder when creation fails after making it", async () => {
    // No node on this PATH, so the session supervisor can't start.
    const nowhere = await mkdtemp(path.join(scratch, "empty-"));

    const created = createSandbox({
      provider: host({ create: { rootDir } }),
      env: { PATH: nowhere },
    });

    await expect(created).rejects.toThrow(CreateSandboxError);
    await expect(readdir(rootDir)).resolves.toStrictEqual([]);
  });

  it("makes nothing when creation is aborted", async () => {
    const created = createSandbox({
      provider: host({ create: { rootDir } }),
      abortSignal: AbortSignal.abort(),
    });

    await expect(created).rejects.toThrow();
    await expect(readdir(rootDir)).resolves.toStrictEqual([]);
  });

  it.each(isWindows ? ["exit"] : ["exit", "SIGTERM"])(
    "kills the commands and removes the folder when the holding process ends (%s) with work still running",
    async (ending) => {
      const pidFile = path.join(scratch, "pid");
      const child = spawn(
        process.execPath,
        [
          "--import",
          TSX_LOADER,
          HOLDER,
          rootDir,
          pidFile,
          ending === "exit" ? "exit" : "wait",
        ],
        {
          env: { ...process.env, TSX_TSCONFIG_PATH: TESTS_TSCONFIG },
          stdio: ["ignore", "pipe", "inherit"],
        },
      );
      const exited = once(child, "exit");
      const [line] = (await once(child.stdout, "data")) as [Buffer];
      const { folder } = JSON.parse(line.toString()) as { folder: string };
      const pid = await pidIn(pidFile);
      if (ending === "SIGTERM") {
        child.kill("SIGTERM");
      }
      await exited;

      await eventually(async () => isGone(folder), 15_000);
      await eventually(async () => !isAlive(pid), 5000);
      expect(path.dirname(folder)).toBe(rootDir);
    },
    40_000,
  );
});
