import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  bwrapStateDirs,
  leftoverBwrap,
  observeWorldBwraps,
  worldBwrapSandboxes,
} from "./nativeSandboxes.ts";
import type { Proc } from "./nativeSandboxes.ts";

const worldDir = "/tmp/sandcastle-verify/20261031-120000-aaaa";

const proc = (
  [pid, ppid]: [number, number],
  comm: string,
  cmdline: string[] = [comm],
): Proc => ({ pid, ppid, comm, cmdline });

describe("worldBwrapSandboxes", () => {
  it("finds the sandboxed command of a bwrap that mounts the world", () => {
    const procs = [
      proc([10, 1], "node"),
      proc([11, 10], "bwrap", [
        "bwrap",
        "--bind",
        `${worldDir}/tmp/sandcastle-bwrap-x/home`,
        "/home/agent",
        "sh",
        "-c",
        "claude",
      ]),
      proc([12, 11], "bwrap"),
      proc([13, 12], "sh"),
      proc([14, 13], "claude"),
    ];
    expect(worldBwrapSandboxes(procs, worldDir)).toStrictEqual([
      { bwrapPid: 11, sandboxed: [13] },
    ]);
  });

  it("ignores a bwrap that mounts nothing in the world", () => {
    const procs = [
      proc([11, 1], "bwrap", [
        "bwrap",
        "--bind",
        "/tmp/sandcastle-verify/20261031-120000-bbbb/project",
        "/x",
      ]),
      proc([12, 11], "sh"),
    ];
    expect(worldBwrapSandboxes(procs, worldDir)).toStrictEqual([]);
  });

  it("lists a world's bwrap whose command has already exited", () => {
    const procs = [
      proc([11, 1], "bwrap", [
        "bwrap",
        "--bind",
        `${worldDir}/p`,
        `${worldDir}/p`,
      ]),
      proc([12, 11], "bwrap"),
    ];
    expect(worldBwrapSandboxes(procs, worldDir)).toStrictEqual([
      { bwrapPid: 11, sandboxed: [] },
    ]);
  });
});

describe("bwrapStateDirs", () => {
  it("picks bwrap()'s private dirs out of a temp dir listing", () => {
    expect(
      bwrapStateDirs(["sandcastle-bwrap-Ab12", "sandcastle-git-1", "other"]),
    ).toStrictEqual(["sandcastle-bwrap-Ab12"]);
  });
});

const bwrapWorks =
  spawnSync("bwrap", ["--ro-bind", "/", "/", "true"]).status === 0;
const ci = process.env["CI"] !== undefined && process.env["CI"] !== "";

describe.skipIf(!bwrapWorks && !ci)("a live bwrap of a world", () => {
  let dir: string;
  let child: ChildProcess;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "native-sandboxes-test-"));
    await mkdir(join(dir, "tmp", "sandcastle-bwrap-abc"), { recursive: true });
    child = spawn(
      "bwrap",
      [
        "--ro-bind",
        "/",
        "/",
        "--bind",
        join(dir, "tmp"),
        join(dir, "tmp"),
        "--clearenv",
        "--setenv",
        "DECLARED_KEY",
        "passed-in",
        "--unshare-all",
        "--die-with-parent",
        "sleep",
        "30",
      ],
      { env: { ...process.env, CANARY_HOST: "canary-xyz" }, stdio: "ignore" },
    );
    // Wait until the sandboxed `sleep` exists.
    await vi.waitFor(async () => {
      const found = await observeWorldBwraps(dir, ctx, new Set());
      if (found.length !== 1) {
        throw new Error("the sandboxed command isn't running yet");
      }
    });
  });

  afterAll(async () => {
    child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = {
    declared: new Set(["DECLARED_KEY"]),
    hostSecrets: new Map<string, string>(),
    canary: "canary-xyz",
  };

  it("observes the env the sandboxed command got, not bwrap's own", async () => {
    const [obs] = await observeWorldBwraps(dir, ctx, new Set());
    // bwrap sets PWD itself; CANARY_HOST stays in bwrap's own environ.
    expect(new Set(obs?.envNames)).toStrictEqual(
      new Set(["DECLARED_KEY", "PWD"]),
    );
    expect(obs?.leaks).toStrictEqual([]);
  });

  it("observes each bwrap once", async () => {
    const seen = new Set<string>();
    await expect(observeWorldBwraps(dir, ctx, seen)).resolves.toHaveLength(1);
    await expect(observeWorldBwraps(dir, ctx, seen)).resolves.toHaveLength(0);
  });

  it("reports the running bwrap and the private dir as left behind", async () => {
    const { leaks } = await leftoverBwrap(dir, join(dir, "tmp"));
    expect(leaks).toHaveLength(2);
    expect(leaks.join("\n")).toMatch(/bwrap process \d+ still running/u);
    expect(leaks.join("\n")).toMatch(/sandcastle-bwrap-abc/u);
  });

  it("reports nothing once the bwrap has exited and its dir is gone", async () => {
    child.kill("SIGKILL");
    await rm(join(dir, "tmp", "sandcastle-bwrap-abc"), { recursive: true });
    await expect
      .poll(async () => {
        const { leaks } = await leftoverBwrap(dir, join(dir, "tmp"));
        return leaks;
      })
      .toStrictEqual([]);
  });
});
