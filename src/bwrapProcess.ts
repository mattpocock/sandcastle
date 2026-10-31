/**
 * The processes behind one `bwrap()` exec, and how to kill all of them. Used
 * only by `bwrap()`, through src/bwrapSandbox.ts.
 */

import type { ChildProcess } from "node:child_process";

/** The fd bwrap reports the sandbox's PID 1 on (`--info-fd`). */
export const INFO_FD = 3;

/**
 * One exec's bwrap. `proc` is the outer bwrap; `sandboxPid` is the host PID
 * of the sandbox's PID 1, once bwrap has reported it on {@link INFO_FD}.
 * Killing only the outer bwrap leaves the sandbox running: its PID 1 has its
 * own session and outlives its parent. Killing PID 1 ends every process in
 * the sandbox's PID namespace.
 */
export interface SandboxProcess {
  readonly proc: ChildProcess;
  sandboxPid: number | undefined;
  /** Settles once bwrap has reported the PID, or closed its info fd without one. */
  readonly reported: Promise<void>;
}

const CHILD_PID = /"child-pid"\s*:\s*(?<pid>\d+)/u;

/** The `child-pid` in bwrap's `--info-fd` JSON, if it has one. */
export const parseChildPid = (info: string): number | undefined => {
  const pid = CHILD_PID.exec(info)?.groups?.["pid"];
  return pid === undefined ? undefined : Number(pid);
};

/** SIGKILLs the sandbox's PID 1, if reported, and the outer bwrap. Synchronous, for shutdown. */
export const killSandboxProcess = (sandbox: SandboxProcess): void => {
  if (sandbox.sandboxPid !== undefined) {
    try {
      process.kill(sandbox.sandboxPid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  sandbox.proc.kill("SIGKILL");
};
