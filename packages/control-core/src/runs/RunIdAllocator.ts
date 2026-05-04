import { customAlphabet } from "nanoid";

const alphabet =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const makeId = customAlphabet(alphabet, 12);

export const allocateRunId = (): string => {
  // TODO(Phase 2): thread this runId into WorktreeManager.generateTempBranchName
  // via RepoRunCoordinator so branch/worktree names are collision-proof.
  return makeId();
};
