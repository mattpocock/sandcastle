// host(), the provider whose sandboxes run on the host itself, with no
// isolation. Its entry point is ./host.ts.

import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxProvider } from "../SandboxProvider.js";
import { createSandboxProvider } from "../SandboxProvider.js";
import type { HostNative } from "./hostSandbox.js";
import { createHostSandbox } from "./hostSandbox.js";

/**
 * Where a host() sandbox's folder goes. There's no `env` (it goes to
 * `createSandbox`, then to each command), no time limit
 * (`timeLimitMinutes` on `createSandbox`), and no working directory: each
 * sandbox starts with an empty one of its own, so clone your repo into it.
 */
export interface HostCreateOptions {
  /**
   * The folder each sandbox's own folder is made in, created if missing.
   * Default `<os.tmpdir()>/sandcastle-host`.
   */
  readonly rootDir?: string;
}

/** Options for `host()`. */
export interface HostOptions {
  /** Where each sandbox is made. */
  readonly create?: HostCreateOptions;
}

/**
 * A provider whose sandboxes run on this machine, as you. **It is not a
 * sandbox**: there's no isolation. Commands run as the calling user, with
 * your filesystem (your home, `~/.ssh` and cloud credentials included) and
 * your network, and nothing stops an agent from reading or writing outside
 * its working directory. v1 agents keep their default permission bypass
 * (`--dangerously-skip-permissions` for Claude Code) here too, unless you
 * set `permissionMode`. Use it on a CI runner, or where you trust the agent
 * with your machine.
 *
 * It's a drop-in for the other providers: each sandbox is a private folder,
 * `<rootDir>/<sandboxId>/`, holding `workspace/` (the working directory,
 * empty at create: clone your repo into it), `home/` and `tmp/`. Each
 * command gets the host's `PATH`, then the sandbox's env, then its own, with
 * `HOME` and the temp dirs pointing into the folder (on Windows also
 * `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP` and `TMP`, plus the
 * system variables a Windows program needs). Nothing else of your
 * `process.env` reaches it. The host needs Node, `git`, `gh` and the agent
 * CLI on its `PATH`.
 *
 * On Linux and macOS a command is `sh -c`, in a process group of its own.
 * Windows needs no `sh`: a simple command (words and quotes) is spawned
 * from its argv, a `.cmd` or `.bat` through `cmd.exe`, and anything else
 * goes to `cmd.exe` as written, so a POSIX-only command such as `mkdir -p`
 * fails there. A kill takes a command's whole tree.
 *
 * It can't detach: a sandbox lives only as long as your process. At the
 * kill time (now plus `timeLimitMinutes`), on `close()`, or when your
 * process exits, every running command is killed and the folder removed.
 * A hard kill of your process (`SIGKILL`) leaves both behind. There's no
 * root: `exec` with `sudo: true` rejects. `native` holds the folder.
 *
 * @example
 * ```ts
 * import { createSandbox } from "@ai-hero/sandcastle/v1";
 * import { host } from "@ai-hero/sandcastle/v1/sandboxes/host";
 *
 * await using sandbox = await createSandbox({
 *   provider: host(),
 *   env: { GH_TOKEN: token, CLAUDE_CODE_OAUTH_TOKEN: claudeToken },
 *   timeLimitMinutes: 60,
 * });
 * await sandbox.exec('git clone "https://x-access-token:$GH_TOKEN@github.com/you/repo.git" .');
 * ```
 */
export const host = (
  options: HostOptions = {},
): SandboxProvider<HostNative, false> => {
  const rootDir =
    options.create?.rootDir ?? path.join(tmpdir(), "sandcastle-host");
  return createSandboxProvider<HostNative>({
    name: "host",
    create: async (createOptions) => createHostSandbox(rootDir, createOptions),
  });
};
