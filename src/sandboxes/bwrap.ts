/**
 * Bubblewrap sandbox provider — a native sandbox provider for Linux and WSL2.
 *
 * Usage:
 *   import { bwrap } from "@ai-hero/sandcastle/sandboxes/bwrap";
 *   await run({ agent: claudeCode("claude-opus-4-8"), sandbox: bwrap() });
 *
 * Each `exec` runs in a fresh Bubblewrap sandbox: the host's system dirs
 * read-only, the worktree and git dirs at their host paths, a private home at
 * `/home/agent` and a private `/tmp`, its own PID namespace, the host network,
 * and only the env vars Sandcastle passes in. No image, no daemon.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Config, Effect } from "effect";
import {
  SANDBOX_HOME,
  assertBwrapUsable,
  collectOutput,
  copyCreatingParents,
  makePrivateDirs,
  removePrivateDirs,
  sandboxArgs,
  toHostPath,
} from "../bwrapSandbox.js";
import type { PrivateDirs } from "../bwrapSandbox.js";
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

/** Options for {@link bwrap}. */
export interface BwrapOptions {
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
}

type ExecOptions = Parameters<BindMountSandboxHandle["exec"]>[1];

/** Runs `sh -c command` in a fresh bwrap and resolves when it exits. */
const runInBwrap = async (
  args: readonly string[],
  opts: ExecOptions,
  sandbox: { live: Set<ChildProcess>; maxTailChars: number },
): Promise<ExecResult> => {
  const { live, maxTailChars } = sandbox;
  const proc = spawn("bwrap", args, { stdio: ["pipe", "pipe", "pipe"] });
  live.add(proc);
  const output = collectOutput(proc, opts?.onLine, maxTailChars);
  proc.stdin.on("error", () => undefined);
  proc.stdin.end(opts?.stdin ?? "");
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

/** Creates the sandbox's private dirs and the bwrap arguments every exec shares. */
const prepare = async (
  options: BindMountCreateOptions,
): Promise<{ dirs: PrivateDirs; baseArgs: string[] }> =>
  Effect.gen(function* () {
    const dirs = yield* makePrivateDirs;
    const hostPathEnv = yield* Config.string("PATH").pipe(
      Config.withDefault(""),
    );
    const baseArgs = yield* sandboxArgs(options, dirs, hostPathEnv);
    return { dirs, baseArgs };
  }).pipe(runOnHost);

const createHandle = async (
  options: BindMountCreateOptions,
  maxTailChars: number,
): Promise<BindMountSandboxHandle> => {
  const { dirs, baseArgs } = await prepare(options);
  const live = new Set<ChildProcess>();
  const killAll = (): void => {
    for (const proc of live) {
      proc.kill("SIGKILL");
    }
  };
  const unregisterShutdown = registerShutdown(killAll);
  let closed = false;
  const hostPathOf = (p: string): string => toHostPath(p, dirs, options.mounts);

  return {
    worktreePath: options.worktreePath,
    exec: async (command, opts) => {
      if (opts?.sudo === true) {
        throw new Error(
          "bwrap() has no root: exec with sudo: true isn't supported in a native sandbox. " +
            "Use docker() for setup that needs root.",
        );
      }
      if (closed) {
        throw new Error("bwrap() sandbox is closed");
      }
      const cwd = opts?.cwd ?? options.worktreePath;
      const args = [...baseArgs, "--chdir", cwd, "sh", "-c", command];
      return runInBwrap(args, opts, { live, maxTailChars });
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
 * Create a Bubblewrap sandbox provider (Linux and WSL2).
 *
 * The agent runs the host's own toolchain, read-only, and can write only the
 * worktree, the git dirs Sandcastle mounts, a private `/tmp` and a private
 * home at `/home/agent`. Both private dirs are removed on close, and so is
 * every process the sandbox started. It has no root: `exec` with
 * `sudo: true` rejects. All three branch strategies are supported.
 *
 * Checks once per process that Bubblewrap is usable, and throws
 * `NativeSandboxUnavailableError` (with a `fixCommand` when there is
 * one) if it isn't: on a non-Linux OS, when `bwrap` isn't on `PATH`, or when
 * the kernel blocks unprivileged user namespaces. It never falls back to
 * running unsandboxed.
 */
export const bwrap = (options?: BwrapOptions): BindMountSandboxProvider => {
  assertBwrapUsable();
  const maxTailChars = options?.maxOutputTailChars ?? MAX_TAIL_CHARS;
  return markNativeSandboxProvider(
    createBindMountSandboxProvider({
      name: "bwrap",
      env: options?.env ?? {},
      sandboxHomedir: SANDBOX_HOME,
      create: async (createOptions) =>
        createHandle(createOptions, maxTailChars),
    }),
  );
};
