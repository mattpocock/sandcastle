import { posix } from "node:path";
import { shellEscape } from "../AgentProvider.js";
import type { Sandbox } from "./Sandbox.js";
import { resolveInSandbox } from "./sandboxPath.js";

// Cloning a bundled task's repo. The GitHub token reaches the clone command's
// env only; git reads it through a credential helper that names `$GH_TOKEN`,
// so it never lands in argv, the clone's config or a log. The same helper is
// set in the clone's config, so a session with `GH_TOKEN` can push.

const GITHUB_REPO = /^[\w.-]+\/[\w.-]+$/u;

const CREDENTIAL_HELPER = String.raw`!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f`;

/** `owner/name` is a GitHub repo; anything else is a URL or path git can clone. */
const cloneUrl = (repo: string): string =>
  GITHUB_REPO.test(repo) ? `https://github.com/${repo}.git` : repo;

/** The clone's directory: the repo's name, as `git clone` would pick it. */
const cloneDirectory = (url: string): string => {
  const name = posix.basename(url.replace(/\/+$/u, "")).replace(/\.git$/u, "");
  return name === "" || name === "." || name === ".." ? "repo" : name;
};

/** Clones `repo` into the working directory; resolves with the clone's absolute directory. */
export const cloneRepo = async (
  sandbox: Sandbox,
  repo: string,
  githubToken: string | undefined,
): Promise<string> => {
  const url = cloneUrl(repo);
  const directory = resolveInSandbox(
    sandbox.workingDirectory,
    cloneDirectory(url),
  );
  const helper = shellEscape(CREDENTIAL_HELPER);
  const credentials =
    githubToken === undefined
      ? ""
      : `-c credential.helper= -c credential.helper=${helper} `;
  await sandbox.exec({
    command: `git ${credentials}clone --quiet -- ${shellEscape(url)} ${shellEscape(directory)}`,
    ...(githubToken === undefined ? {} : { env: { GH_TOKEN: githubToken } }),
  });
  if (githubToken !== undefined) {
    await sandbox.exec({
      command: `git config credential.helper '' && git config --add credential.helper ${helper}`,
      workingDirectory: directory,
    });
  }
  return directory;
};
