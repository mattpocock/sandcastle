import { spawn } from "node:child_process";
import { registerShutdown } from "../../shutdownRegistry.js";

// Deleting a sprite whose create was cut short by the host exiting. Sprites
// persist until deleted, and until `create` hands out a handle nothing else
// can reach one. Only for that window: once the handle exists, a host that
// exits must leave the sprite be, since a detached run may be working in it.

/** Deletes the sprite at `process.argv[1]`, with the token from the env. */
const DELETE_SCRIPT =
  "fetch(process.argv[1], { method: 'DELETE', headers: { Authorization: 'Bearer ' + process.env.SANDCASTLE_SPRITES_TOKEN } }).catch(() => {});";

/**
 * Registers a teardown that deletes the sprite `name` if the host is
 * interrupted (`SIGINT`/`SIGTERM`) or exits before it is unregistered.
 * Shutdown teardowns are synchronous, so the delete runs in a detached child
 * process, which outlives this one. Returns an idempotent unregister.
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
