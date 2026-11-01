/**
 * Seatbelt sandbox provider — a native sandbox provider for macOS.
 *
 * Usage:
 *   import { seatbelt } from "@ai-hero/sandcastle/sandboxes/seatbelt";
 *   await run({ agent: claudeCode("claude-opus-4-8"), sandbox: seatbelt() });
 *
 * Each `exec` runs under the system `sandbox-exec` with a deny-by-default
 * profile: the system toolchain read-only, the worktree and git dirs
 * read/write at their host paths, a private home and temp dir, the host
 * network, and only the env vars Sandcastle passes in. No image, no daemon.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import {
  SANDBOX_EXEC,
  SANDBOX_HOME,
  assertSeatbeltUsable,
  collectOutput,
  copyCreatingParents,
  makePrivateDirs,
  removePrivateDirs,
  sandboxExecArgs,
  sandboxSetup,
  seatbeltMounts,
  toHostPath,
} from "../seatbeltSandbox.js";
import type {
  IdentityMount,
  MountConfig,
  PrivateDirs,
  SandboxSetup,
} from "../seatbeltSandbox.js";
import { createBindMountSandboxProvider } from "../SandboxProvider.js";
import type {
  BindMountCreateOptions,
  BindMountSandboxHandle,
  BindMountSandboxProvider,
  ExecResult,
} from "../SandboxProvider.js";
import { MAX_TAIL_CHARS } from "../boundedTail.js";
import { markNativeSandboxProvider } from "../nativeSandboxProvider.js";
import { registerShutdown } from "../shutdownRegistry.js";

/** Options for {@link seatbelt}. */
export interface SeatbeltOptions {
  /** Environment variables injected by this provider. Merged at launch time. */
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
  /**
   * Extra host paths to make visible in the sandbox (a cache, a sibling
   * checkout, `.beads/`). Each appears at its own host path, so after
   * resolution `sandboxPath` must equal `hostPath`; `seatbelt()` throws
   * otherwise. `readonly` defaults to `false`.
   */
  readonly mounts?: readonly MountConfig[];
}

type ExecOptions = Parameters<BindMountSandboxHandle["exec"]>[1];

/** SIGKILLs every process in `proc`'s process group. Synchronous, for shutdown. */
const killGroup = (proc: ChildProcess): void => {
  if (proc.pid === undefined) {
    return;
  }
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    // The group is already gone.
  }
};

/**
 * A host shell, outside the sandbox, holding the read end of a pipe from
 * this Node process. If the pipe ends without `exit` (this process died,
 * however it died: nothing in it runs on SIGKILL), it SIGKILLs process
 * group `$1`.
 */
const WATCHDOG = 'read -r reply || kill -9 -- "-$1" 2>/dev/null';

/**
 * Starts the watchdog for one exec's process group. Detached, so it leads
 * its own session: whatever kills this process's group or terminal can't
 * take it too, and the sandbox can't signal it. Returns how to stand it down
 * once the exec has ended and its group is killed.
 */
const startWatchdog = (pgid: number): (() => void) => {
  const watchdog = spawn("/bin/sh", ["-c", WATCHDOG, "sh", String(pgid)], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  watchdog.on("error", () => undefined);
  watchdog.stdin.on("error", () => undefined);
  return () => {
    watchdog.stdin.end("exit\n");
  };
};

/**
 * Runs `sh -c command` under `sandbox-exec` and resolves when it exits. The
 * child leads its own process group: Seatbelt has no PID namespace, so the
 * group is how everything it started gets killed: when it exits, on close,
 * and, through a watchdog, when this Node process is hard-killed.
 */
const runInSeatbelt = async (
  command: string,
  opts: ExecOptions & { readonly cwd: string },
  sandbox: {
    setup: SandboxSetup;
    live: Set<ChildProcess>;
    maxTailChars: number;
  },
): Promise<ExecResult> => {
  const { setup, live, maxTailChars } = sandbox;
  const proc = spawn(SANDBOX_EXEC, sandboxExecArgs(setup.policy, command), {
    cwd: opts.cwd,
    env: setup.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Started in the same tick as the exec, so there's no moment when a hard
  // kill of this process would leave the group unwatched.
  const standDown =
    proc.pid === undefined ? (): void => undefined : startWatchdog(proc.pid);
  live.add(proc);
  // Like a fresh bwrap per exec: nothing it started outlives it.
  proc.on("exit", () => {
    killGroup(proc);
    standDown();
  });
  const output = collectOutput(proc, opts.onLine, maxTailChars);
  proc.stdin.on("error", () => undefined);
  proc.stdin.end(opts.stdin ?? "");
  try {
    await once(proc, "close");
    return { ...output(), exitCode: proc.exitCode ?? 1 };
  } finally {
    live.delete(proc);
  }
};

/** Runs a file-system Effect on the host's file system. */
const runOnHost = async <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
): Promise<A> =>
  effect.pipe(Effect.provide(NodeFileSystem.layer), Effect.runPromise);

/** Creates the sandbox's private dirs and the policy and env every exec shares. */
const prepare = async (
  options: BindMountCreateOptions,
  userMounts: readonly IdentityMount[],
): Promise<{ dirs: PrivateDirs; setup: SandboxSetup }> =>
  Effect.gen(function* () {
    const dirs = yield* makePrivateDirs;
    const setup = yield* sandboxSetup(options, dirs, userMounts);
    return { dirs, setup };
  }).pipe(runOnHost);

/**
 * Seatbelt can't remap paths: commands inside see the private dirs at their
 * real host paths, so the handle reports those for core to build paths from.
 */
const reportedDirs = (
  dirs: PrivateDirs,
): Pick<BindMountSandboxHandle, "sandboxHomedir" | "sandboxTmpdir"> => ({
  sandboxHomedir: dirs.home,
  sandboxTmpdir: dirs.tmp,
});

const createHandle = async (
  options: BindMountCreateOptions,
  config: { maxTailChars: number; userMounts: readonly IdentityMount[] },
): Promise<BindMountSandboxHandle> => {
  const { maxTailChars, userMounts } = config;
  const { dirs, setup } = await prepare(options, userMounts);
  const live = new Set<ChildProcess>();
  const killAll = (): void => {
    for (const proc of live) {
      killGroup(proc);
    }
  };
  const unregisterShutdown = registerShutdown(killAll);
  let closed = false;
  const hostPathOf = (p: string): string => toHostPath(p, dirs, options.mounts);

  return {
    worktreePath: options.worktreePath,
    ...reportedDirs(dirs),
    exec: async (command, opts) => {
      if (opts?.sudo === true) {
        throw new Error(
          "seatbelt() has no root: exec with sudo: true isn't supported in a native sandbox. " +
            "Use docker() for setup that needs root.",
        );
      }
      if (closed) {
        throw new Error("seatbelt() sandbox is closed");
      }
      const cwd = opts?.cwd ?? options.worktreePath;
      return runInSeatbelt(
        command,
        { ...opts, cwd },
        { setup, live, maxTailChars },
      );
    },
    copyFileIn: async (hostPath, sandboxFile) =>
      copyCreatingParents(hostPath, hostPathOf(sandboxFile)).pipe(runOnHost),
    copyFileOut: async (sandboxFile, hostPath) =>
      copyCreatingParents(hostPathOf(sandboxFile), hostPath).pipe(runOnHost),
    close: async () => {
      closed = true;
      const exits = [...live].map(async (proc) => once(proc, "close"));
      killAll();
      await Promise.allSettled(exits);
      unregisterShutdown();
      await removePrivateDirs(dirs).pipe(runOnHost);
    },
  };
};

/**
 * Create a Seatbelt sandbox provider (macOS 14 or later).
 *
 * Each `exec` runs under the system `/usr/bin/sandbox-exec` with a
 * deny-by-default profile. The agent runs the host's own toolchain,
 * read-only, and can write only the worktree, the git dirs Sandcastle
 * mounts, a private temp dir (`TMPDIR`) and a private home (`HOME`). The git
 * control files stay read-only, and the dirs holding them can't be moved
 * aside. It can't signal host processes, but Seatbelt can't fully hide them.
 * The private home is exposed to Sandcastle as `/home/agent`: copies to and
 * from paths under it land in the private dir. Both private dirs are removed
 * on close, and every process an `exec` started is killed when it exits, on
 * close, on shutdown and when this Node process is hard-killed (a detached
 * host watchdog per `exec` does that). The toolchain comes from the host
 * `PATH`: each `PATH` dir (never the home dir or an ancestor of it) and the
 * install root of each executable symlinked from one. Add other paths with `mounts`. The network is
 * open, including the host's localhost. It has no root: `exec` with
 * `sudo: true` rejects.
 *
 * Checks once per process that Seatbelt is usable, and throws
 * `NativeSandboxUnavailableError` if it isn't: on a non-macOS OS, on macOS
 * older than 14, or when `sandbox-exec` is missing or fails (for instance
 * inside another Seatbelt sandbox). It never falls back to running
 * unsandboxed.
 */
export const seatbelt = (
  options?: SeatbeltOptions,
): BindMountSandboxProvider => {
  // Reject a sandboxPath/hostPath mismatch before the preflight, so the
  // config error surfaces on every OS.
  const userMounts = seatbeltMounts(options?.mounts ?? []);
  assertSeatbeltUsable();
  const maxTailChars = options?.maxOutputTailChars ?? MAX_TAIL_CHARS;
  return markNativeSandboxProvider(
    createBindMountSandboxProvider({
      name: "seatbelt",
      env: options?.env ?? {},
      sandboxHomedir: SANDBOX_HOME,
      create: async (createOptions) =>
        createHandle(createOptions, { maxTailChars, userMounts }),
    }),
  );
};
