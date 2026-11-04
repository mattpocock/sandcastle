import { Either, Schema } from "effect";
import { shellEscape } from "../AgentProvider.js";
import type { Sandbox } from "./Sandbox.js";

// Checking out a pull request in a bundled task's clone. `gh pr view` names
// its base and head branches and the tickets it closes; the head commit comes
// from GitHub's `refs/pull/<n>/head`, which also covers pull requests from
// forks. The GitHub token reaches these commands' env only.

const PullRequestView = Schema.parseJson(
  Schema.Struct({
    baseRefName: Schema.String,
    headRefName: Schema.String,
    closingIssuesReferences: Schema.Array(
      Schema.Struct({ number: Schema.Number, url: Schema.String }),
    ),
  }),
);

/** A ticket a pull request closes. */
export interface LinkedTicket {
  readonly number: number;
  readonly url: string;
}

/** A checked-out pull request. */
export interface CheckedOutPullRequest {
  /** The branch it merges into, e.g. `main`. */
  readonly base: string;
  /** Its own branch, now checked out in the clone. */
  readonly head: string;
  /** The tickets it closes, as GitHub links them. */
  readonly tickets: readonly LinkedTicket[];
}

/** Which pull request to check out, where, and the token that reads it. */
interface PullRequestCheckout {
  readonly pr: number;
  readonly clone: string;
  readonly githubToken: string;
}

/** Runs `command` in the clone with the token in its env only. */
const inClone = (options: PullRequestCheckout, command: string) => ({
  command,
  workingDirectory: options.clone,
  env: { GH_TOKEN: options.githubToken },
});

const readView = async (sandbox: Sandbox, options: PullRequestCheckout) => {
  const { pr } = options;
  const viewed = await sandbox.exec(
    inClone(
      options,
      `gh pr view ${pr} --json baseRefName,headRefName,closingIssuesReferences`,
    ),
  );
  const view = Schema.decodeUnknownEither(PullRequestView)(viewed.stdout);
  if (Either.isLeft(view)) {
    throw new Error(
      `gh pr view ${pr} printed something other than the pull request: ${view.left.message}`,
    );
  }
  return view.right;
};

/**
 * Checks out pull request `pr` in `clone`, on a local branch named after its
 * head branch, and resolves with its base, head and linked tickets.
 */
export const checkOutPullRequest = async (
  sandbox: Sandbox,
  options: PullRequestCheckout,
): Promise<CheckedOutPullRequest> => {
  if (!Number.isSafeInteger(options.pr) || options.pr < 1) {
    throw new RangeError(`pr must be a pull request number, not ${options.pr}`);
  }
  const view = await readView(sandbox, options);
  await sandbox.exec(
    inClone(
      options,
      `git fetch --quiet origin refs/pull/${options.pr}/head && git checkout --quiet -B ${shellEscape(view.headRefName)} FETCH_HEAD`,
    ),
  );
  return {
    base: view.baseRefName,
    head: view.headRefName,
    tickets: view.closingIssuesReferences,
  };
};
