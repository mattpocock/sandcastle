import { spawnSync } from "node:child_process";
import { join } from "node:path";

export interface CodexCommandOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: "ignore" | "inherit";
}

export type CodexCommandRunner = (
  command: string,
  args: readonly string[],
  options: CodexCommandOptions,
) => { readonly status: number | null };

const defaultRunner: CodexCommandRunner = (command, args, options) =>
  spawnSync(command, args, options);

export type CodexLoginResult = "already-authenticated" | "authenticated";

/**
 * Authenticate Codex against a project-local home instead of the user's normal
 * ~/.codex directory. This keeps OAuth credentials and session history scoped
 * to the generated Sandcastle configuration.
 */
export const ensureCodexSubscriptionLogin = (
  repoDir: string,
  run: CodexCommandRunner = defaultRunner,
): CodexLoginResult => {
  const env = {
    ...process.env,
    CODEX_HOME: join(repoDir, ".sandcastle", "codex-home"),
  };

  const status = run("codex", ["login", "status"], {
    cwd: repoDir,
    env,
    stdio: "ignore",
  });
  if (status.status === 0) return "already-authenticated";

  const login = run("codex", ["login"], {
    cwd: repoDir,
    env,
    stdio: "inherit",
  });
  if (login.status !== 0) {
    throw new Error(
      "Codex ChatGPT login failed. Install the Codex CLI and run `CODEX_HOME=.sandcastle/codex-home codex login`.",
    );
  }
  return "authenticated";
};
