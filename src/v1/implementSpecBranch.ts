import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { Sandbox } from "../v1.js";

// `implementSpec`'s integration branch: created from the default branch in a
// clone of its own and pushed, before any ticket branches from it. Written
// with `exec` only, as any caller of the public API could. The GitHub token
// reaches these commands' env only; git reads it through a credential helper
// that names `$GH_TOKEN`, so it never lands in argv or a log.

const GITHUB_REPO = /^[\w.-]+\/[\w.-]+$/u;

const HELPER = String.raw`!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f`;

/** One shell word. */
export const quoted = (value: string): string =>
  `'${value.replaceAll("'", String.raw`'\''`)}'`;

/** git's flags that read the token from `$GH_TOKEN`, and from nowhere else. */
export const credentials = `-c credential.helper= -c credential.helper=${quoted(HELPER)}`;

/** `owner/name` is a GitHub repo; anything else is a URL or path git can clone. */
const cloneUrl = (repo: string): string =>
  GITHUB_REPO.test(repo) ? `https://github.com/${repo}.git` : repo;

/** A spec reference as part of a branch name: `#671` is `671`. */
const slug = (spec: string): string =>
  spec
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");

/** The integration branch's name: `sandcastle/implement-spec-<spec>-<random>`. */
export const integrationBranchName = (spec: string): string => {
  const id = randomUUID().slice(0, 8);
  const name = slug(spec);
  return name === ""
    ? `sandcastle/implement-spec-${id}`
    : `sandcastle/implement-spec-${name}-${id}`;
};

/** The integration branch's own clone: `sandcastle-implement-spec-<spec>-<random>`. */
export const integrationClone = (sandbox: Sandbox, branch: string): string =>
  posix.join(sandbox.workingDirectory, branch.replaceAll("/", "-"));

/**
 * Rejects when the sandbox has no `gh` on its PATH: the PR step, the chooser
 * and the bundled tasks all use the GitHub CLI, and not every image has it
 * (Daytona's default doesn't).
 */
export const requireGh = async (sandbox: Sandbox): Promise<void> => {
  const probe = await sandbox.exec({
    command: "command -v gh",
    allowFailure: true,
  });
  if (probe.exitCode !== 0) {
    throw new Error(
      "implementSpec: the sandbox has no `gh` on its PATH: its tasks open, read and review pull requests with the GitHub CLI. Install the GitHub CLI in the sandbox's image or snapshot.",
    );
  }
};

/**
 * Clones `repo` into a directory of its own, then creates `branch` from the
 * default branch it checked out and pushes it to `origin`.
 */
export const pushIntegrationBranch = async (
  sandbox: Sandbox,
  options: {
    readonly repo: string;
    readonly branch: string;
    readonly githubToken: string;
  },
): Promise<void> => {
  const directory = integrationClone(sandbox, options.branch);
  const env = { GH_TOKEN: options.githubToken };
  await sandbox.exec({
    command: `git ${credentials} clone --quiet -- ${quoted(cloneUrl(options.repo))} ${quoted(directory)}`,
    env,
  });
  await sandbox.exec({
    command: `git switch --quiet --create ${quoted(options.branch)} && git ${credentials} push --quiet origin ${quoted(`refs/heads/${options.branch}`)}`,
    workingDirectory: directory,
    env,
  });
};

/**
 * Whether `branch` is on `repo`'s remote, read with `git ls-remote`. Rejects
 * when the remote can't be read at all, which isn't the branch's doing.
 */
export const remoteHasBranch = async (
  sandbox: Sandbox,
  options: {
    readonly repo: string;
    readonly branch: string;
    readonly githubToken: string;
  },
): Promise<boolean> => {
  const listed = await sandbox.exec({
    command: `git ${credentials} ls-remote --exit-code --heads -- ${quoted(cloneUrl(options.repo))} ${quoted(`refs/heads/${options.branch}`)}`,
    env: { GH_TOKEN: options.githubToken },
    allowFailure: true,
  });
  // `--exit-code`: 2 is "no such ref"; anything else non-zero is git failing.
  if (listed.exitCode === 0 || listed.exitCode === 2) {
    return listed.exitCode === 0;
  }
  throw new Error(
    `implementSpec: couldn't read ${options.repo}'s branches: ${listed.stderr.trim()}`,
  );
};
