/**
 * Modal isolated sandbox provider — wraps the `modal` SDK into a SandboxProvider.
 *
 * Usage:
 *   import { modal } from "@ai-hero/sandcastle/sandboxes/modal";
 *   await run({ agent: claudeCode("claude-opus-4-8"), sandbox: modal() });
 */

import { readdir, stat } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { createIsolatedSandboxProvider } from "../SandboxProvider.js";
import type {
  ExecResult,
  IsolatedSandboxHandle,
  IsolatedSandboxProvider,
} from "../SandboxProvider.js";
import { MAX_TAIL_CHARS } from "../boundedTail.js";
import { collectBuffered, collectStreamed, feedStdin } from "./modalExec.js";
import type {
  Image,
  ModalClient,
  ModalClientParams,
  Sandbox,
  SandboxCreateParams,
} from "modal";

/** Worktree path inside the Modal sandbox. Its parent, `/`, is root's. */
const MODAL_REPO_PATH = "/workspace";

/** The Modal App sandboxes are created in, unless `appName` says otherwise. */
const DEFAULT_APP_NAME = "sandcastle";

/** The sandbox's lifetime unless `timeoutMs` says otherwise: one hour. */
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

/** The registry image the default image is built on: Node LTS, with git. */
const DEFAULT_BASE_IMAGE = "node:24-bookworm";

/** Installs Claude Code into the default image. */
const DEFAULT_IMAGE_COMMANDS = [
  "RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force",
];

/** Options for the Modal sandbox provider. */
export interface ModalOptions {
  /**
   * Modal token id. Falls back to the `MODAL_TOKEN_ID` environment variable,
   * then to `~/.modal.toml` (written by `modal token new`).
   */
  readonly tokenId?: string;

  /**
   * Modal token secret. Falls back to the `MODAL_TOKEN_SECRET` environment
   * variable, then to `~/.modal.toml`.
   */
  readonly tokenSecret?: string;

  /**
   * Modal environment to create sandboxes in. Falls back to
   * `MODAL_ENVIRONMENT`, then to the profile's default.
   */
  readonly environment?: string;

  /**
   * Name of the Modal App the sandboxes belong to (default: `"sandcastle"`).
   * It is created if it does not exist; no deploy step is needed.
   */
  readonly appName?: string;

  /**
   * The sandbox image: a registry tag such as `"node:24-bookworm"`, or a
   * Modal `Image` you built yourself (e.g. with `dockerfileCommands`).
   *
   * Omit it for Sandcastle's default: `node:24-bookworm` (Node LTS, git, tar)
   * with Claude Code installed. Any other image must have `sh`, `git` and
   * your agent's CLI, or install the CLI in an `onSandboxReady` hook.
   *
   * Modal runs every command as root, whatever the image's `USER`.
   */
  readonly image?: string | Image;

  /**
   * Maximum lifetime of the sandbox in milliseconds (default: one hour,
   * Modal's own default is 5 minutes). Modal can't extend it after create,
   * so set it above your longest run. Modal allows up to 24 hours.
   */
  readonly timeoutMs?: number;

  /**
   * Other `sandboxes.create()` options, passed through to Modal (`cpu`,
   * `memoryMiB`, `regions`, `blockNetwork`, …). Its `env` wins over the
   * env Sandcastle resolves.
   */
  readonly create?: Omit<SandboxCreateParams, "timeoutMs">;

  /** Environment variables injected by this provider. Merged at launch time with env resolver and agent provider env. */
  readonly env?: Record<string, string>;

  /**
   * Maximum number of characters of streamed `exec` output retained per stream
   * (stdout and stderr) when an `onLine` callback is supplied (default: 64KiB).
   *
   * Output is delivered live to `onLine` regardless; this only bounds the tail
   * returned in `ExecResult`, preventing a long-running agent's output from
   * overflowing V8's max string length and crashing the run.
   */
  readonly maxOutputTailChars?: number;
}

/** The `ModalClient` params: only the connection options that are set. */
const toClientParams = (options: ModalOptions | undefined): ModalClientParams =>
  Object.fromEntries(
    Object.entries({
      tokenId: options?.tokenId,
      tokenSecret: options?.tokenSecret,
      environment: options?.environment,
    }).filter(([, value]) => value !== undefined && value !== ""),
  );

/** The image to create the sandbox from. */
const toImage = (
  client: ModalClient,
  image: string | Image | undefined,
): Image => {
  if (typeof image === "string" && image !== "") {
    return client.images.fromRegistry(image);
  }
  if (image !== undefined && typeof image !== "string") {
    return image;
  }
  return client.images
    .fromRegistry(DEFAULT_BASE_IMAGE)
    .dockerfileCommands(DEFAULT_IMAGE_COMMANDS);
};

/** Every file under a host directory, recursively. */
const listFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => join(entry.parentPath, entry.name));
};

/** Copy a host file or directory into the sandbox. */
const copyIn = async (
  sandbox: Sandbox,
  hostPath: string,
  sandboxPath: string,
): Promise<void> => {
  const info = await stat(hostPath);
  if (!info.isDirectory()) {
    await sandbox.filesystem.copyFromLocal(hostPath, sandboxPath);
    return;
  }
  await sandbox.filesystem.makeDirectory(sandboxPath);
  const files = await listFiles(hostPath);
  // One file at a time: each copy is its own exec in the sandbox.
  await files.reduce(async (previous, file) => {
    await previous;
    const rel = relative(hostPath, file).split(sep).join("/");
    await sandbox.filesystem.copyFromLocal(file, posix.join(sandboxPath, rel));
  }, Promise.resolve());
};

/**
 * Create the worktree folder in a sandbox `create()` has just made. If that
 * fails, terminate the sandbox before rethrowing: no handle exists yet, so
 * neither Sandcastle's teardown nor `close()` can reach it, and it would run
 * until its timeout.
 */
const setUpOrTerminate = async (sandbox: Sandbox): Promise<void> => {
  try {
    await sandbox.filesystem.makeDirectory(MODAL_REPO_PATH);
  } catch (error) {
    await sandbox.terminate().catch(() => undefined);
    throw new Error(
      `modal(): could not create ${MODAL_REPO_PATH}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
};

/** The Sandcastle handle over a Modal sandbox whose worktree folder exists. */
const makeHandle = (
  client: ModalClient,
  sandbox: Sandbox,
  maxOutputTailChars: number,
): IsolatedSandboxHandle => ({
  worktreePath: MODAL_REPO_PATH,
  sandboxId: sandbox.sandboxId,

  // Commands already run as root, so `sudo` needs nothing more.
  exec: async (command, opts): Promise<ExecResult> => {
    const proc = await sandbox.exec(["sh", "-c", command], {
      workdir: opts?.cwd ?? MODAL_REPO_PATH,
    });
    await feedStdin(proc, opts?.stdin);
    return opts?.onLine
      ? collectStreamed(proc, opts.onLine, maxOutputTailChars)
      : collectBuffered(proc);
  },

  copyIn: async (hostPath, sandboxPath) =>
    copyIn(sandbox, hostPath, sandboxPath),

  copyFileOut: async (sandboxPath, hostPath) =>
    sandbox.filesystem.copyToLocal(sandboxPath, hostPath),

  close: async (): Promise<void> => {
    try {
      await sandbox.terminate();
    } finally {
      client.close();
    }
  },
});

/**
 * Create a Modal isolated sandbox provider.
 *
 * Each `create()` starts a new Modal sandbox via the `modal` SDK, and
 * `close()` terminates it. Requires `modal` to be installed as a peer
 * dependency.
 */
export const modal = (options?: ModalOptions): IsolatedSandboxProvider =>
  createIsolatedSandboxProvider({
    name: "modal",
    // Modal runs every command as root, where Claude Code refuses
    // --dangerously-skip-permissions unless it knows it is in a sandbox.
    env: { IS_SANDBOX: "1", ...options?.env },
    create: async (createOptions): Promise<IsolatedSandboxHandle> => {
      // Dynamic import so the peer dependency is only loaded at runtime
      const { ModalClient } = await import("modal");
      const client = new ModalClient(toClientParams(options));
      try {
        const app = await client.apps.fromName(
          options?.appName ?? DEFAULT_APP_NAME,
          { createIfMissing: true },
        );
        const sandbox = await client.sandboxes.create(
          app,
          toImage(client, options?.image),
          {
            ...options?.create,
            timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            env: { ...createOptions.env, ...options?.create?.env },
          },
        );
        await setUpOrTerminate(sandbox);
        return makeHandle(
          client,
          sandbox,
          options?.maxOutputTailChars ?? MAX_TAIL_CHARS,
        );
      } catch (error) {
        client.close();
        throw error;
      }
    },
  });
