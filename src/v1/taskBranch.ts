import { shellEscape } from "../AgentProvider.js";
import type { OutputDefinition } from "./Output.js";
import type { Sandbox } from "./Sandbox.js";
import type { TaskRun } from "./Task.js";
import { cloneRepo } from "./taskRepo.js";

// The branch a bundled task works on, in its clone. A new branch starts from
// the commit `git clone` checked out, the repo's default branch; an existing
// one is checked out from the remote. Commits need an identity, which a fresh
// sandbox lacks: the clone gets a local one unless git already has one.

/** The branch a task's session works on. Internal. */
export interface TaskBranch {
  readonly name: string;
  /** Create it from the default branch, or check out the remote's. */
  readonly create: boolean;
}

const IDENTITY = [
  "{ git config user.name >/dev/null || git config user.name Sandcastle; }",
  "{ git config user.email >/dev/null || git config user.email sandcastle@noreply.invalid; }",
].join(" && ");

/** Checks `branch` out in the clone at `directory`. */
const checkoutBranch = async (
  sandbox: Sandbox,
  directory: string,
  branch: TaskBranch,
): Promise<void> => {
  if (branch.name.startsWith("-")) {
    throw new TypeError(`branch: "${branch.name}" isn't a branch name`);
  }
  const create = branch.create ? "--create " : "";
  await sandbox.exec({
    command: `git switch --quiet ${create}${shellEscape(branch.name)} && ${IDENTITY}`,
    workingDirectory: directory,
  });
};

/** Clones the task's repo and checks out its branch; resolves with the clone's directory. */
export const prepareRepo = async <O extends OutputDefinition | undefined>(
  sandbox: Sandbox,
  run: TaskRun<O>,
): Promise<string | undefined> => {
  if (run.repo === undefined) {
    return undefined;
  }
  const directory = await cloneRepo(sandbox, run.repo, run.githubToken);
  if (run.branch !== undefined) {
    await checkoutBranch(sandbox, directory, run.branch);
  }
  return directory;
};
