/**
 * A native sandbox's shutdown teardown (src/shutdownRegistry.ts). On
 * SIGINT/SIGTERM nothing calls `close()`, and the registry exits as soon as
 * its teardowns return, so the private dirs are removed synchronously: async
 * removal would never finish.
 */

/* oxlint-disable node/no-sync -- a shutdown teardown is synchronous (allowlisted in scripts/lint-ratchet-config.ts). */

import { rmSync } from "node:fs";
import { registerShutdown } from "./shutdownRegistry.js";

/**
 * Registers the teardown that runs if the process is interrupted or exits
 * before the sandbox is closed: `killAll`, then removing the private dirs
 * under `dirs.root`, best-effort.
 *
 * @returns An idempotent function that unregisters the teardown.
 */
export const registerNativeSandboxShutdown = (
  killAll: () => void,
  dirs: { readonly root: string },
): (() => void) =>
  registerShutdown(() => {
    killAll();
    try {
      rmSync(dirs.root, { recursive: true, force: true });
    } catch {
      // Best-effort: the process is exiting either way.
    }
  });
