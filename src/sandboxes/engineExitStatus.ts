/**
 * @internal The exit status of a command run with `docker exec` or
 * `podman exec`, reported by the command's own shell in the container.
 *
 * The engine CLI's exit code can't be trusted on its own: the real `docker`
 * and `podman` CLIs trap SIGTERM (docker also SIGINT) and exit 0, so a CLI
 * killed while its command still runs looks like a success. So the command
 * runs in a subshell of a wrapper that prints its status as a last stderr
 * line once it ends. A missing line means the command never finished.
 */

import type { ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { BoundedTail } from "../boundedTail.js";
import type { ExecResult } from "../SandboxProvider.js";

const SENTINEL = "__SANDCASTLE_EXIT_STATUS=";

/**
 * Runs the command in a subshell, so its `exit` ends only the subshell, then
 * prints the status. The command arrives as `$1` and is cleared from the
 * shell's arguments and variables first, so it sees what `sh -c <command>`
 * would: `$0` is `sh`, with no arguments.
 */
const WRAPPER = [
  '__sandcastle_cmd=$1; shift; (eval "unset __sandcastle_cmd',
  "$__sandcastle_cmd",
  `"); __sandcastle_status=$?; printf '\\n${SENTINEL}%s\\n' "$__sandcastle_status" >&2; exit "$__sandcastle_status"`,
].join("\n");

/** The `sh -c` argv that runs `command` in the container and reports its status. */
export const shellArgsReportingExit = (command: string): string[] => [
  "sh",
  "-c",
  WRAPPER,
  "sh",
  command,
];

const SENTINEL_LINE = new RegExp(`\\n${SENTINEL}(\\d+)\\n$`, "u");

/**
 * The command's stderr without the status line, and its exit code: the
 * status it reported, else the CLI's own non-zero code, else 1. A CLI that
 * exits 0 without the status line was interrupted before the command ended.
 */
const resolveEngineExit = (
  stderr: string,
  cliCode: number | null,
): { readonly stderr: string; readonly exitCode: number } => {
  const match = SENTINEL_LINE.exec(stderr);
  if (match !== null) {
    return {
      stderr: stderr.slice(0, match.index),
      exitCode: Number(match[1]),
    };
  }
  return { stderr, exitCode: cliCode === null || cliCode === 0 ? 1 : cliCode };
};

/** A spawned `<engine> exec`, with stdout and stderr piped. */
type EngineExecProcess = ChildProcessByStdio<
  Writable | null,
  Readable,
  Readable
>;

/**
 * Collects an `<engine> exec`'s output, streaming stdout lines to `onLine`
 * when given (keeping bounded tails), and calls `done` with the result once
 * the CLI closes.
 */
export const collectEngineExec = (
  proc: EngineExecProcess,
  {
    onLine,
    maxOutputTailChars,
  }: {
    readonly onLine: ((line: string) => void) | undefined;
    readonly maxOutputTailChars: number;
  },
  done: (result: ExecResult) => void,
): void => {
  // Only a streamed exec keeps bounded tails; a buffered one keeps it all.
  const maxChars =
    onLine === undefined ? Number.POSITIVE_INFINITY : maxOutputTailChars;
  const stderr = new BoundedTail(maxChars, "");
  proc.stderr.on("data", (chunk: Buffer) => {
    stderr.push(chunk.toString());
  });
  const stdout = new BoundedTail(maxChars, onLine === undefined ? "" : "\n");
  if (onLine === undefined) {
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk.toString());
    });
  } else {
    createInterface({ input: proc.stdout }).on("line", (line) => {
      stdout.push(line);
      onLine(line);
    });
  }
  proc.on("close", (code: number | null) => {
    done({
      stdout: stdout.toString(),
      ...resolveEngineExit(stderr.toString(), code),
    });
  });
};
