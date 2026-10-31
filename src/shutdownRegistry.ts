/**
 * Process-wide shutdown registry.
 *
 * Sandboxes need to run synchronous cleanup (remove a container, print
 * worktree-recovery guidance) when the host process is interrupted. Registering
 * `SIGINT`/`SIGTERM`/`exit` listeners per sandbox makes Node emit a
 * `MaxListenersExceededWarning` once more than ~10 sandboxes exist concurrently.
 *
 * This module installs exactly one listener per signal — no matter how many
 * sandboxes are alive — and fans out to a set of teardown callbacks. On
 * `SIGINT`/`SIGTERM` it runs every teardown and then exits once with code 1;
 * on a plain `exit` it runs every teardown without forcing the exit code.
 */

/**
 * A synchronous cleanup step run during shutdown. It must not call
 * `process.exit` — the registry owns the single exit — and must not rely on
 * async work completing, because a signal handler cannot await before the
 * process exits.
 */
export type ShutdownCallback = () => void;

const teardownCallbacks = new Set<ShutdownCallback>();
let listenersInstalled = false;

const runTeardowns = (): void => {
  for (const teardown of teardownCallbacks) {
    try {
      teardown();
    } catch {
      // Best-effort: one teardown failing must not block the others.
    }
  }
};

const handleExit = (): void => {
  runTeardowns();
};

const handleSignal = (): void => {
  // Detach first so the synchronous "exit" event triggered by process.exit()
  // below does not run the same teardowns a second time.
  detachListeners();
  runTeardowns();
  process.exit(1);
};

const attachListeners = (): void => {
  if (listenersInstalled) {
    return;
  }
  listenersInstalled = true;
  process.on("exit", handleExit);
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
};

const detachListeners = (): void => {
  if (!listenersInstalled) {
    return;
  }
  listenersInstalled = false;
  process.removeListener("exit", handleExit);
  process.removeListener("SIGINT", handleSignal);
  process.removeListener("SIGTERM", handleSignal);
};

/**
 * Register a teardown to run when the process receives `SIGINT`/`SIGTERM` or
 * exits. The first registration installs the shared listeners; the last
 * unregistration removes them, restoring the default signal behavior.
 *
 * @param teardown Synchronous cleanup to run on shutdown.
 * @returns An idempotent function that unregisters the teardown.
 */
export const registerShutdown = (teardown: ShutdownCallback): (() => void) => {
  teardownCallbacks.add(teardown);
  attachListeners();

  let active = true;
  return () => {
    if (!active) {
      return;
    }
    active = false;
    teardownCallbacks.delete(teardown);
    if (teardownCallbacks.size === 0) {
      detachListeners();
    }
  };
};
