/**
 * VCS backend abstraction. The default `git()` implementation mirrors
 * sandcastle's historical behavior. PR 2 will add a `jj()` implementation;
 * the interface is designed to make jj a drop-in alternative for
 * jj-colocated repos.
 */

export interface CheckoutInfo {
  /** Filesystem path to the working tree (git worktree / jj workspace). */
  readonly path: string;
  /** Logical branch / bookmark name the agent works on. */
  readonly branch: string;
}

export interface CommitRef {
  /** Opaque commit identifier (git SHA, or jj commit-id under PR 2). */
  readonly id: string;
}

export interface RepoMount {
  readonly hostPath: string;
  readonly sandboxPath: string;
}

export interface UserIdentity {
  readonly name: string;
  readonly email: string;
}

/** Tagged union over supported backends. */
export type VersionControlTag = "git" | "jj";

/**
 * VCS backend used by sandcastle. The default `git()` implementation mirrors
 * sandcastle's historical behavior. PR 2 adds a `jj()` implementation.
 */
export interface VersionControlProvider {
  readonly tag: VersionControlTag;

  // ----- Checkout (worktree/workspace) lifecycle -----
  createCheckout(opts: {
    repoDir: string;
    branch?: string;
    baseBranch?: string;
  }): Promise<CheckoutInfo>;
  removeCheckout(checkoutPath: string): Promise<void>;
  pruneStaleCheckouts(repoDir: string): Promise<void>;
  hasUncommittedChanges(checkoutPath: string): Promise<boolean>;

  // ----- Repo introspection -----
  currentBranch(repoDir: string): Promise<string>;
  headRef(repoDir: string): Promise<string>;
  commitsBetween(
    repoDir: string,
    base: string,
    head: string,
  ): Promise<CommitRef[]>;

  // ----- Identity -----
  readUserIdentity(repoDir: string): Promise<UserIdentity>;
  /** Returns shell commands to be `exec`'d inside the sandbox to set identity. */
  writeUserIdentityCommands(identity: UserIdentity): string[];

  // ----- Transport (host <-> isolated sandbox) -----
  bundleAllRefs(repoDir: string, outBundlePath: string): Promise<void>;
  /** Returns shell commands to clone from a bundle inside the sandbox. */
  cloneFromBundleCommands(args: {
    bundlePath: string;
    targetPath: string;
    branch: string;
  }): string[];

  // ----- Sync-out command builders (run inside the sandbox or against
  // a checkout) -----
  exportPatchesCommand(args: { base: string; outDir: string }): string;
  importPatchesCommand(args: { patchDir: string }): string;
  diffWorkingTreeCommand(): string;
  applyPatchCommand(args: { patchPath: string }): string;
  listUntrackedCommand(): string;

  // ----- Merge-back (host) -----
  detachCheckout(checkoutPath: string): Promise<void>;
  mergeBranchInto(args: {
    repoDir: string;
    sourceBranch: string;
    targetBranch: string;
  }): Promise<void>;
  deleteBranch(repoDir: string, branch: string): Promise<void>;

  // ----- Mounts (bind-mount sandboxes) -----
  resolveRepoMounts(args: {
    checkoutPath: string;
    gitPath: string;
  }): Promise<RepoMount[]>;

  // ----- Recovery instructions (user-facing string) -----
  recoveryInstructions(args: {
    patchDir: string;
    targetBranch: string;
  }): string;
}
