import { once } from "node:events";
import { createWriteStream } from "node:fs";

// The supervisor writes its own log, in its directory: its start command is
// a plain `node supervisor.mjs daemon`, with no shell to redirect its output
// (Windows has none). Everything it prints goes there, and so does the error
// that would otherwise crash it unseen.

/** The supervisor's log, in its directory. */
export const SUPERVISOR_LOG = "supervisor.log";

/** Whether `arg` is the callback a stream's `write` may be handed last. */
const isCallback = (arg: unknown): arg is (error?: Error | null) => void =>
  typeof arg === "function";

/**
 * Sends this process's stdout, stderr and any uncaught error to `file`,
 * appended. Returns a function that flushes and closes the log.
 */
export const logToFile = (file: string): (() => Promise<void>) => {
  const log = createWriteStream(file, { flags: "a" });
  // A log that can't be written is no reason to stop.
  log.on("error", () => undefined);
  const write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const callback = rest.find((arg) => isCallback(arg));
    return isCallback(callback) ? log.write(chunk, callback) : log.write(chunk);
  };
  process.stdout.write = write;
  process.stderr.write = write;
  process.on("uncaughtException", (error) => {
    log.end(`${error.stack ?? String(error)}\n`, () => {
      process.exit(70);
    });
  });
  return async () => {
    log.end();
    await once(log, "close").catch(() => undefined);
  };
};
