/**
 * The `exec` of the Vercel sandbox provider (`./vercel.ts`): stdin through a
 * file, live line streaming with bounded tails, or buffered output.
 */

import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import type { SandboxInstance } from "@vercel/sandbox";
import type { ExecResult } from "../SandboxProvider.js";
import { BoundedTail } from "../boundedTail.js";

export type RunCommandParams = Parameters<SandboxInstance["runCommand"]>[0];

/**
 * The command to run for `exec`. `runCommand` gives a command no stdin
 * unless it is detached: the command reads EOF. So write stdin to a file in
 * the sandbox and redirect it in (a file, not an argument, keeps clear of the
 * per-arg size limit). The redirect opens the file before the group runs, so
 * the group can delete it straight away and leave nothing behind.
 */
export const withStdin = async (
  sandbox: SandboxInstance,
  command: string,
  stdin: string | undefined,
): Promise<string> => {
  if (stdin === undefined) {
    return command;
  }
  const stdinPath = `/tmp/sandcastle-stdin-${randomUUID()}`;
  await sandbox.writeFiles([{ path: stdinPath, content: Buffer.from(stdin) }]);
  return `{ rm -f ${stdinPath}; ${command}\n} < ${stdinPath}`;
};

/**
 * A stream that hands each stdout line to `onLine` and keeps a bounded tail.
 * The SDK never ends it, so `final()` never runs: call `flush()` once the
 * command has finished to deliver a last line that has no trailing newline.
 * Flushing twice delivers it once.
 */
const lineWritable = (
  onLine: (line: string) => void,
  tail: BoundedTail,
): { readonly stream: Writable; readonly flush: () => void } => {
  let partial = "";
  const flush = (): void => {
    if (partial) {
      tail.push(partial);
      onLine(partial);
      partial = "";
    }
  };
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const text = partial + chunk.toString();
      const lines = text.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        tail.push(line);
        onLine(line);
      }
      callback();
    },
    final(callback) {
      flush();
      callback();
    },
  });
  return { stream, flush };
};

/** A stream that only keeps a bounded tail of what is written to it. */
const tailWritable = (tail: BoundedTail): Writable =>
  new Writable({
    write(chunk: Buffer, _encoding, callback) {
      tail.push(chunk.toString());
      callback();
    },
  });

/** Run a command, streaming stdout lines to `onLine`; returns bounded tails. */
export const execStreamed = async (
  sandbox: SandboxInstance,
  params: RunCommandParams,
  {
    onLine,
    maxOutputTailChars,
  }: {
    readonly onLine: (line: string) => void;
    readonly maxOutputTailChars: number;
  },
): Promise<ExecResult> => {
  const stdoutTail = new BoundedTail(maxOutputTailChars, "\n");
  const stderrTail = new BoundedTail(maxOutputTailChars, "");
  const stdout = lineWritable(onLine, stdoutTail);
  const result = await sandbox.runCommand({
    ...params,
    stdout: stdout.stream,
    stderr: tailWritable(stderrTail),
  });
  stdout.flush();
  return {
    stdout: stdoutTail.toString(),
    stderr: stderrTail.toString(),
    exitCode: result.exitCode,
  };
};

/** Run a command to completion and return its whole output. */
export const execBuffered = async (
  sandbox: SandboxInstance,
  params: RunCommandParams,
): Promise<ExecResult> => {
  const result = await sandbox.runCommand(params);
  const stdout = await result.stdout();
  const stderr = await result.stderr();
  return { stdout, stderr, exitCode: result.exitCode };
};
