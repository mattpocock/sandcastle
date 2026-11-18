import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { DateTime } from "effect";
import { KEEPER_READY } from "./localKeeperProtocol.js";
import type { KeeperContext } from "./localKeeperServer.js";
import { killChildren, onKeeperConnection } from "./localKeeperServer.js";
import type { LocalSandboxFolder } from "./localSandboxState.js";
import {
  keeperSocket,
  readSandboxFolder,
  removeSandboxFolder,
} from "./localSandboxState.js";

// The keeper: one detached host process per local sandbox, started at
// create in its own session, so it's no child of the caller and outlives
// it. It owns the sandbox: every command in it is its child. At the kill
// time, or on a `close` request, it kills them all, removes the sandbox's
// folder and exits. Built into its own file, dist/keeper.js
// (tsup.supervisor.config.ts), and run as `node keeper.js <folder>`.
//
// If the keeper itself is killed (SIGKILL, a reboot), each command's
// lifeline closes, so a provider that watches it ends the sandbox's
// processes, but the folder stays.

/** The longest a timer may wait in one go (Node's limit is 2^31 - 1 ms). */
const MAX_WAIT_MS = 2_000_000_000;

/** How long the keeper waits after its work for its last replies to go out. */
const LINGER_MS = 2000;

/** Resolves at `time`, however far off it is, or when `signal` aborts. */
const until = async (time: Date, signal: AbortSignal): Promise<void> => {
  const left = time.getTime() - DateTime.unsafeNow().epochMillis;
  if (left <= 0 || signal.aborted) {
    return;
  }
  await sleep(Math.min(left, MAX_WAIT_MS), undefined, { signal }).catch(
    () => undefined,
  );
  return until(time, signal);
};

/** Kills everything, removes the folder and stops listening, once. */
const shutdownOf = (
  folder: LocalSandboxFolder,
  children: Set<ChildProcess>,
  stopListening: () => void,
): (() => Promise<void>) => {
  let done: Promise<void> | undefined;
  return async () => {
    done ??= (async () => {
      stopListening();
      await killChildren(children);
      await removeSandboxFolder(folder.path);
    })();
    return done;
  };
};

/** Runs the keeper of the sandbox in `path` until it's closed or its kill time passes. */
export const runKeeper = async (path: string): Promise<void> => {
  const folder = await readSandboxFolder(path);
  if (folder === undefined) {
    throw new Error(`keeper: no sandbox folder at ${path}`);
  }
  const children = new Set<ChildProcess>();
  const server = createServer();
  const shutdown = shutdownOf(folder, children, () => {
    server.close();
  });
  const context: KeeperContext = { children, shutdown };
  server.on("connection", onKeeperConnection(context));
  server.listen(keeperSocket(folder));
  await once(server, "listening");
  process.stdout.write(`${KEEPER_READY}\n`);
  const stopWaiting = new AbortController();
  const closed = once(server, "close");
  server.once("close", () => {
    stopWaiting.abort();
  });
  await until(folder.killTime, stopWaiting.signal);
  await shutdown();
  stopWaiting.abort();
  // The last replies (each killed command's exit) go out as their
  // connections end; don't wait on a stray one past LINGER_MS.
  await Promise.race([closed, sleep(LINGER_MS)]);
};

const folderPath = process.argv.at(2);
if (folderPath !== undefined) {
  await runKeeper(folderPath);
  // Its work is done: don't wait on a stray handle (a child that ignored
  // its kill).
  process.exit(0);
}
