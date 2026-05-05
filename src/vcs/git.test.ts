import { describe, it, expect } from "vitest";
import { git } from "./git.js";

describe("git() factory", () => {
  it("returns a provider tagged 'git'", () => {
    const provider = git();
    expect(provider.tag).toBe("git");
  });

  it("exposes all VersionControlProvider methods", () => {
    const provider = git();
    const expectedMethods = [
      "createCheckout",
      "removeCheckout",
      "pruneStaleCheckouts",
      "hasUncommittedChanges",
      "currentBranch",
      "headRef",
      "commitsBetween",
      "readUserIdentity",
      "writeUserIdentityCommands",
      "bundleAllRefs",
      "cloneFromBundleCommands",
      "exportPatchesCommand",
      "importPatchesCommand",
      "diffWorkingTreeCommand",
      "applyPatchCommand",
      "listUntrackedCommand",
      "detachCheckout",
      "mergeBranchInto",
      "deleteBranch",
      "resolveRepoMounts",
      "recoveryInstructions",
    ] as const;

    for (const method of expectedMethods) {
      expect(
        typeof (provider as unknown as Record<string, unknown>)[method],
      ).toBe("function");
    }
  });
});
