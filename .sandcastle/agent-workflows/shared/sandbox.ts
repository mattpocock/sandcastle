import type { AgentStreamEvent, Sandbox } from "@ai-hero/sandcastle/v1";
import { createSandbox } from "@ai-hero/sandcastle/v1";
import { host } from "@ai-hero/sandcastle/v1/sandboxes/host";
import { fail, required } from "./common";

/** Single-quotes `value` for `sh`. */
export const quote = (value: string): string =>
  `'${value.replaceAll("'", String.raw`'\''`)}'`;

// The sandbox every agent workflow runs in: a host() sandbox on the Actions
// runner, its working directory an empty folder of its own that the repo is
// cloned into. host() is not isolation: the agent runs as the runner's user.
// It's chosen here because the runner is a throwaway VM.

/** How long a workflow's sandbox may live: inside its job's own timeout. */
const TIME_LIMIT_MINUTES = 50;

/** The bot identity for commits the agent makes. */
const GIT_NAME = "sandcastle-agent[bot]";
const GIT_EMAIL = "sandcastle-agent[bot]@users.noreply.github.com";

/**
 * A host() sandbox whose commands, the agent's included, get the repo's
 * name and the Claude Code token through their env. Never the GitHub token:
 * the agent runs with its permission bypass on untrusted issue and PR text,
 * so only the git commands that reach GitHub get it (`withGitHubToken`).
 * Its home is fresh, so nothing of the runner's `gh` login or `~/.gitconfig`
 * is seen.
 */
export const openSandbox = async (): Promise<Sandbox> =>
  createSandbox({
    provider: host(),
    env: {
      GH_REPO: required("GH_REPO"),
      CLAUDE_CODE_OAUTH_TOKEN: required("CLAUDE_CODE_OAUTH_TOKEN"),
    },
    timeLimitMinutes: TIME_LIMIT_MINUTES,
  });

/**
 * A credential helper for one git command, given with `-c`, so it's never
 * stored: it answers with `$GH_TOKEN` from that command's env. The command
 * line holds the variable's name, never its value. The empty helper first
 * drops any helper git would otherwise ask.
 */
const CREDENTIAL_HELPER = `-c credential.helper= -c credential.helper=${quote(
  '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f',
)}`;

/**
 * `git <args>` run with the GitHub token from this process's `GH_TOKEN`,
 * through a one-command credential helper and that one command's env. With
 * no token (a public repo, read only) it runs without one.
 */
export const withGitHubToken = (
  gitArgs: string,
): { readonly command: string; readonly env: Record<string, string> } => {
  const token = process.env.GH_TOKEN;
  return token === undefined || token === ""
    ? { command: `git ${gitArgs}`, env: {} }
    : {
        command: `git ${CREDENTIAL_HELPER} ${gitArgs}`,
        env: { GH_TOKEN: token },
      };
};

/** Runs `command` in the sandbox and returns its stdout; rejects when it fails. */
export const run = async (
  sandbox: Sandbox,
  command: string,
): Promise<string> => {
  const result = await sandbox.exec(command);
  return result.stdout;
};

/** `run`, its stdout trimmed. */
export const runTrimmed = async (
  sandbox: Sandbox,
  command: string,
): Promise<string> => {
  const stdout = await run(sandbox, command);
  return stdout.trim();
};

/** Runs `command` in the sandbox: its stdout, or "" when it fails. */
export const tryRun = async (
  sandbox: Sandbox,
  command: string,
): Promise<string> => {
  const result = await sandbox.exec({ command, allowFailure: true });
  return result.exitCode === 0 ? result.stdout : "";
};

/**
 * Clones the repo into the sandbox's working directory over git (the token
 * only in the clone's own env, so the clone's config keeps no credential),
 * sets the bot's git identity, and checks out `branch` (or makes
 * `newBranch` from the default branch).
 */
export const cloneRepo = async (
  sandbox: Sandbox,
  target: { readonly branch: string } | { readonly newBranch: string },
): Promise<void> => {
  await sandbox.exec(
    withGitHubToken('clone "https://github.com/$GH_REPO.git" .'),
  );
  await run(sandbox, `git config user.name ${quote(GIT_NAME)}`);
  await run(sandbox, `git config user.email ${quote(GIT_EMAIL)}`);
  await run(
    sandbox,
    "branch" in target
      ? `git checkout ${quote(target.branch)}`
      : `git checkout -b ${quote(target.newBranch)}`,
  );
};

/** Installs the clone's dependencies, so the agent can typecheck and test. */
export const installDependencies = async (sandbox: Sandbox): Promise<void> => {
  await run(sandbox, "npm ci --no-audit --no-fund");
};

/** Fetches `ref` from origin, with the token for that one command. */
export const fetchRef = async (
  sandbox: Sandbox,
  ref: string,
): Promise<void> => {
  await sandbox.exec(withGitHubToken(`fetch origin ${quote(ref)}`));
};

/** The commits on HEAD since `since`. */
export const commitsSince = async (
  sandbox: Sandbox,
  since: string,
): Promise<number> => {
  const count = await runTrimmed(
    sandbox,
    `git rev-list --count ${quote(`${since}..HEAD`)}`,
  );
  return Number(count);
};

/** The sandbox's HEAD sha. */
export const headSha = async (sandbox: Sandbox): Promise<string> =>
  runTrimmed(sandbox, "git rev-parse HEAD");

/**
 * Pushes `branch` from the sandbox. With `leaseSha`, only over that sha
 * (`--force-with-lease`), failing the run with `advanced` when the branch
 * moved on meanwhile; without, by force.
 */
export const pushBranch = async (
  sandbox: Sandbox,
  options: {
    readonly branch: string;
    readonly leaseSha?: string;
    readonly advanced?: string;
  },
): Promise<void> => {
  const ref = quote(options.branch);
  const lease =
    options.leaseSha === undefined
      ? "--force"
      : `--force-with-lease=${quote(`refs/heads/${options.branch}:${options.leaseSha}`)}`;
  const pushed = await sandbox.exec({
    ...withGitHubToken(`push ${lease} origin ${ref}`),
    allowFailure: true,
  });
  if (pushed.exitCode === 0) {
    return;
  }
  console.error(pushed.stderr);
  if (
    /non-fast-forward|rejected|fetch first|stale info/iu.test(pushed.stderr)
  ) {
    fail(options.advanced ?? "The branch advanced during the run.");
  }
  fail(`git push failed with exit code ${pushed.exitCode}.`);
};

/** Prints what the agent does as it does it, for the job's log. */
export const logEvent = (event: AgentStreamEvent): void => {
  if (event.type === "text") {
    console.log(event.text);
  } else if (event.type === "toolCall") {
    console.log(`[tool] ${event.name}`);
  }
};
