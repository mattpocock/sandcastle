import { posix } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import {
  DENIED_ROOTS,
  FALLBACK_PATH,
  SANDBOX_HOME,
  SYSTEM_DIRS,
  resolvConfArgs,
  systemDirArgs,
  toolchainArgs,
  watchedCommand,
} from "../../bwrapSandbox.js";
import type { LocalLaunch } from "./localProviderSandbox.js";
import type { LocalSandboxFolder } from "./localSandboxState.js";
import type { LocalSettings } from "./localToolchain.js";
import {
  firstHolding,
  hostPathDirs,
  hostToolchain,
  requireTools,
} from "./localToolchain.js";

// The argv and env of each bwrap() command: a fresh Bubblewrap over the
// sandbox's folder. The host's system dirs and the folders that hold its
// node, git, gh and agent CLIs are visible read-only, at their own paths;
// the folder's home and tmp are the sandbox's /home/agent and /tmp. Nothing
// else of the host is: no checkout, no home, no host /tmp.

/** The sandbox's home. */
export const BWRAP_HOME = SANDBOX_HOME;
/** The sandbox's working directory: empty at create. */
export const BWRAP_WORKSPACE = posix.join(SANDBOX_HOME, "workspace");

/** What a sandbox is made of, kept in its folder so a reattach reads it back. */
export type BwrapSettings = LocalSettings;

/** Makes each command's argv and env for one sandbox. */
export type BwrapLaunch = LocalLaunch;

/** The host's toolchain for the sandbox: bwrap args, and the sandbox's PATH. */
const resolveToolchain = async (
  hostPath: readonly string[],
  extra: readonly string[],
): Promise<{ readonly args: string[]; readonly path: string[] }> => {
  const toolchain = await hostToolchain(hostPath, {
    systemDirs: SYSTEM_DIRS,
    deniedRoots: DENIED_ROOTS,
  });
  const path = [...toolchain.pathEntries, ...extra];
  return {
    args: [
      ...toolchainArgs(toolchain),
      ...extra.flatMap((dir) => ["--ro-bind-try", dir, dir]),
    ],
    path: path.length > 0 ? path : FALLBACK_PATH.split(":"),
  };
};

/** The bwrap args every command of the sandbox shares, up to `--chdir`. */
const sharedArgs = async (
  folder: LocalSandboxFolder,
  settings: BwrapSettings,
  toolchain: readonly string[],
): Promise<string[]> => {
  const [system, resolvConf] = await Effect.runPromise(
    Effect.all([systemDirArgs, resolvConfArgs]).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );
  return [
    ...system,
    ...resolvConf,
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/home",
    "--bind",
    folder.home,
    BWRAP_HOME,
    "--bind",
    folder.tmp,
    "/tmp",
    ...toolchain,
    "--unshare-all",
    ...(settings.network === "host" ? ["--share-net"] : []),
    "--die-with-parent",
    "--new-session",
  ];
};

/**
 * How to run commands in the sandbox in `folder`. Rejects, before anything
 * runs, when `bwrap` or a required tool isn't on the host PATH.
 */
export const bwrapLaunch = async (
  folder: LocalSandboxFolder,
  settings: BwrapSettings,
): Promise<BwrapLaunch> => {
  const hostPath = await hostPathDirs();
  const bwrapDir = await firstHolding(hostPath, "bwrap");
  const toolchain = await resolveToolchain(hostPath, settings.toolchainPaths);
  await requireTools("bwrap", toolchain.path);
  const shared = await sharedArgs(folder, settings, toolchain.args);
  const bwrapFile = posix.join(bwrapDir ?? "/usr/bin", "bwrap");
  return ({ command, workingDirectory, sudo, env }) => ({
    argv: [
      bwrapFile,
      ...shared,
      // Root in the sandbox's own user namespace: uid 0 there, still this user on the host.
      ...(sudo ? ["--unshare-user", "--uid", "0", "--gid", "0"] : []),
      "--chdir",
      workingDirectory,
      "--",
      ...watchedCommand(command),
    ],
    env: {
      PATH: toolchain.path.join(":"),
      HOME: BWRAP_HOME,
      TMPDIR: "/tmp",
      ...env,
    },
  });
};
