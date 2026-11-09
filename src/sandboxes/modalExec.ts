/**
 * Waiting on a command in a Modal sandbox: stdin, streamed or buffered
 * output, and the exit code. Used by `modal()` only.
 */

import type { ExecResult } from "../SandboxProvider.js";
import { BoundedTail } from "../boundedTail.js";
import type { ContainerProcess } from "modal";

/** Read a text stream to its end, handing each line to `onLine`. */
const forEachLine = async (
  stream: ReadableStream<string>,
  onLine: (line: string) => void,
): Promise<void> => {
  let partial = "";
  for await (const chunk of stream) {
    const lines = (partial + chunk).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      onLine(line);
    }
  }
  // A last line with no trailing newline is still a line.
  if (partial !== "") {
    onLine(partial);
  }
};

/** Read a text stream to its end, keeping a bounded tail of it. */
const drainInto = async (
  stream: ReadableStream<string>,
  tail: BoundedTail,
): Promise<void> => {
  for await (const chunk of stream) {
    tail.push(chunk);
  }
};

/** Pipe `stdin` (if any) to the process, then close it so it reads EOF. */
export const feedStdin = async (
  proc: ContainerProcess<string>,
  stdin: string | undefined,
): Promise<void> => {
  if (stdin !== undefined && stdin !== "") {
    await proc.stdin.writeText(stdin);
  }
  await proc.stdin.close();
};

/** Wait for a process, streaming its stdout lines to `onLine`. */
export const collectStreamed = async (
  proc: ContainerProcess<string>,
  onLine: (line: string) => void,
  maxOutputTailChars: number,
): Promise<ExecResult> => {
  const stdoutTail = new BoundedTail(maxOutputTailChars, "\n");
  const stderrTail = new BoundedTail(maxOutputTailChars, "");
  await Promise.all([
    forEachLine(proc.stdout, (line) => {
      stdoutTail.push(line);
      onLine(line);
    }),
    drainInto(proc.stderr, stderrTail),
  ]);
  const exitCode = await proc.wait();
  return {
    stdout: stdoutTail.toString(),
    stderr: stderrTail.toString(),
    exitCode,
  };
};

/** Wait for a process and return its whole output. */
export const collectBuffered = async (
  proc: ContainerProcess<string>,
): Promise<ExecResult> => {
  const [stdout, stderr] = await Promise.all([
    proc.stdout.readText(),
    proc.stderr.readText(),
  ]);
  const exitCode = await proc.wait();
  return { stdout, stderr, exitCode };
};
