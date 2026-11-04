/**
 * Native sandboxes (`bwrap()`) as the harness sees them: no container to
 * inspect, just host processes. A world's bwrap is one whose arguments name a
 * path inside the world (its worktree, its private dirs). The env that
 * reached the sandbox is the env of bwrap's first non-bwrap descendant: bwrap
 * itself, and the copies of it it forks, keep the host env it was started
 * with in /proc/<pid>/environ, even after `--clearenv`.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyEnv } from "./envLeaks.ts";
import type { EnvContext, EnvLeak } from "./envLeaks.ts";

/** One host process, as /proc describes it. */
export interface Proc {
  readonly pid: number;
  readonly ppid: number;
  /** The executable's name (/proc/<pid>/comm). */
  readonly comm: string;
  readonly cmdline: readonly string[];
}

/** A world's bwrap and the pids of the commands running inside it. */
export interface BwrapSandbox {
  readonly bwrapPid: number;
  readonly sandboxed: readonly number[];
}

const BWRAP = "bwrap";

/** Every bwrap started for the world at `worldDir`, outermost bwrap first. */
export const worldBwrapSandboxes = (
  procs: readonly Proc[],
  worldDir: string,
): BwrapSandbox[] => {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const children = (pid: number): Proc[] => procs.filter((p) => p.ppid === pid);
  const sandboxedUnder = (pid: number): number[] =>
    children(pid).flatMap((c) =>
      c.comm === BWRAP ? sandboxedUnder(c.pid) : [c.pid],
    );
  return procs
    .filter(
      (p) =>
        p.comm === BWRAP &&
        byPid.get(p.ppid)?.comm !== BWRAP &&
        p.cmdline.some((arg) => arg.startsWith(`${worldDir}/`)),
    )
    .map((p) => ({ bwrapPid: p.pid, sandboxed: sandboxedUnder(p.pid) }));
};

/** `bwrap()`'s private dirs (home and /tmp) in a temp dir listing. */
export const bwrapStateDirs = (entries: readonly string[]): string[] =>
  entries.filter((name) => name.startsWith("sandcastle-bwrap-"));

// --- Reading /proc ------------------------------------------------------------

const readOrUndefined = async (path: string): Promise<string | undefined> =>
  readFile(path, "utf8").catch(() => undefined);

const readProc = async (pid: number): Promise<Proc | undefined> => {
  const [stat, cmdline] = await Promise.all([
    readOrUndefined(join("/proc", String(pid), "stat")),
    readOrUndefined(join("/proc", String(pid), "cmdline")),
  ]);
  if (stat === undefined || cmdline === undefined) {
    return undefined;
  }
  // `pid (comm) state ppid …`; comm may itself hold spaces and parens.
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  const ppid = Number(stat.slice(close + 2).split(" ")[1]);
  return {
    pid,
    ppid,
    comm: stat.slice(open + 1, close),
    cmdline: cmdline.split("\0").filter((arg) => arg !== ""),
  };
};

/** Every process on this host (empty where there is no /proc). */
export const listProcs = async (): Promise<Proc[]> => {
  const entries = await readdir("/proc").catch((): string[] => []);
  const procs = await Promise.all(
    entries
      .filter((name) => /^\d+$/u.test(name))
      .map(async (name) => readProc(Number(name))),
  );
  return procs.filter((p): p is Proc => p !== undefined);
};

/** A process's env as name/value pairs, or undefined once it has exited. */
export const readEnviron = async (
  pid: number,
): Promise<[string, string][] | undefined> => {
  const raw = await readOrUndefined(join("/proc", String(pid), "environ"));
  if (raw === undefined) {
    return undefined;
  }
  return raw
    .split("\0")
    .filter((entry) => entry.includes("="))
    .map((entry) => {
      const i = entry.indexOf("=");
      return [entry.slice(0, i), entry.slice(i + 1)];
    });
};

// --- What the harness does with them -------------------------------------------

/** One observed bwrap: the env its sandboxed command started with. */
export interface BwrapObservation {
  /** `bwrap:<pid>` of the outermost bwrap. */
  readonly key: string;
  /** The sandboxed command's executable name. */
  readonly command: string;
  readonly envNames: string[];
  readonly leaks: EnvLeak[];
}

/**
 * Every world bwrap not yet in `seen` whose sandboxed command is running:
 * its env names, checked for leaks. Adds each one to `seen`.
 */
export const observeWorldBwraps = async (
  worldDir: string,
  ctx: EnvContext,
  seen: Set<string>,
): Promise<BwrapObservation[]> => {
  const procs = await listProcs();
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const fresh = worldBwrapSandboxes(procs, worldDir).flatMap((sandbox) => {
    const key = `${BWRAP}:${sandbox.bwrapPid}`;
    const [pid] = sandbox.sandboxed;
    return seen.has(key) || pid === undefined ? [] : [{ key, pid }];
  });
  const observed = await Promise.all(
    fresh.map(async ({ key, pid }) => {
      const env = await readEnviron(pid);
      return env === undefined
        ? []
        : [
            {
              key,
              command: byPid.get(pid)?.comm ?? "?",
              envNames: env.map(([name]) => name),
              leaks: classifyEnv(env, ctx),
            },
          ];
    }),
  );
  const out = observed.flat();
  for (const o of out) {
    seen.add(o.key);
  }
  return out;
};

/** Ledger (c) for native sandboxes: world bwraps still running, private dirs left in the world's TMPDIR. */
export const leftoverBwrap = async (
  worldDir: string,
  worldTmpDir: string,
): Promise<{ leaks: string[]; notes: string[] }> => {
  const sandboxes = worldBwrapSandboxes(await listProcs(), worldDir);
  const dirs = bwrapStateDirs(
    await readdir(worldTmpDir).catch((): string[] => []),
  );
  const leaks = [
    ...sandboxes.map((s) => `bwrap process ${s.bwrapPid} still running`),
    ...dirs.map((d) => `bwrap() private dir tmp/${d} left behind`),
  ];
  return {
    leaks,
    notes: leaks.length > 0 ? [] : ["no bwrap process or private dir left"],
  };
};
