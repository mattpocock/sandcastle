/**
 * Config overrides applied to every git command Sandcastle runs on the host
 * against a repo whose `.git` is bind-mounted into a sandbox.
 *
 * The sandbox can write `.git/hooks/*` and `.git/config`, so a hook or a
 * `core.fsmonitor` command planted from inside the container would otherwise
 * run on the host, outside the sandbox, the next time Sandcastle runs
 * `git worktree add`, `git status`, `git merge`, etc. (issue #1010).
 */
const HOST_GIT_CONFIG_OVERRIDES: ReadonlyArray<readonly [string, string]> = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
];

/**
 * Returns an environment for host-side git commands that disables hooks and
 * fsmonitor.
 *
 * Uses `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`, which take
 * precedence over every config file (including the repo's `.git/config`).
 * Existing `GIT_CONFIG_*` entries in `baseEnv` are preserved and the overrides
 * are appended after them so they win.
 */
export const hostGitEnv = (
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const parsed = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  let count = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  for (const [key, value] of HOST_GIT_CONFIG_OVERRIDES) {
    env[`GIT_CONFIG_KEY_${count}`] = key;
    env[`GIT_CONFIG_VALUE_${count}`] = value;
    count++;
  }
  env.GIT_CONFIG_COUNT = String(count);
  return env;
};
