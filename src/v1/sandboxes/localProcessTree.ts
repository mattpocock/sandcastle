import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

// Killing everything a local sandbox's keeper started, by process group
// only: never `kill -1`, which on a host with no PID namespace (macOS) is
// every process the user has. A command can move its children into groups
// of their own (a `detached` spawn, setsid), so the keeper finds them by
// walking the process tree down from a root, and kills each group in it.
// A process whose parent has already exited has left the tree, so a group
// kill is all that reaches it.

const run = promisify(execFile);

/** `ps` by absolute path: the keeper runs with no `PATH`. */
const PS_CANDIDATES = ["/bin/ps", "/usr/bin/ps"];
/** Walks the tree this many times, for children forked while it was killing. */
const ROUNDS = 3;

interface Row {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
}

const psPath = async (): Promise<string | undefined> => {
  const found = await Promise.all(
    PS_CANDIDATES.map(async (path) =>
      access(path).then(
        () => path,
        () => undefined,
      ),
    ),
  );
  return found.find((path) => path !== undefined);
};

/** Every process on the host, or none when `ps` can't be run. */
const processTable = async (): Promise<Row[]> => {
  const ps = await psPath();
  if (ps === undefined) {
    return [];
  }
  const output = await run(ps, ["-A", "-o", "pid=,ppid=,pgid="], {
    env: {},
    maxBuffer: 16 * 1024 * 1024,
  }).then(
    ({ stdout }) => stdout,
    () => "",
  );
  return output.split("\n").flatMap((line) => {
    const [pid, ppid, pgid] = line.trim().split(/\s+/u).map(Number);
    return pid !== undefined &&
      ppid !== undefined &&
      pgid !== undefined &&
      [pid, ppid, pgid].every((n) => Number.isInteger(n))
      ? [{ pid, ppid, pgid }]
      : [];
  });
};

/** The process groups of `roots` and of every process below them, but never `spare`'s. */
const groupsBelow = (
  table: readonly Row[],
  roots: readonly number[],
  spare: number,
): Set<number> => {
  const children = new Map<number, Row[]>();
  for (const row of table) {
    children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  }
  const groups = new Set<number>();
  const seen = new Set<number>();
  const queue = [...roots];
  for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
    if (!seen.has(pid)) {
      seen.add(pid);
      for (const child of children.get(pid) ?? []) {
        groups.add(child.pgid);
        queue.push(child.pid);
      }
    }
  }
  for (const row of table) {
    if (roots.includes(row.pid)) {
      groups.add(row.pgid);
    }
  }
  groups.delete(spare);
  for (const group of groups) {
    // 0 and 1 would mean "my own group" and init's.
    if (group <= 1) {
      groups.delete(group);
    }
  }
  return groups;
};

/** SIGKILLs process group `pgid`. */
export const killGroup = (pgid: number | undefined): void => {
  if (pgid === undefined || pgid <= 1) {
    return;
  }
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // Already gone.
  }
};

/**
 * SIGKILLs the process groups of `roots` and of every process below them,
 * sparing this process's own group. Walks the tree again, for children
 * forked while it was killing, until none is left or after a few walks.
 */
export const killProcessTree = async (
  roots: readonly number[],
  rounds = ROUNDS,
): Promise<void> => {
  if (rounds === 0) {
    return;
  }
  const table = await processTable();
  const own = table.find((row) => row.pid === process.pid)?.pgid ?? -1;
  const groups = groupsBelow(table, roots, own);
  if (groups.size === 0) {
    return;
  }
  for (const group of groups) {
    killGroup(group);
  }
  await killProcessTree(roots, rounds - 1);
};
