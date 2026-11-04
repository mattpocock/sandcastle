import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionRecord, SessionRecordOptions } from "./SessionRecord.js";

// Host side, while the handle is held: the sinks that run on your machine.
// The supervisor sends the record back, already redacted, before the session
// ends; these write it to a directory and hand it to your function.

const EXTENSIONS = { "claude-code-jsonl": ".jsonl" } as const;

/** A name made safe to use as one path segment. */
const segment = (name: string): string =>
  name.replaceAll(/[^A-Za-z0-9._-]/gu, "_");

/** Writes `<path>/<sandboxId>/<name>.json`, and the native transcript beside it. */
const writeToDirectory = async (
  directory: string,
  record: SessionRecord,
): Promise<void> => {
  const dir = path.join(directory, segment(record.sandboxId));
  const base = path.join(dir, segment(record.name));
  await mkdir(dir, { recursive: true });
  await writeFile(`${base}.json`, `${JSON.stringify(record, null, 2)}\n`);
  const { native } = record;
  if (native !== undefined) {
    await writeFile(
      `${base}${EXTENSIONS[native.format]}`,
      Buffer.from(native.content, "base64"),
    );
  }
};

/** Runs the session's host sinks on its record; rejects with the first sink's error. */
const runHostSinks = async (
  options: SessionRecordOptions,
  record: SessionRecord,
): Promise<void> => {
  if (options.directory !== undefined) {
    await writeToDirectory(options.directory.path, record);
  }
  await options.onRecord?.(record);
};

/**
 * Starts the session's host sinks on its record. Its failure is reported
 * through `whenSunk` once the session ends, never as an unhandled rejection.
 */
export const startHostSinks = (
  options: SessionRecordOptions | undefined,
  record: SessionRecord,
): Promise<void> => {
  const sinking =
    options === undefined ? Promise.resolve() : runHostSinks(options, record);
  sinking.catch(() => undefined);
  return sinking;
};

/** Calls `settled` once the host sinks are done: with the failure, if one failed. */
export const whenSunk = (
  sinking: Promise<void> | undefined,
  settled: (failure: { readonly cause: unknown } | undefined) => void,
): void => {
  const done = async () => {
    try {
      await sinking;
    } catch (error) {
      settled({ cause: error });
      return;
    }
    settled(undefined);
  };
  void done();
};
