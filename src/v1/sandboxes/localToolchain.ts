import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { posix } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { Config, Effect } from "effect";
import type { HostPathToolchain } from "../../hostPathToolchain.js";
import { resolveHostPathToolchain } from "../../hostPathToolchain.js";

// The host toolchain a local sandbox (bwrap(), seatbelt()) runs, read-only:
// the host's system folders, and the folders on the host PATH that hold
// node, git, gh and the agent CLIs. Provider-agnostic: it finds folders, and
// each provider decides how to show them.

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

const isWithin = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}/`);

const isExecutable = async (dir: string, name: string): Promise<boolean> =>
  access(posix.join(dir, name), constants.X_OK).then(
    () => true,
    () => false,
  );

/** The first of `dirs` that holds an executable `name`. */
export const firstHolding = async (
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

/** The host `PATH`'s absolute folders, normalized. */
export const hostPathDirs = async (): Promise<string[]> => {
  const path = await Effect.runPromise(
    Config.string("PATH").pipe(Config.withDefault("")),
  );
  return path
    .split(":")
    .filter((dir) => dir.startsWith("/"))
    .map((dir) => posix.normalize(dir));
};

/**
 * The host toolchain for a sandbox: of the host `PATH`, the system folders
 * and those holding a tool, and the install roots their symlinks lead to.
 * Never the home folder or a folder above it, nor anything in `deniedRoots`.
 */
export const hostToolchain = async (
  hostPath: readonly string[],
  roots: {
    readonly systemDirs: readonly string[];
    readonly deniedRoots: readonly string[];
  },
): Promise<HostPathToolchain> => {
  const keep = await Promise.all(
    hostPath.map(
      async (dir) =>
        roots.systemDirs.some((root) => isWithin(dir, root)) || holdsTool(dir),
    ),
  );
  const dirs = hostPath.filter((_, index) => keep[index] === true);
  return Effect.runPromise(
    resolveHostPathToolchain({
      path: dirs.join(":"),
      home: homedir(),
      coveredRoots: roots.systemDirs,
      deniedRoots: roots.deniedRoots,
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
};

/** Rejects, naming them, when the sandbox's PATH lacks a required tool. */
export const requireTools = async (
  provider: string,
  path: readonly string[],
): Promise<void> => {
  const found = await Promise.all(
    REQUIRED_TOOLS.map(async (tool) => firstHolding(path, tool)),
  );
  const missing = REQUIRED_TOOLS.filter(
    (_, index) => found[index] === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      `${provider}() runs the host's own toolchain, read-only, and the host PATH has no ${missing.join(", ")}. ` +
        "Install them on the host (Node LTS, git and the GitHub CLI), or add the folders that hold them with `create.toolchainPaths`.",
    );
  }
};

/** What a local sandbox is made of, kept in its folder so a reattach reads it back. */
export interface LocalSettings {
  readonly network: "host" | "none";
  readonly toolchainPaths: readonly string[];
}

const isWithinOrRoot = (path: string, root: string): boolean =>
  root === "/" || isWithin(path, root);

/**
 * A local provider's create options, checked: each toolchain path absolute,
 * and none the home folder or a folder above it. Throws a `TypeError` naming
 * `provider` otherwise.
 */
export const localSettings = (
  provider: string,
  create:
    | {
        readonly network?: "host" | "none";
        readonly toolchainPaths?: readonly string[];
      }
    | undefined,
): LocalSettings => {
  const home = homedir();
  const toolchainPaths = (create?.toolchainPaths ?? []).map((path) => {
    if (!path.startsWith("/")) {
      throw new TypeError(
        `${provider}(): create.toolchainPaths must be absolute, got "${path}"`,
      );
    }
    const normalized = posix.normalize(path).replace(/(?<=.)\/$/u, "");
    if (isWithinOrRoot(home, normalized)) {
      throw new TypeError(
        `${provider}(): create.toolchainPaths can't show "${path}": it is your home folder, or holds it`,
      );
    }
    return normalized;
  });
  return { network: create?.network ?? "host", toolchainPaths };
};
