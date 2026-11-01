import { SyncOutPathError as SyncOutPathErrorImpl } from "./errors.js";

/**
 * Sync-out refused to write a file on the host because its path, as reported
 * by an isolated sandbox, would land outside the host worktree (or in its
 * `.git`): an absolute path, a `..` segment, or a symlink leading out.
 *
 * Public-facing type for `SyncOutPathError`. The runtime class is the same
 * `Data.TaggedError` from `errors.ts`, re-declared here as a plain `Error`
 * subclass so that Effect's types stay out of Sandcastle's published `.d.ts`
 * files.
 */
export interface SyncOutPathError extends Error {
  readonly _tag: "SyncOutPathError";
  readonly message: string;
  /** The offending path, as the sandbox reported it. */
  readonly path: string;
}

interface SyncOutPathErrorConstructor {
  new (args: {
    readonly message: string;
    readonly path: string;
  }): SyncOutPathError;
  readonly prototype: SyncOutPathError;
}

/** Sync-out refused a host path that would land outside the worktree. */
export const SyncOutPathError: SyncOutPathErrorConstructor =
  SyncOutPathErrorImpl;
