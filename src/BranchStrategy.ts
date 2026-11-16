/**
 * Branch strategy types — where a run's commits land.
 */

/** Head strategy: agent writes directly to host working directory. Bind-mount only. */
export interface HeadBranchStrategy {
  readonly type: "head";
}

/** Merge-to-head strategy: temp branch, merge back to HEAD, delete temp branch. */
export interface MergeToHeadBranchStrategy {
  readonly type: "merge-to-head";
}

/** Branch strategy: commits land on an explicit named branch. */
export interface NamedBranchStrategy {
  readonly type: "branch";
  readonly branch: string;
  /**
   * Git ref to use as the starting point when creating a new branch.
   * Only used when the branch doesn't already exist — ignored otherwise.
   * Callers are responsible for ensuring the ref is current (e.g. `git fetch`).
   * Defaults to `HEAD` when omitted.
   */
  readonly baseBranch?: string;
}

/** Branch strategy for bind-mount providers (all three variants). */
export type BindMountBranchStrategy =
  | HeadBranchStrategy
  | MergeToHeadBranchStrategy
  | NamedBranchStrategy;

/** Branch strategy for isolated providers (no head — can't write to host). */
export type IsolatedBranchStrategy =
  | MergeToHeadBranchStrategy
  | NamedBranchStrategy;

/** Branch strategy for no-sandbox providers (all three — same as bind-mount). */
export type NoSandboxBranchStrategy =
  | HeadBranchStrategy
  | MergeToHeadBranchStrategy
  | NamedBranchStrategy;

/** Union of all branch strategy variants. */
export type BranchStrategy =
  | BindMountBranchStrategy
  | IsolatedBranchStrategy
  | NoSandboxBranchStrategy;
