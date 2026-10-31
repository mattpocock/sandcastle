/**
 * Provider-agnostic helpers for the native sandbox providers (`bwrap()`,
 * `seatbelt()`): collecting a child process's output, and copying a file
 * between host paths. Each is purely a function of its inputs.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { BoundedTail } from "./boundedTail.js";
import { CopyError } from "./errors.js";

/** Collects a child's output: streamed line by line with a bounded tail, or whole. */
export const collectOutput = (
  proc: ChildProcessWithoutNullStreams,
  onLine: ((line: string) => void) | undefined,
  maxTailChars: number,
): (() => { stdout: string; stderr: string }) => {
  const streaming = onLine !== undefined;
  const stdout = streaming
    ? new BoundedTail(maxTailChars, "\n")
    : new BoundedTail(Infinity);
  const stderr = new BoundedTail(streaming ? maxTailChars : Infinity);
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
  proc.stderr.on("data", (chunk: Buffer) => {
    stderr.push(chunk.toString());
  });
  return () => ({ stdout: stdout.toString(), stderr: stderr.toString() });
};

/** Copies a file, creating the target's parent dirs. */
export const copyCreatingParents = (
  from: string,
  to: string,
): Effect.Effect<void, CopyError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dirname(to), { recursive: true });
    yield* fs.copyFile(from, to);
  }).pipe(
    Effect.mapError(
      (e) =>
        new CopyError({
          message: `Couldn't copy ${from} to ${to}: ${e.message}`,
        }),
    ),
  );
