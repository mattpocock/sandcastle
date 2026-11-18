// seatbelt(), the Seatbelt provider factory for macOS. Its entry point is ./seatbelt.ts.

import type { SandboxProvider } from "../SandboxProvider.js";
import { createSandboxProvider } from "../SandboxProvider.js";
import { localSettings } from "./localToolchain.js";
import type { SeatbeltNative } from "./seatbeltSandbox.js";
import {
  createSeatbeltSandbox,
  getSeatbeltSandbox,
  spawnInSeatbeltSandbox,
} from "./seatbeltSandbox.js";

/**
 * What a seatbelt() sandbox is made of. There's no `env` (it goes to
 * `createSandbox`, then to each command), no time limit (`timeLimitMinutes`
 * on `createSandbox`), and no mounts: nothing of yours is visible in the
 * sandbox, so clone your repo into its working directory.
 */
export interface SeatbeltCreateOptions {
  /**
   * `"host"` (the default) shares the host's network, so the sandbox
   * reaches anything the host can, its `localhost` included. `"none"`
   * allows no IP traffic at all: no clone, no agent API, no finish report.
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

/** Options for `seatbelt()`. */
export interface SeatbeltOptions {
  /** What each sandbox is made of. Ignored by `reattachSandbox`, which reads it back from the sandbox. */
  readonly create?: SeatbeltCreateOptions;
}

/**
 * A provider of Seatbelt sandboxes, on this Mac (macOS 14 or later). A
 * drop-in for a remote provider: each sandbox starts with an empty working
 * directory to clone into, and nothing of the caller's is visible in it (no
 * checkout, no home, no host tmp). It runs the host's own toolchain,
 * read-only: the system folders (Homebrew's included), and the folders on
 * the host `PATH` that hold `node`, `git`, `gh` and the agent CLIs. The host
 * needs all of those. `createSandbox` fails on any other OS.
 *
 * Each command runs under the system `/usr/bin/sandbox-exec` with a
 * deny-by-default profile that can read and write only the sandbox's own
 * home and tmp. Seatbelt can't remap paths, so those are at their real host
 * paths: the working directory is `<stateDirectory>/home/workspace`.
 *
 * Each sandbox is a folder under `$XDG_STATE_HOME/sandcastle/sandboxes/`
 * (default `~/.local/state`), owned by a keeper: a host process started at
 * create in its own session, which runs every command in the sandbox. At
 * the kill time, or on `close()`, it kills them all, by process group, and
 * removes the folder. Its sandboxes are detachable: detached work runs
 * under the keeper, so it outlives your process, though not a reboot or a
 * logout. Each command gets its env through its own environment, never its
 * command line. There's no root: `exec` with `sudo: true` rejects. `native`
 * holds the sandbox's folder.
 *
 * @example
 * ```ts
 * import { createSandbox } from "@ai-hero/sandcastle/v1";
 * import { seatbelt } from "@ai-hero/sandcastle/v1/sandboxes/seatbelt";
 *
 * await using sandbox = await createSandbox({
 *   provider: seatbelt(),
 *   env: { GH_TOKEN: token, CLAUDE_CODE_OAUTH_TOKEN: claudeToken },
 *   timeLimitMinutes: 60,
 * });
 * await sandbox.exec('git clone "https://x-access-token:$GH_TOKEN@github.com/you/repo.git" .');
 * ```
 */
export const seatbelt = (
  options: SeatbeltOptions = {},
): SandboxProvider<SeatbeltNative, true> => {
  const settings = localSettings("seatbelt", options.create);
  return createSandboxProvider({
    name: "seatbelt",
    create: async (createOptions) =>
      createSeatbeltSandbox(settings, createOptions),
    detach: {
      spawnDetached: spawnInSeatbeltSandbox,
      get: getSeatbeltSandbox,
    },
  });
};
