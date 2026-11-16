import { shellEscape } from "../AgentProvider.js";
import type { Sandbox } from "./Sandbox.js";
import { checkOutPullRequest } from "./taskPullRequest.js";
import { CREDENTIAL_HELPER, cloneUrl } from "./taskRepo.js";

// What the `merge` task does before its session: it refuses the default
// branch without cloning, finds `from` in the clone, and tries the merge
// itself. A clean merge is left committed for the agent to check and push; a
// conflicted one is aborted, so the setup commands run on a clean tree, and
// the agent redoes it and resolves the conflicts. The GitHub token reaches
// these commands' env only.

/** The branch, or the pull request's number, to merge. */
export type MergeSource = string | number;

/** How the merge Sandcastle tried went. */
export type MergeAttempt =
  | { readonly kind: "merged"; readonly commit: string }
  | { readonly kind: "conflicted"; readonly files: readonly string[] }
  | { readonly kind: "up-to-date" };

/** A merge ready for the session: what to merge, its message and how the try went. */
export interface PreparedMerge {
  /** How the prompt names `from`. */
  readonly source: string;
  /** The ref `git merge` takes for `from`. */
  readonly ref: string;
  /** The merge commit's message. */
  readonly message: string;
  readonly attempt: MergeAttempt;
}

const notABranch = (name: string, value: string): void => {
  if (value === "" || value.startsWith("-")) {
    throw new TypeError(`merge: ${name} "${value}" isn't a branch name`);
  }
};

/** Checks `from` and `into` before anything runs. */
export const checkMergeBranches = (from: MergeSource, into: string): void => {
  notABranch("into", into);
  if (typeof from === "string") {
    notABranch("from", from);
    if (from === into) {
      throw new TypeError(`merge: from and into are both "${into}"`);
    }
  } else if (!Number.isSafeInteger(from) || from < 1) {
    throw new RangeError(
      `merge: from must be a branch name or a pull request number, not ${from}`,
    );
  }
};

const SYMREF = /^ref: refs\/heads\/(?<branch>\S+)\tHEAD$/mu;

/** Rejects `into` when it's the remote's default branch, read with `git ls-remote`. */
export const refuseDefaultBranch = async (
  sandbox: Sandbox,
  options: {
    readonly repo: string;
    readonly into: string;
    readonly githubToken: string;
  },
): Promise<void> => {
  const helper = shellEscape(CREDENTIAL_HELPER);
  const listed = await sandbox.exec({
    command: `git -c credential.helper= -c credential.helper=${helper} ls-remote --symref -- ${shellEscape(cloneUrl(options.repo))} HEAD`,
    env: { GH_TOKEN: options.githubToken },
  });
  const branch = SYMREF.exec(listed.stdout)?.groups?.["branch"];
  if (branch === undefined) {
    throw new Error(
      `merge: couldn't read ${options.repo}'s default branch, so it won't merge into "${options.into}"`,
    );
  }
  if (branch === options.into) {
    throw new RangeError(
      `merge: "${options.into}" is the repo's default branch, which merge never merges into`,
    );
  }
};

/** Where to prepare the merge, and the token that reads a pull request. */
interface MergeClone {
  readonly clone: string;
  readonly from: MergeSource;
  readonly into: string;
  readonly githubToken: string;
}

const run = async (sandbox: Sandbox, clone: string, command: string) =>
  sandbox.exec({ command, workingDirectory: clone, allowFailure: true });

/** `from` as `git merge` takes it, with the merge's message. */
const resolveSource = async (
  sandbox: Sandbox,
  options: MergeClone,
): Promise<Omit<PreparedMerge, "attempt">> => {
  const { from, into } = options;
  if (typeof from === "number") {
    const pr = await checkOutPullRequest(sandbox, { ...options, pr: from });
    await sandbox.exec({
      command: `git switch --quiet ${shellEscape(into)}`,
      workingDirectory: options.clone,
    });
    return {
      source: `pull request #${from} (its branch \`${pr.head}\`)`,
      ref: pr.head,
      message: `Merge pull request #${from} from ${pr.head}`,
    };
  }
  const ref = `origin/${from}`;
  const found = await run(
    sandbox,
    options.clone,
    `git rev-parse --verify --quiet ${shellEscape(`refs/remotes/${ref}^{commit}`)}`,
  );
  if (found.exitCode !== 0) {
    throw new Error(`merge: the remote has no branch "${from}"`);
  }
  return {
    source: `\`${from}\``,
    ref,
    message: `Merge branch '${from}' into ${into}`,
  };
};

const head = async (sandbox: Sandbox, clone: string): Promise<string> => {
  const parsed = await sandbox.exec({
    command: "git rev-parse HEAD",
    workingDirectory: clone,
  });
  return parsed.stdout.trim();
};

/** Tries the merge; aborts it on conflicts, rejects on any other failure. */
const attemptMerge = async (
  sandbox: Sandbox,
  clone: string,
  merge: Omit<PreparedMerge, "attempt">,
): Promise<MergeAttempt> => {
  const before = await head(sandbox, clone);
  const merged = await run(
    sandbox,
    clone,
    `git merge --quiet --no-ff -m ${shellEscape(merge.message)} ${shellEscape(merge.ref)}`,
  );
  if (merged.exitCode === 0) {
    const after = await head(sandbox, clone);
    return after === before
      ? { kind: "up-to-date" }
      : { kind: "merged", commit: after };
  }
  const unmerged = await run(
    sandbox,
    clone,
    "git diff --name-only --diff-filter=U",
  );
  const files = unmerged.stdout.split("\n").filter((file) => file !== "");
  await run(sandbox, clone, "git merge --abort");
  if (files.length === 0) {
    throw new Error(
      `merge: git merge ${merge.ref} failed: ${merged.stderr.trim()}`,
    );
  }
  return { kind: "conflicted", files };
};

/** Finds `from` in the clone, which is on `into`, and tries the merge. */
export const prepareMerge = async (
  sandbox: Sandbox,
  options: MergeClone,
): Promise<PreparedMerge> => {
  const merge = await resolveSource(sandbox, options);
  return {
    ...merge,
    attempt: await attemptMerge(sandbox, options.clone, merge),
  };
};
