/**
 * The pieces of the `bwrap()` provider (src/sandboxes/bwrap.ts) that don't
 * run processes: the Bubblewrap arguments for a sandbox, its private dirs,
 * the in-sandbox to host path mapping, and output collection. Used only by
 * `bwrap()`.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join, posix } from "node:path";
import { createInterface } from "node:readline";
import { FileSystem } from "@effect/platform";
import { Effect, Option } from "effect";
import type { BindMountCreateOptions } from "./SandboxProvider.js";
import { hostPathToolchainFromEnv } from "./hostPathToolchain.js";
import type { HostPathToolchain } from "./hostPathToolchain.js";
import { resolveIdentityMounts } from "./identityMounts.js";
import type { IdentityMount, MountConfig } from "./identityMounts.js";

import { BoundedTail } from "./boundedTail.js";
import { BwrapError, CopyError } from "./errors.js";

/** The construction check, from its own module (it runs a process, synchronously). */
export { assertBwrapUsable } from "./bwrapPreflight.js";
export type { IdentityMount, MountConfig } from "./identityMounts.js";

/** The private home's path inside the sandbox. */
export const SANDBOX_HOME = "/home/agent";
const SANDBOX_TMP = "/tmp";

/** Host dirs every sandbox sees read-only: the system toolchain. */
const SYSTEM_DIRS = [
  "/usr",
  "/etc",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/opt",
];

/**
 * Host dirs that stay hidden even when the host PATH names them: WSL2's
 * Windows drives and interop, so a planted `.exe` can't run.
 */
const DENIED_ROOTS = ["/mnt", "/run/WSL"];
const FALLBACK_PATH = "/usr/local/bin:/usr/bin:/bin";

const isWithin = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}/`);

/** `--ro-bind` each system dir, or recreate it as a symlink (merged-/usr layouts). */
const systemDirArgs: Effect.Effect<string[], never, FileSystem.FileSystem> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const args = yield* Effect.all(
      SYSTEM_DIRS.map((dir) =>
        Effect.gen(function* () {
          const link = yield* Effect.option(fs.readLink(dir));
          if (Option.isSome(link)) {
            return ["--symlink", link.value, dir];
          }
          const exists = yield* fs
            .exists(dir)
            .pipe(Effect.orElseSucceed(() => false));
          return exists ? ["--ro-bind", dir, dir] : [];
        }),
      ),
    );
    return args.flat();
  });

/**
 * `/etc/resolv.conf` may point outside the system dirs (WSL2 links it into
 * `/mnt/wsl`). Mount just that file, read-only, so DNS works.
 */
const resolvConfArgs: Effect.Effect<string[], never, FileSystem.FileSystem> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const target = yield* Effect.option(fs.realPath("/etc/resolv.conf"));
    return Option.isNone(target) ||
      SYSTEM_DIRS.some((d) => isWithin(target.value, d))
      ? []
      : ["--ro-bind", target.value, target.value];
  });

/** Every mount at its host path, in order, so read-only overlays land on their writable parents. */
const mountArgs = (
  mounts: readonly { readonly hostPath: string; readonly readonly?: boolean }[],
): string[] =>
  mounts.flatMap((m) => [
    m.readonly === true ? "--ro-bind" : "--bind",
    m.hostPath,
    m.hostPath,
  ]);

/**
 * Checks `bwrap()`'s `mounts` option: each mount, after resolution, must sit
 * at its own host path. Throws at construction otherwise.
 */
export const bwrapMounts = (mounts: readonly MountConfig[]): IdentityMount[] =>
  resolveIdentityMounts("bwrap", mounts, SANDBOX_HOME);

/** The host PATH toolchain: each readable dir `--ro-bind`, each symlinked PATH dir recreated. */
const toolchainArgs = (toolchain: HostPathToolchain): string[] => [
  ...toolchain.readableDirs.flatMap((dir) => ["--ro-bind", dir, dir]),
  ...toolchain.symlinks.flatMap((link) => [
    "--symlink",
    link.target,
    link.path,
  ]),
];

const envArgs = (env: Record<string, string>): string[] =>
  Object.entries(env).flatMap(([key, value]) => ["--setenv", key, value]);

/** The host dirs behind a sandbox's private home and `/tmp`. */
export interface PrivateDirs {
  readonly root: string;
  readonly home: string;
  readonly tmp: string;
}

/** Creates a sandbox's private dirs under the host temp dir. */
export const makePrivateDirs: Effect.Effect<
  PrivateDirs,
  BwrapError,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectory({ prefix: "sandcastle-bwrap-" });
  const dirs = { root, home: join(root, "home"), tmp: join(root, "tmp") };
  yield* fs.makeDirectory(dirs.home);
  yield* fs.makeDirectory(dirs.tmp);
  return dirs;
}).pipe(
  Effect.mapError(
    (e) =>
      new BwrapError({
        message: `Couldn't create the bwrap() sandbox's private dirs: ${e.message}`,
      }),
  ),
);

/** Removes a sandbox's private dirs. */
export const removePrivateDirs = (
  dirs: PrivateDirs,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .remove(dirs.root, { recursive: true })
      .pipe(Effect.orElse(() => Effect.void));
  });

/** The bwrap arguments shared by every exec of one sandbox, up to `--chdir`. */
export const sandboxArgs = (
  options: BindMountCreateOptions,
  dirs: PrivateDirs,
  userMounts: readonly IdentityMount[],
): Effect.Effect<string[], never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const toolchain = yield* hostPathToolchainFromEnv({
      coveredRoots: SYSTEM_DIRS,
      deniedRoots: DENIED_ROOTS,
    });
    return [
      ...(yield* systemDirArgs),
      ...(yield* resolvConfArgs),
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/home",
      "--bind",
      dirs.home,
      SANDBOX_HOME,
      "--bind",
      dirs.tmp,
      SANDBOX_TMP,
      ...toolchainArgs(toolchain),
      ...mountArgs(options.mounts),
      ...mountArgs(userMounts),
      // The read-only core mounts (the #1261 overlays) again, so no user
      // mount can uncover them.
      ...mountArgs(options.mounts.filter((m) => m.readonly === true)),
      "--clearenv",
      ...envArgs({
        ...options.env,
        PATH:
          toolchain.pathEntries.length > 0
            ? toolchain.pathEntries.join(":")
            : FALLBACK_PATH,
        HOME: SANDBOX_HOME,
        TMPDIR: SANDBOX_TMP,
      }),
      "--unshare-all",
      "--share-net",
      "--die-with-parent",
      "--new-session",
    ];
  });

/** Collects a child's output: streamed line by line with a bounded tail, or whole. */
export const collectOutput = (
  proc: ChildProcessWithoutNullStreams,
  onLine: ((line: string) => void) | undefined,
  maxTailChars: number,
): (() => { stdout: string; stderr: string }) => {
  const streaming = onLine !== undefined;
  const stdout = streaming
    ? new BoundedTail(maxTailChars, "\n")
    : new BoundedTail(Infinity);
  const stderr = new BoundedTail(streaming ? maxTailChars : Infinity);
  if (onLine === undefined) {
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk.toString());
    });
  } else {
    createInterface({ input: proc.stdout }).on("line", (line) => {
      stdout.push(line);
      onLine(line);
    });
  }
  proc.stderr.on("data", (chunk: Buffer) => {
    stderr.push(chunk.toString());
  });
  return () => ({ stdout: stdout.toString(), stderr: stderr.toString() });
};

/**
 * Maps an in-sandbox path to the host file behind it. Mounts sit at their
 * host paths; the private home and `/tmp` are the private dirs.
 */
export const toHostPath = (
  path: string,
  dirs: PrivateDirs,
  mounts: BindMountCreateOptions["mounts"],
): string => {
  const p = posix.normalize(path);
  if (mounts.some((m) => isWithin(p, m.hostPath))) {
    return p;
  }
  if (isWithin(p, SANDBOX_HOME)) {
    return join(dirs.home, posix.relative(SANDBOX_HOME, p));
  }
  if (isWithin(p, SANDBOX_TMP)) {
    return join(dirs.tmp, posix.relative(SANDBOX_TMP, p));
  }
  return p;
};

/** Copies a file, creating the target's parent dirs. */
export const copyCreatingParents = (
  from: string,
  to: string,
): Effect.Effect<void, CopyError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dirname(to), { recursive: true });
    yield* fs.copyFile(from, to);
  }).pipe(
    Effect.mapError(
      (e) =>
        new CopyError({
          message: `Couldn't copy ${from} to ${to}: ${e.message}`,
        }),
    ),
  );
