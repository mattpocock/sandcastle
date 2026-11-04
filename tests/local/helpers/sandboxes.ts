import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  BindMountSandboxHandle,
  ExecResult,
  SandboxProvider,
} from "@ai-hero/sandcastle";
import { inject, onTestFinished } from "vitest";
import { command } from "./command.js";
import type { Engine, EngineImages } from "./engines.js";

/** The images built for `engine`, or undefined when the run leaves it out. */
export const imagesFor = (engine: Engine): EngineImages | undefined =>
  inject("localImages")[engine];

/** Where the workspace is mounted, as `createSandbox()` mounts a worktree. */
export const WORKSPACE = "/home/agent/workspace";

/**
 * Opens real sandboxes on throwaway host workspaces, and closes and removes
 * them all in `cleanup`.
 */
export interface Sandboxes {
  /** A new host directory, mounted at WORKSPACE by `open`. */
  readonly workspace: () => Promise<string>;
  /** Starts a container from `provider`, with `dir` (default: a new workspace) at WORKSPACE. */
  readonly open: (
    provider: SandboxProvider,
    dir?: string,
  ) => Promise<BindMountSandboxHandle>;
  readonly cleanup: () => Promise<void>;
}

const sandboxes = (engine: Engine): Sandboxes => {
  const dirs: string[] = [];
  const handles: BindMountSandboxHandle[] = [];
  const workspace = async (): Promise<string> => {
    const dir = await realpath(
      await mkdtemp(path.join(tmpdir(), `local-${engine}-`)),
    );
    dirs.push(dir);
    return dir;
  };
  return {
    workspace,
    open: async (provider, dir) => {
      if (provider.tag !== "bind-mount") {
        throw new Error(`expected a bind-mount provider, got ${provider.tag}`);
      }
      const hostDir = dir ?? (await workspace());
      const handle = await provider.create({
        worktreePath: hostDir,
        hostRepoPath: hostDir,
        mounts: [{ hostPath: hostDir, sandboxPath: WORKSPACE }],
        env: {},
      });
      handles.push(handle);
      return handle;
    },
    cleanup: async () => {
      const open = handles.splice(0);
      await Promise.all(
        open.map(async (handle) => handle.close().catch(() => undefined)),
      );
      // A test that closed its own sandbox already removed it; this catches
      // any a failed close left behind.
      if (open.length > 0) {
        await command(engine, [
          "rm",
          "-f",
          ...open.map((handle) => idOf(handle)),
        ]).catch(() => undefined);
      }
      await Promise.all(
        dirs
          .splice(0)
          .map(async (dir) => rm(dir, { recursive: true, force: true })),
      );
    },
  };
};

/** The container's name, which docker() and podman() always expose. */
export const idOf = (handle: BindMountSandboxHandle): string => {
  if (handle.sandboxId === undefined) {
    throw new Error("expected the sandbox to expose its container name");
  }
  return handle.sandboxId;
};

/**
 * {@link sandboxes} for the running test, cleaned up when it finishes, so
 * concurrent tests don't share them.
 */
export const useSandboxes = (engine: Engine): Sandboxes => {
  const boxes = sandboxes(engine);
  onTestFinished(boxes.cleanup);
  return boxes;
};

/** Runs `script` in the sandbox; fails the test unless it exits 0. */
export const sh = async (
  handle: BindMountSandboxHandle,
  script: string,
  options?: { readonly sudo?: boolean },
): Promise<string> => {
  const result: ExecResult = await handle.exec(script, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `\`${script}\` exited ${String(result.exitCode)}: ${result.stderr}`,
    );
  }
  return result.stdout.trim();
};

/** `<engine> inspect --format <format>` on the sandbox's container. */
export const inspect = async (
  engine: Engine,
  handle: BindMountSandboxHandle,
  format: string,
): Promise<string> => {
  const stdout = await command(engine, [
    "inspect",
    "--format",
    format,
    idOf(handle),
  ]);
  return stdout.trim();
};

/** Whether `<engine>` still knows a container named `name`. */
export const containerExists = async (
  engine: Engine,
  name: string,
): Promise<boolean> =>
  command(engine, ["container", "inspect", name]).then(
    () => true,
    () => false,
  );

/** The network mode a plain `<engine> create <image>` gets on this host. */
export const defaultNetworkMode = async (
  engine: Engine,
  image: string,
): Promise<string> => {
  const id = await command(engine, ["create", image]);
  try {
    const stdout = await command(engine, [
      "inspect",
      "--format",
      "{{.HostConfig.NetworkMode}}",
      id.trim(),
    ]);
    return stdout.trim();
  } finally {
    await command(engine, ["rm", "-f", id.trim()]);
  }
};

/** Creates a network named for this run; returns its name. */
export const createNetwork = async (
  engine: Engine,
  label: string,
): Promise<string> => {
  const name = `sandcastle-local-${label}-${String(process.pid)}-${String(Date.now())}`;
  await command(engine, ["network", "create", name]);
  return name;
};

/** Removes networks made by `createNetwork`. */
export const removeNetworks = async (
  engine: Engine,
  names: readonly string[],
): Promise<void> => {
  if (names.length > 0) {
    await command(engine, ["network", "rm", ...names]).catch(() => undefined);
  }
};
