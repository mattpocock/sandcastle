/**
 * Daytona session plumbing: preparing a command for `exec`, probing a
 * session's shell, and streaming a session command's logs.
 */

import type { Sandbox as DaytonaSandbox } from "@daytona/sdk";
import { BoundedTail } from "../boundedTail.js";

const shellEscape = (s: string): string =>
  `'${s.replaceAll("'", String.raw`'\''`)}'`;

/** Options `exec` accepts. */
export interface DaytonaExecOptions {
  readonly onLine?: (line: string) => void;
  readonly cwd?: string;
  readonly sudo?: boolean;
  readonly stdin?: string;
}

/** The sandbox a handle drives, and the settings its `exec` needs. */
export interface DaytonaExecContext {
  readonly sandbox: DaytonaSandbox;
  readonly worktreePath: string;
  readonly maxOutputTailChars: number;
}

/**
 * `command` ready to run: wrapped in `sudo sh -c` when asked, and with any
 * stdin uploaded to a file in the sandbox and redirected in.
 */
export const prepareCommand = async (
  sandbox: DaytonaSandbox,
  command: string,
  opts: DaytonaExecOptions | undefined,
): Promise<string> => {
  // Wrap the whole command in `sh -c`, so sudo elevates all of it
  // (`a && b`, not just `a`).
  const effectiveCommand =
    opts?.sudo === true ? `sudo sh -c ${shellEscape(command)}` : command;
  if (opts?.stdin === undefined) {
    return effectiveCommand;
  }
  // Daytona's exec APIs have no stdin channel: the command reads
  // EOF. So write stdin to a file in the sandbox and redirect it in
  // (a file, not an argument, keeps clear of the per-arg size
  // limit). The redirect opens the file before the group runs, so
  // the group can delete it straight away and leave nothing behind.
  const stdinPath = `/tmp/sandcastle-stdin-${crypto.randomUUID()}`;
  await sandbox.fs.uploadFile(Buffer.from(opts.stdin), stdinPath);
  return `{ rm -f ${stdinPath}; ${effectiveCommand}\n} < ${stdinPath}`;
};

/** A running session command, and the file holding its shell's PID. */
export interface SessionCommand {
  readonly sessionId: string;
  readonly cmdId: string;
  readonly pidPath: string;
}

/**
 * Whether a session's shell is still `alive`; if not, whether its command
 * `exited` with a recorded exit code or was `lost` without one.
 */
export const probeSessionShell = async (
  sandbox: DaytonaSandbox,
  { sessionId, cmdId, pidPath }: SessionCommand,
): Promise<"alive" | "exited" | "lost"> => {
  const alive = await sandbox.process
    .executeCommand(`test ! -f ${pidPath} || kill -0 "$(cat ${pidPath})"`)
    .then((r) => r.exitCode === 0)
    .catch(() => true);
  if (alive) {
    return "alive";
  }
  const cmd = await sandbox.process
    .getSessionCommand(sessionId, cmdId)
    .catch(() => undefined);
  return typeof cmd?.exitCode === "number" ? "exited" : "lost";
};

/**
 * Streams a running session command's stdout to `onLine`, line by line,
 * keeping a bounded tail of stdout and stderr. `done` settles once the log
 * stream closes; `flush` then emits any final unterminated line.
 */
export const streamSessionLogs = (
  { sandbox, maxOutputTailChars }: DaytonaExecContext,
  { sessionId, cmdId }: { readonly sessionId: string; readonly cmdId: string },
  onLine: (line: string) => void,
) => {
  const stdoutTail = new BoundedTail(maxOutputTailChars, "\n");
  const stderrTail = new BoundedTail(maxOutputTailChars, "");
  let partial = "";
  const done = sandbox.process.getSessionCommandLogs(
    sessionId,
    cmdId,
    (chunk: string) => {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        stdoutTail.push(line);
        onLine(line);
      }
    },
    (chunk: string) => {
      stderrTail.push(chunk);
    },
  );
  const flush = () => {
    if (partial) {
      stdoutTail.push(partial);
      onLine(partial);
    }
  };
  return { done, flush, stdoutTail, stderrTail };
};
