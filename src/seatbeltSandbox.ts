/**
 * The pieces of the `seatbelt()` provider (src/sandboxes/seatbelt.ts) that
 * don't run processes: a sandbox's private dirs, the Seatbelt policy and
 * child env for a sandbox, and the in-sandbox to host path mapping. Used only
 * by `seatbelt()`.
 */

import { homedir } from "node:os";
import { join, posix } from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect, Option } from "effect";
import type { BindMountCreateOptions } from "./SandboxProvider.js";
import { hostPathToolchainFromEnv } from "./hostPathToolchain.js";
import { resolveIdentityMounts } from "./identityMounts.js";
import type { IdentityMount, MountConfig } from "./identityMounts.js";
import { SYSTEM_READ_ROOTS, buildSeatbeltPolicy } from "./seatbeltProfile.js";
import type { SeatbeltPolicy } from "./seatbeltProfile.js";
import { SeatbeltError } from "./errors.js";

/** The construction check, from its own module (it runs a process, synchronously). */
export { SANDBOX_EXEC, assertSeatbeltUsable } from "./seatbeltPreflight.js";
export type { IdentityMount, MountConfig } from "./identityMounts.js";
/** Output collection and file copies, shared by the native sandbox providers. */
export { collectOutput, copyCreatingParents } from "./nativeSandboxIo.js";

/**
 * The private home's logical path. Seatbelt can't remap paths, so `HOME` in
 * the sandbox is the private dir's real path; copies to and from paths under
 * this one are translated to it.
 */
export const SANDBOX_HOME = "/home/agent";

const FALLBACK_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** Where `xcode-select` points: the developer dir `/usr/bin/git` and friends run from. */
const XCODE_SELECT_LINK = "/var/db/xcode_select_link";

const isWithin = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}/`);

/**
 * Checks `seatbelt()`'s `mounts` option: each mount, after resolution, must
 * sit at its own host path. Throws at construction otherwise.
 */
export const seatbeltMounts = (
  mounts: readonly MountConfig[],
): IdentityMount[] => resolveIdentityMounts("seatbelt", mounts, SANDBOX_HOME);

/** The real host dirs behind a sandbox's private home and temp dir. */
export interface PrivateDirs {
  readonly root: string;
  readonly home: string;
  readonly tmp: string;
}

/** Creates a sandbox's private dirs under the host temp dir, at their real paths. */
export const makePrivateDirs: Effect.Effect<
  PrivateDirs,
  SeatbeltError,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  // Seatbelt matches real paths (/private/var/…, not /var/…).
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectory({ prefix: "sandcastle-seatbelt-" }),
  );
  const dirs = { root, home: join(root, "home"), tmp: join(root, "tmp") };
  yield* fs.makeDirectory(dirs.home);
  yield* fs.makeDirectory(dirs.tmp);
  return dirs;
}).pipe(
  Effect.mapError(
    (e) =>
      new SeatbeltError({
        message: `Couldn't create the seatbelt() sandbox's private dirs: ${e.message}`,
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

/** What every exec of one sandbox shares: its policy and its env. */
export interface SandboxSetup {
  readonly policy: SeatbeltPolicy;
  readonly env: Record<string, string>;
}

/** A mount at its real host path, or none when the path doesn't exist. */
const realMount = (
  fs: FileSystem.FileSystem,
  mount: { readonly hostPath: string; readonly readonly?: boolean },
): Effect.Effect<Option.Option<IdentityMount>> =>
  Effect.option(fs.realPath(mount.hostPath)).pipe(
    Effect.map(
      Option.map((hostPath) => ({
        hostPath,
        readonly: mount.readonly === true,
      })),
    ),
  );

/** The policy and env shared by every exec of one sandbox. */
export const sandboxSetup = (
  options: BindMountCreateOptions,
  dirs: PrivateDirs,
  userMounts: readonly IdentityMount[],
): Effect.Effect<SandboxSetup, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const toolchain = yield* hostPathToolchainFromEnv({
      coveredRoots: SYSTEM_READ_ROOTS,
      deniedRoots: [],
    });
    const developerDir = yield* Effect.option(fs.realPath(XCODE_SELECT_LINK));
    const mounts = (yield* Effect.all(
      [...options.mounts, ...userMounts].map((m) => realMount(fs, m)),
    )).flatMap((m) => (Option.isSome(m) ? [m.value] : []));
    const policy = buildSeatbeltPolicy({
      readableRoots: [
        ...SYSTEM_READ_ROOTS,
        ...Option.toArray(developerDir),
        ...toolchain.readableDirs,
        ...mounts.filter((m) => m.readonly).map((m) => m.hostPath),
      ],
      writableRoots: [
        ...mounts.filter((m) => !m.readonly).map((m) => m.hostPath),
        dirs.home,
        dirs.tmp,
      ],
      protectedPaths: mounts.filter((m) => m.readonly).map((m) => m.hostPath),
      hostHome: homedir(),
    });
    const env = {
      ...options.env,
      PATH:
        toolchain.pathEntries.length > 0
          ? toolchain.pathEntries.join(":")
          : FALLBACK_PATH,
      HOME: dirs.home,
      TMPDIR: dirs.tmp,
    };
    return { policy, env };
  });

/** The `sandbox-exec` arguments that run `sh -c command` under `policy`. */
export const sandboxExecArgs = (
  policy: SeatbeltPolicy,
  command: string,
): string[] => [
  "-p",
  policy.profile,
  ...policy.params.map(([key, value]) => `-D${key}=${value}`),
  "--",
  "/bin/sh",
  "-c",
  command,
];

/**
 * Maps an in-sandbox path to the host file behind it. Paths are host paths,
 * except the logical private home, `/home/agent`, which is the private dir.
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
  return p;
};
