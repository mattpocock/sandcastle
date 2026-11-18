import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { posix } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { Config, Effect } from "effect";
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
import { resolveHostPathToolchain } from "../../hostPathToolchain.js";
import type { KeeperCommand } from "./localSandboxKeeper.js";
import type { LocalSandboxFolder } from "./localSandboxState.js";

// The argv and env of each bwrap() command: a fresh Bubblewrap over the
// sandbox's folder. The host's system dirs and the folders that hold its
// node, git, gh and agent CLIs are visible read-only, at their own paths;
// the folder's home and tmp are the sandbox's /home/agent and /tmp. Nothing
// else of the host is: no checkout, no home, no host /tmp.

/** The sandbox's home. */
export const BWRAP_HOME = SANDBOX_HOME;
/** The sandbox's working directory: empty at create. */
export const BWRAP_WORKSPACE = posix.join(SANDBOX_HOME, "workspace");

/** The programs whose host `PATH` folders make up the sandbox's toolchain. */
const TOOLS = [
  "node",
  "git",
  "gh",
  "claude",
  "codex",
  "opencode",
  "copilot",
  "cursor-agent",
  "pi",
];
/** The ones a sandbox can't do without: the supervisor, cloning, and the bundled tasks. */
const REQUIRED_TOOLS = ["node", "git", "gh"];

/** What a sandbox is made of, kept in its folder so a reattach reads it back. */
export interface BwrapSettings {
  readonly network: "host" | "none";
  readonly toolchainPaths: readonly string[];
}

/** One command for the keeper to run in the sandbox. */
export interface BwrapCommand {
  readonly command: string;
  readonly workingDirectory: string;
  readonly sudo: boolean;
  readonly env: Readonly<Record<string, string>>;
}

/** Makes each command's argv and env for one sandbox. */
export type BwrapLaunch = (command: BwrapCommand) => KeeperCommand;

const isWithin = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}/`);

const isExecutable = async (dir: string, name: string): Promise<boolean> =>
  access(posix.join(dir, name), constants.X_OK).then(
    () => true,
    () => false,
  );

/** The first of `dirs` that holds an executable `name`. */
const firstHolding = async (
  dirs: readonly string[],
  name: string,
): Promise<string | undefined> => {
  const holds = await Promise.all(
    dirs.map(async (dir) => isExecutable(dir, name)),
  );
  return dirs[holds.indexOf(true)];
};

const holdsTool = async (dir: string): Promise<boolean> => {
  const holds = await Promise.all(
    TOOLS.map(async (tool) => isExecutable(dir, tool)),
  );
  return holds.includes(true);
};

/** The host `PATH` dirs the sandbox gets: system ones, and those holding a tool. */
const toolDirs = async (path: readonly string[]): Promise<string[]> => {
  const keep = await Promise.all(
    path.map(
      async (dir) =>
        SYSTEM_DIRS.some((root) => isWithin(dir, root)) || holdsTool(dir),
    ),
  );
  return path.filter((_, index) => keep[index] === true);
};

/** The host's toolchain for the sandbox: bwrap args, and the sandbox's PATH. */
const resolveToolchain = async (
  hostPath: readonly string[],
  extra: readonly string[],
): Promise<{ readonly args: string[]; readonly path: string[] }> => {
  const dirs = await toolDirs(hostPath);
  const toolchain = await Effect.runPromise(
    resolveHostPathToolchain({
      path: dirs.join(":"),
      home: homedir(),
      coveredRoots: SYSTEM_DIRS,
      deniedRoots: DENIED_ROOTS,
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
  const path = [...toolchain.pathEntries, ...extra];
  return {
    args: [
      ...toolchainArgs(toolchain),
      ...extra.flatMap((dir) => ["--ro-bind-try", dir, dir]),
    ],
    path: path.length > 0 ? path : FALLBACK_PATH.split(":"),
  };
};

/** Rejects, naming them, when the sandbox's PATH lacks a required tool. */
const requireTools = async (path: readonly string[]): Promise<void> => {
  const found = await Promise.all(
    REQUIRED_TOOLS.map(async (tool) => firstHolding(path, tool)),
  );
  const missing = REQUIRED_TOOLS.filter(
    (_, index) => found[index] === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      `bwrap() runs the host's own toolchain, read-only, and the host PATH has no ${missing.join(", ")}. ` +
        "Install them on the host (Node LTS, git and the GitHub CLI), or add the folders that hold them with `create.toolchainPaths`.",
    );
  }
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
  const path = await Effect.runPromise(
    Config.string("PATH").pipe(Config.withDefault("")),
  );
  const hostPath = path
    .split(":")
    .filter((dir) => dir.startsWith("/"))
    .map((dir) => posix.normalize(dir));
  const bwrapDir = await firstHolding(hostPath, "bwrap");
  const toolchain = await resolveToolchain(hostPath, settings.toolchainPaths);
  await requireTools(toolchain.path);
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
