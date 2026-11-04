import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

/** Kills every process the sandbox started and removes its directory. */
export const destroy = async (dir: string) => {
  const groups = await readdir(groupsDir(dir)).catch((): string[] => []);
  for (const group of groups) {
    killGroup(Number(group));
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
};

// Kills every recorded process group but its own, then removes the sandbox.
const REAPER = [
  'sleep "$SANDCASTLE_FAKE_LIFE_SECONDS"',
  'for group in $(ls "$SANDCASTLE_FAKE_DIR/.fake/groups"); do',
  '  [ "$group" = "$$" ] || kill -KILL "-$group"',
  "done 2>/dev/null",
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
      PATH: "/usr/bin:/bin",
      SANDCASTLE_FAKE_DIR: dir,
      SANDCASTLE_FAKE_LIFE_SECONDS: lifeSeconds.toFixed(3),
    },
  });
  reaper.unref();
  if (reaper.pid !== undefined) {
    await recordGroup(dir, reaper.pid);
  }
};
