import { shellEscape } from "../AgentProvider.js";
import type { OutputDefinition } from "./Output.js";
import type { Sandbox } from "./Sandbox.js";
import type { TaskRun } from "./Task.js";
import { cloneRepo } from "./taskRepo.js";

// The branch a bundled task works on, in its clone. A new branch starts from
// the commit `git clone` checked out, the repo's default branch, or from a
// base branch fetched from `origin`; an existing one is checked out from the
// remote. Commits need an identity, which a fresh
// sandbox lacks: the clone gets a local one unless git already has one.

/** The branch a task's session works on. Internal. */
export interface TaskBranch {
  readonly name: string;
  /** Create it, or check out the remote's. */
  readonly create: boolean;
  /** The remote branch a new branch starts from; `undefined` is the default branch. */
  readonly from: string | undefined;
}

const IDENTITY = [
  "{ git config user.name >/dev/null || git config user.name Sandcastle; }",
  "{ git config user.email >/dev/null || git config user.email sandcastle@noreply.invalid; }",
].join(" && ");

/** Throws when git could read `name` as an option. */
const checkName = (field: string, name: string): void => {
  if (name.startsWith("-")) {
    throw new TypeError(`${field}: "${name}" isn't a branch name`);
  }
};

/**
 * The command that checks out the remote's branch, a new one from the default
 * branch, or a new one from `from`'s tip, fetched first so a missing base
 * fails here. It starts at `FETCH_HEAD`, so it doesn't track `from`, and a
 * bare `git push` can't land on the base.
 */
const switchCommand = (branch: TaskBranch): string => {
  const name = shellEscape(branch.name);
  if (!branch.create) {
    return `git switch --quiet ${name}`;
  }
  if (branch.from === undefined) {
    return `git switch --quiet --create ${name}`;
  }
  const from = shellEscape(`refs/heads/${branch.from}`);
  return `git fetch --quiet origin ${from} && git switch --quiet --create ${name} FETCH_HEAD`;
};

/** Checks `branch` out in the clone at `directory`. */
const checkoutBranch = async (
  sandbox: Sandbox,
  directory: string,
  branch: TaskBranch,
): Promise<void> => {
  checkName("branch", branch.name);
  if (branch.from !== undefined) {
    checkName("base", branch.from);
  }
  await sandbox.exec({
    command: `${switchCommand(branch)} && ${IDENTITY}`,
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
