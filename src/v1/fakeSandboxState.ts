import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Schema } from "effect";

// A fake sandbox's state lives in its own directory, so any fakeSandbox()
// instance (or process) with the same rootDir can find or close it.

const FakeState = Schema.Struct({
  killTime: Schema.String,
  hostPath: Schema.String,
  env: Schema.Record({ key: Schema.String, value: Schema.String }),
});

/** What a fake sandbox keeps on disk. */
export type FakeState = typeof FakeState.Type;

const decodeState = Schema.decodeUnknownOption(Schema.parseJson(FakeState));

const stateDir = (dir: string): string => path.join(dir, ".fake");
const groupsDir = (dir: string): string => path.join(stateDir(dir), "groups");
const stateFile = (dir: string): string =>
  path.join(stateDir(dir), "state.json");

/** Writes a new sandbox's state. */
export const writeState = async (dir: string, state: FakeState) => {
  await mkdir(groupsDir(dir), { recursive: true });
  await writeFile(stateFile(dir), JSON.stringify(state), { mode: 0o600 });
};

/** A sandbox's state, or `undefined` when it has gone. */
export const readState = async (
  dir: string,
): Promise<FakeState | undefined> => {
  const text = await readFile(stateFile(dir), "utf8").catch(() => undefined);
  if (text === undefined) {
    return undefined;
  }
  const state = decodeState(text);
  return state._tag === "Some" ? state.value : undefined;
};

/** Remembers a process group the sandbox started, so close() can kill it. */
export const recordGroup = async (dir: string, pid: number) => {
  await writeFile(path.join(groupsDir(dir), String(pid)), "");
};

/** Kills a whole process group; a group that already ended is fine. */
export const killGroup = (pid: number): void => {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group has already exited.
  }
};

// Kills every process group the sandbox's processes are in or started: the
// groups it recorded, and the group of each process descended from those. A
// process in the sandbox may put a child in a group of its own (the session
// supervisor does, for each agent), and killing only the recorded groups
// leaves that child running, orphaned. It takes one `ps` snapshot before any
// kill, while each child still has its parent. It spares its own group, so
// the reaper lives to remove the directory.
const KILL_SANDBOX = String.raw`recorded=$(ls "$SANDCASTLE_FAKE_DIR/.fake/groups" 2>/dev/null)
ps -A -o pid= -o ppid= -o pgid= | awk -v recorded="$recorded" -v self="$$" '
  BEGIN { n = split(recorded, r, "\n"); for (i = 1; i <= n; i++) if (r[i] != "") want[r[i]] = 1 }
  { parent[$1] = $2; group[$1] = $3; if ($3 in want) inside[$1] = 1 }
  END {
    do {
      grew = 0
      for (p in parent) if (!(p in inside) && (parent[p] in inside)) { inside[p] = 1; grew = 1 }
    } while (grew)
    for (p in inside) doomed[group[p]] = 1
    for (g in doomed) if (g != self) print g
  }' | while read -r group; do kill -KILL "-$group" 2>/dev/null; done`;

const SCRIPT_PATH = "/usr/bin:/bin";

/** Kills every process the sandbox started, and every process those started. */
const killSandbox = async (dir: string) => {
  const killer = spawn("sh", ["-c", KILL_SANDBOX], {
    stdio: "ignore",
    env: { PATH: SCRIPT_PATH, SANDCASTLE_FAKE_DIR: dir },
  });
  try {
    await once(killer, "close");
  } catch {
    // No `sh`: nothing this fake started could have run either.
  }
};

/** Kills every process the sandbox started and removes its directory. */
export const destroy = async (dir: string) => {
  await killSandbox(dir);
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
};

// Kills the sandbox's processes but itself, then removes the sandbox.
const REAPER = [
  'sleep "$SANDCASTLE_FAKE_LIFE_SECONDS"',
  KILL_SANDBOX,
  'rm -rf "$SANDCASTLE_FAKE_DIR"',
].join("\n");

/**
 * Starts a detached process that kills the sandbox at its kill time, like a
 * vendor's time limit: it holds even if the process that made it exits.
 * close() kills it with the rest of the sandbox's groups.
 */
export const startReaper = async (dir: string, lifeSeconds: number) => {
  const reaper = spawn("sh", ["-c", REAPER], {
    detached: true,
    stdio: "ignore",
    env: {
      PATH: SCRIPT_PATH,
      SANDCASTLE_FAKE_DIR: dir,
      SANDCASTLE_FAKE_LIFE_SECONDS: lifeSeconds.toFixed(3),
    },
  });
  reaper.unref();
  if (reaper.pid !== undefined) {
    await recordGroup(dir, reaper.pid);
  }
};
