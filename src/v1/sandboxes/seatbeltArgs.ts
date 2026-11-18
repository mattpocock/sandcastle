import { realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SANDBOX_EXEC, sandboxExecArgs } from "../../seatbeltSandbox.js";
import { LIFELINE_FD } from "./localKeeperServer.js";
import type { LocalSetup } from "./localProviderSandbox.js";
import type { LocalSandboxFolder } from "./localSandboxState.js";
import type { LocalSettings } from "./localToolchain.js";
import { hostPathDirs, hostToolchain, requireTools } from "./localToolchain.js";
import type { SeatbeltPolicy } from "./seatbeltPolicy.js";
import { SYSTEM_READ_ROOTS, sandboxPolicy } from "./seatbeltPolicy.js";

// The argv and env of each seatbelt() command: `sandbox-exec` with the
// sandbox's profile, run by its keeper. Seatbelt can't remap paths, so the
// sandbox sees its folder's home and tmp at their real host paths, and the
// host toolchain read-only at its own. Nothing else of the host's: no
// checkout, no home, no host tmp.

/** What a sandbox is made of, kept in its folder so a reattach reads it back. */
export type SeatbeltSettings = LocalSettings;

const FALLBACK_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** Where `xcode-select` points: the developer dir `/usr/bin/git` and friends run from. */
const XCODE_SELECT_LINK = "/var/db/xcode_select_link";

/** Folders whose contents the sandbox never sees, beyond what it's given. */
const HIDDEN_ROOTS = [
  "/Users",
  "/Volumes",
  "/private/tmp",
  "/private/var/folders",
];

const realOrNothing = async (path: string): Promise<string[]> =>
  realpath(path).then(
    (real) => [real],
    () => [],
  );

/**
 * Runs `command` under a watcher: a background shell blocked on the
 * keeper's lifeline, which SIGKILLs the command's process group (never
 * `kill -1`: there's no PID namespace, so that would be every process the
 * user has) once the keeper dies, however it dies. The command itself runs
 * without the lifeline. The keeper kills the group as the command exits, so
 * the watcher never outlives it.
 */
const WATCHED = `{ read -r _ || :; kill -9 0; } <&${LIFELINE_FD} >/dev/null 2>&1 &
exec ${LIFELINE_FD}<&-
exec /bin/sh -c "$1"`;

/** The sandbox's profile: its own home and tmp, and the host toolchain read-only. */
const policyFor = async ({
  home,
  tmp,
  toolchain,
  settings,
}: {
  readonly home: string;
  readonly tmp: string;
  readonly toolchain: Awaited<ReturnType<typeof hostToolchain>>;
  readonly settings: SeatbeltSettings;
}): Promise<SeatbeltPolicy> => {
  const extra = settings.toolchainPaths;
  const hidden = await Promise.all(
    [homedir(), tmpdir(), ...HIDDEN_ROOTS].map(async (dir) =>
      realOrNothing(dir),
    ),
  );
  const extraReal = await Promise.all(
    extra.map(async (dir) => realOrNothing(dir)),
  );
  return sandboxPolicy({
    readableRoots: [
      ...SYSTEM_READ_ROOTS,
      ...(await realOrNothing(XCODE_SELECT_LINK)),
      ...toolchain.readableDirs,
      ...extraReal.flat(),
    ],
    writableRoots: [home, tmp],
    lookupPaths: [...toolchain.pathEntries, ...extra],
    hiddenRoots: hidden.flat(),
    network: settings.network,
    hostHome: homedir(),
  });
};

/**
 * How to run commands in the sandbox in `folder`. Rejects, before anything
 * runs, when a required tool isn't on the host PATH.
 */
export const seatbeltSetup = async (
  folder: LocalSandboxFolder,
  settings: SeatbeltSettings,
): Promise<LocalSetup> => {
  // Seatbelt matches real paths (/private/var/…, not /var/…).
  const real = await realpath(folder.path);
  const home = join(real, "home");
  const tmp = join(real, "tmp");
  const extra = settings.toolchainPaths;
  const toolchain = await hostToolchain(await hostPathDirs(), {
    systemDirs: SYSTEM_READ_ROOTS,
    deniedRoots: [],
  });
  const found = [...toolchain.pathEntries, ...extra];
  const path = found.length > 0 ? found : FALLBACK_PATH;
  await requireTools("seatbelt", path);
  const policy = await policyFor({ home, tmp, toolchain, settings });
  return {
    workingDirectory: join(home, "workspace"),
    launch: ({ command, workingDirectory, sudo, env }) => {
      if (sudo) {
        throw new Error(
          "seatbelt() has no root: exec with `sudo: true` isn't supported. Install what you need on the host, or into the sandbox's home.",
        );
      }
      // `cd` in the sandbox: the keeper, outside it, can't see the folder it names.
      const script = `cd -- "$2" || exit 1\n${WATCHED}`;
      return {
        argv: [
          SANDBOX_EXEC,
          ...sandboxExecArgs(policy, script),
          "sh",
          command,
          workingDirectory,
        ],
        env: { PATH: path.join(":"), HOME: home, TMPDIR: tmp, ...env },
        endGroupOnExit: true,
      };
    },
  };
};
