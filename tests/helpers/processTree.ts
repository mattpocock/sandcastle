import { execFileSync } from "node:child_process";

// The host's processes as `ps` lists them, for tests that start processes in
// process groups of their own and must kill them again. POSIX only.

/** One live process. */
export interface HostProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** Its full command line. */
  readonly args: string;
}

/** Every process on the host, from one `ps` snapshot. */
export const listProcesses = (): readonly HostProcess[] =>
  execFileSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,args="], {
    encoding: "utf8",
  })
    .split("\n")
    .flatMap((line) => {
      const fields =
        /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<pgid>\d+)\s(?<args>.*)$/u.exec(
          line,
        )?.groups;
      return fields === undefined
        ? []
        : [
            {
              pid: Number(fields.pid),
              ppid: Number(fields.ppid),
              pgid: Number(fields.pgid),
              args: fields.args ?? "",
            },
          ];
    });

/**
 * The process groups `groups` are, plus the group of every process descended
 * from a process in one of them: a process may start a child in a group of
 * its own, which a kill of its parent's group misses.
 */
export const groupsStartedBy = (
  groups: ReadonlySet<number>,
): readonly number[] => {
  const processes = listProcesses();
  const inside = new Set(
    processes.filter(({ pgid }) => groups.has(pgid)).map(({ pid }) => pid),
  );
  let grew = true;
  while (grew) {
    grew = false;
    for (const { pid, ppid } of processes) {
      if (!inside.has(pid) && inside.has(ppid)) {
        inside.add(pid);
        grew = true;
      }
    }
  }
  return [
    ...new Set(
      processes.filter(({ pid }) => inside.has(pid)).map(({ pgid }) => pgid),
    ),
  ];
};

/**
 * SIGKILLs the process groups `pids` lead and every group their processes
 * started, the way deleting a vendor's sandbox ends everything in it.
 */
export const killProcessTrees = (pids: Iterable<number | undefined>): void => {
  const groups = new Set(
    [...pids].filter((pid): pid is number => pid !== undefined),
  );
  if (groups.size === 0) {
    return;
  }
  for (const group of groupsStartedBy(groups)) {
    try {
      process.kill(-group, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
};
