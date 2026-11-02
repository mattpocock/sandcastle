/**
 * Interrupt teardown for the Fly.io Sprites provider (`sprites.ts`). Sprites
 * persist until deleted, so a run interrupted before `close()` would leave
 * its Sprite running.
 */

import { spawn } from "node:child_process";
import { registerShutdown } from "../shutdownRegistry.js";

/** Deletes the Sprite at `process.argv[1]`, with the token from the env. */
const DELETE_SCRIPT =
  "fetch(process.argv[1], { method: 'DELETE', headers: { Authorization: 'Bearer ' + process.env.SANDCASTLE_SPRITES_TOKEN } }).catch(() => {});";

/**
 * Register a teardown that deletes the Sprite `name` if the process is
 * interrupted (`SIGINT`/`SIGTERM`) or exits before it is unregistered.
 * Shutdown teardowns are synchronous and the process exits as soon as they
 * return, so the delete can't be awaited: it runs in a detached child process,
 * which outlives this one and finishes it.
 *
 * @returns An idempotent function that unregisters the teardown.
 */
export const registerSpriteDeletion = (
  baseURL: string,
  token: string,
  name: string,
): (() => void) =>
  registerShutdown(() => {
    const url = `${baseURL}/v1/sprites/${encodeURIComponent(name)}`;
    spawn(process.execPath, ["-e", DELETE_SCRIPT, url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, SANDCASTLE_SPRITES_TOKEN: token },
    }).unref();
  });
