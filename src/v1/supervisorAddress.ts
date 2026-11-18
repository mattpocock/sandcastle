import { createHash } from "node:crypto";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import type { Server } from "node:net";
import path from "node:path";

// Where the session supervisor listens, worked out the same way by the
// daemon and by its client, both run in the supervisor's directory. On Linux
// and macOS it's a Unix socket there, bound by a relative path so a deep home
// can't push it past the socket path limit. Windows has no socket files: it's
// a named pipe, whose namespace is flat and global, so its name comes from a
// hash of the directory, and two sandboxes never share one. A pipe ends with
// the process that made it, and Node never binds a name that's still held,
// so a new supervisor can't share a stale one (ADR 0027).

/** The supervisor's Unix socket, relative to its directory. */
export const SOCKET = "control.sock";

const PIPE_PREFIX = String.raw`\\.\pipe\sandcastle-`;

/** The named pipe for the supervisor in `directory` (Windows, where names are case-insensitive). */
export const pipeFor = (directory: string): string =>
  `${PIPE_PREFIX}${createHash("sha256")
    .update(path.win32.resolve(directory).toLowerCase())
    .digest("hex")
    .slice(0, 32)}`;

/** What the supervisor in the current directory listens on, on this platform. */
export const controlAddress = (): string =>
  process.platform === "win32" ? pipeFor(process.cwd()) : SOCKET;

/**
 * Listens on the supervisor's address until `server` closes. A crashed
 * supervisor's socket file is removed first, never connected to again; on
 * Windows its pipe went with it. Rejects when the address is taken.
 */
export const serveHere = async (server: Server): Promise<void> => {
  if (process.platform !== "win32") {
    await rm(SOCKET, { force: true });
  }
  const closed = once(server, "close");
  server.listen(controlAddress());
  await closed;
};
