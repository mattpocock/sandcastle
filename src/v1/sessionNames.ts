import type { Sandbox } from "./Sandbox.js";

// The session names a handle has taken, for a bundled task's `start` to check
// before it clones: each start clones into a directory named after its
// session, so a name already running would share a working tree. A name is
// taken by a session the handle's host follows, or by a task start between
// its check and its spawn. Keyed by the handle object, as the detach
// deadline is: a task gets the handle `createSandbox` returned.

interface Names {
  /** Whether the handle's host is following a session of this name. */
  readonly running: (name: string) => boolean;
  /** Names claimed by task starts that haven't spawned yet. */
  readonly starting: Set<string>;
}

const handles = new WeakMap<object, Names>();

/** Records how a new handle tells whether a session name is running. */
export const trackSessionNames = (
  handle: object,
  running: (name: string) => boolean,
): void => {
  handles.set(handle, { running, starting: new Set() });
};

const namesOf = (sandbox: Sandbox): Names => {
  const found = handles.get(sandbox);
  if (found !== undefined) {
    return found;
  }
  // A handle Sandcastle didn't make: only task starts are known.
  const made: Names = { running: () => false, starting: new Set() };
  handles.set(sandbox, made);
  return made;
};

/**
 * Takes `name` for a task start, or throws when a session of that name is
 * running or starting on the handle. Call the returned release once the
 * session has spawned (the host holds the name from then) or the start failed.
 */
export const claimSessionName = (
  sandbox: Sandbox,
  task: string,
  name: string,
): (() => void) => {
  const names = namesOf(sandbox);
  if (names.running(name) || names.starting.has(name)) {
    throw new TypeError(
      `${task}: a session named "${name}" is already running`,
    );
  }
  names.starting.add(name);
  return () => {
    names.starting.delete(name);
  };
};
