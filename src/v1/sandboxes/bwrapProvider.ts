// bwrap(), the Bubblewrap provider factory. Its entry point is ./bwrap.ts.

import { homedir } from "node:os";
import { isAbsolute, posix } from "node:path";
import type { SandboxProvider } from "../SandboxProvider.js";
import { createSandboxProvider } from "../SandboxProvider.js";
import type { BwrapSettings } from "./bwrapArgs.js";
import type { BwrapNative } from "./bwrapSandbox.js";
import {
  createBwrapSandbox,
  getBwrapSandbox,
  spawnInBwrapSandbox,
} from "./bwrapSandbox.js";

/**
 * What a bwrap() sandbox is made of. There's no `env` (it goes to
 * `createSandbox`, then to each command), no time limit (`timeLimitMinutes`
 * on `createSandbox`), and no mounts: nothing of yours is visible in the
 * sandbox, so clone your repo into its working directory.
 */
export interface BwrapCreateOptions {
  /**
   * `"host"` (the default) shares the host's network, so the sandbox
   * reaches anything the host can. `"none"` gives it no network but its
   * own loopback: no clone, no agent API, no finish report.
   */
  readonly network?: "host" | "none";
  /**
   * Extra host folders to show read-only, at their own paths, and add to
   * the sandbox's `PATH`: a tool installed outside the host `PATH`, say.
   * Absolute paths; your home folder, `/` and the folders above your home
   * are refused. One that doesn't exist is skipped.
   */
  readonly toolchainPaths?: readonly string[];
}

/** Options for `bwrap()`. */
export interface BwrapOptions {
  /** What each sandbox is made of. Ignored by `reattachSandbox`, which reads it back from the sandbox. */
  readonly create?: BwrapCreateOptions;
}

const isWithin = (path: string, root: string): boolean =>
  root === "/" || path === root || path.startsWith(`${root}/`);

/** The create options as kept in the sandbox's folder, checked. */
const settingsOf = (create: BwrapCreateOptions | undefined): BwrapSettings => {
  const home = homedir();
  const toolchainPaths = (create?.toolchainPaths ?? []).map((path) => {
    if (!isAbsolute(path)) {
      throw new TypeError(
        `bwrap(): create.toolchainPaths must be absolute, got "${path}"`,
      );
    }
    const normalized = posix.normalize(path).replace(/(?<=.)\/$/u, "");
    if (isWithin(home, normalized)) {
      throw new TypeError(
        `bwrap(): create.toolchainPaths can't show "${path}": it is your home folder, or holds it`,
      );
    }
    return normalized;
  });
  return { network: create?.network ?? "host", toolchainPaths };
};

/**
 * A provider of Bubblewrap sandboxes, on this Linux (or WSL2) machine. A
 * drop-in for a remote provider: each sandbox starts with an empty working
 * directory to clone into, and nothing of the caller's is visible in it (no
 * checkout, no home, no host `/tmp`). It runs the host's own toolchain,
 * read-only: the system folders, and the folders on the host `PATH` that
 * hold `node`, `git`, `gh` and the agent CLIs. The host needs all of those,
 * and `bwrap`.
 *
 * Each sandbox is a folder under `$XDG_STATE_HOME/sandcastle/sandboxes/`
 * (default `~/.local/state`), owned by a keeper: a host process started at
 * create in its own session, which runs every command in the sandbox. At
 * the kill time, or on `close()`, it kills them all and removes the folder.
 * Its sandboxes are detachable: detached work runs under the keeper, so it
 * outlives your process, though not a reboot. Each command is a fresh
 * Bubblewrap with its own PID namespace, and gets its env through its own
 * environment, never its command line. `sudo: true` runs a command as root
 * in the sandbox's user namespace, which is still you on the host: the
 * host's folders stay read-only. `native` holds the sandbox's folder.
 *
 * @example
 * ```ts
 * import { createSandbox } from "@ai-hero/sandcastle/v1";
 * import { bwrap } from "@ai-hero/sandcastle/v1/sandboxes/bwrap";
 *
 * await using sandbox = await createSandbox({
 *   provider: bwrap(),
 *   env: { GH_TOKEN: token, CLAUDE_CODE_OAUTH_TOKEN: claudeToken },
 *   timeLimitMinutes: 60,
 * });
 * await sandbox.exec('git clone "https://x-access-token:$GH_TOKEN@github.com/you/repo.git" .');
 * ```
 */
export const bwrap = (
  options: BwrapOptions = {},
): SandboxProvider<BwrapNative, true> => {
  const settings = settingsOf(options.create);
  return createSandboxProvider({
    name: "bwrap",
    create: async (createOptions) =>
      createBwrapSandbox(settings, createOptions),
    detach: {
      spawnDetached: spawnInBwrapSandbox,
      get: getBwrapSandbox,
    },
  });
};
