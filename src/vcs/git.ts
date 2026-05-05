import type {
  VersionControlProvider,
  CheckoutInfo,
  CommitRef,
  RepoMount,
  UserIdentity,
} from "../VersionControl.js";

const ni = (name: string): never => {
  throw new Error(`git().${name}: not yet wired (PR 1 stub)`);
};

export const git = (): VersionControlProvider => ({
  tag: "git",
  createCheckout: async (_opts) =>
    ni("createCheckout") as never as CheckoutInfo,
  removeCheckout: async (_p) => ni("removeCheckout"),
  pruneStaleCheckouts: async (_d) => ni("pruneStaleCheckouts"),
  hasUncommittedChanges: async (_p) =>
    ni("hasUncommittedChanges") as never as boolean,
  currentBranch: async (_d) => ni("currentBranch") as never as string,
  headRef: async (_d) => ni("headRef") as never as string,
  commitsBetween: async (_d, _b, _h) =>
    ni("commitsBetween") as never as CommitRef[],
  readUserIdentity: async (_d) =>
    ni("readUserIdentity") as never as UserIdentity,
  writeUserIdentityCommands: (_id) => {
    ni("writeUserIdentityCommands");
    return [];
  },
  bundleAllRefs: async (_d, _o) => ni("bundleAllRefs"),
  cloneFromBundleCommands: (_a) => {
    ni("cloneFromBundleCommands");
    return [];
  },
  exportPatchesCommand: (_a) => {
    ni("exportPatchesCommand");
    return "";
  },
  importPatchesCommand: (_a) => {
    ni("importPatchesCommand");
    return "";
  },
  diffWorkingTreeCommand: () => {
    ni("diffWorkingTreeCommand");
    return "";
  },
  applyPatchCommand: (_a) => {
    ni("applyPatchCommand");
    return "";
  },
  listUntrackedCommand: () => {
    ni("listUntrackedCommand");
    return "";
  },
  detachCheckout: async (_p) => ni("detachCheckout"),
  mergeBranchInto: async (_a) => ni("mergeBranchInto"),
  deleteBranch: async (_d, _b) => ni("deleteBranch"),
  resolveRepoMounts: async (_a) =>
    ni("resolveRepoMounts") as never as RepoMount[],
  recoveryInstructions: (_a) => {
    ni("recoveryInstructions");
    return "";
  },
});
