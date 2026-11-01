import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IsolatedSandboxHandle } from "@ai-hero/sandcastle";
import {
  createIsolatedSandboxProvider,
  createSandbox,
  createWorktree,
} from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import { setUpFakeEngine } from "./helpers/fakeEngine.js";
import type { FakeEngineWorld } from "./helpers/fakeEngine.js";

// The Sandbox handle exposes the provider's external id as `sandboxId`, so a
// supervisor outside the process can inspect or remove the sandbox with the
// vendor's own tools. docker() and podman() name their container; a fake
// `docker`/`podman` on PATH (tests/helpers/fakeEngine.ts) records the name
// each `run` was given. The fake is a POSIX shell script, so these don't run
// on Windows. vercel() and daytona() are in sandboxId.remote.test.ts.

describe.skipIf(process.platform === "win32").each([
  { engine: "docker", provider: docker },
  { engine: "podman", provider: podman },
] as const)("$engine() sandboxId", ({ engine, provider }) => {
  let world: FakeEngineWorld;

  beforeEach(() => {
    world = setUpFakeEngine(engine, "e2e-sandbox-id-");
  });

  afterEach(() => {
    world.cleanup();
  });

  /** The value after `--name` in the recorded `<engine> run`. */
  const nameFromRun = (): string | undefined => {
    const args = world.runArgs();
    return args[args.indexOf("--name") + 1];
  };

  it("createSandbox() exposes the name the container was started with", async () => {
    const sandbox = await createSandbox({
      branch: "w",
      cwd: world.repo,
      sandbox: provider(),
    });
    await sandbox.close();

    expect(sandbox.sandboxId).toMatch(/^sandcastle-/u);
    expect(sandbox.sandboxId).toBe(nameFromRun());
  }, 30_000);

  it("worktree.createSandbox() exposes it too", async () => {
    await using wt = await createWorktree({
      branchStrategy: { type: "branch", branch: "w" },
      cwd: world.repo,
    });
    const sandbox = await wt.createSandbox({ sandbox: provider() });
    await sandbox.close();

    expect(sandbox.sandboxId).toMatch(/^sandcastle-/u);
    expect(sandbox.sandboxId).toBe(nameFromRun());
  }, 30_000);
});

// An isolated provider's handle reaches the Sandbox the same way. This one
// is a local directory that runs commands in `sh`, so it doesn't run on
// Windows either.

/** A local-directory isolated provider whose handle reports `sandboxId`. */
const localIsolated = (sandboxId: string | undefined) =>
  createIsolatedSandboxProvider({
    name: "local-isolated",
    create: async (): Promise<IsolatedSandboxHandle> => {
      const root = await mkdtemp(path.join(tmpdir(), "e2e-isolated-"));
      const worktreePath = path.join(root, "workspace");
      await mkdir(worktreePath);
      return {
        worktreePath,
        ...(sandboxId === undefined ? {} : { sandboxId }),
        exec: async (command, options) => {
          const r = spawnSync("sh", ["-c", command], {
            cwd: options?.cwd ?? worktreePath,
            input: options?.stdin ?? "",
            encoding: "utf8",
          });
          for (const line of r.stdout.split("\n")) {
            if (line !== "") {
              options?.onLine?.(line);
            }
          }
          return {
            stdout: r.stdout,
            stderr: r.stderr,
            exitCode: r.status ?? 1,
          };
        },
        copyIn: async (hostPath, sandboxPath) => {
          await mkdir(path.dirname(sandboxPath), { recursive: true });
          await cp(hostPath, sandboxPath, { recursive: true });
        },
        copyFileOut: async (sandboxPath, hostPath) => {
          await mkdir(path.dirname(hostPath), { recursive: true });
          await cp(sandboxPath, hostPath);
        },
        close: async () => {
          await rm(root, { recursive: true, force: true });
        },
      };
    },
  });

describe.skipIf(process.platform === "win32")(
  "isolated provider sandboxId",
  () => {
    let repo = "";

    beforeEach(async () => {
      repo = await mkdtemp(path.join(tmpdir(), "e2e-sandbox-id-isolated-"));
      const git = (...args: string[]): void => {
        spawnSync("git", args, { cwd: repo, stdio: "ignore" });
      };
      git("init", "-b", "main");
      git("commit", "--allow-empty", "-m", "init");
    });

    afterEach(async () => {
      await rm(repo, { recursive: true, force: true });
    });

    it("createSandbox() exposes the id the handle reports", async () => {
      const sandbox = await createSandbox({
        branch: "w",
        cwd: repo,
        sandbox: localIsolated("remote-123"),
      });
      await sandbox.close();

      expect(sandbox.sandboxId).toBe("remote-123");
    }, 30_000);

    it("is undefined when the handle reports none", async () => {
      const sandbox = await createSandbox({
        branch: "w",
        cwd: repo,
        sandbox: localIsolated(undefined),
      });
      await sandbox.close();

      expect(sandbox.sandboxId).toBeUndefined();
    }, 30_000);
  },
);
