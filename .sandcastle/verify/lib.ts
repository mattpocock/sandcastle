/**
 * Shared pieces of the verify harness: the combination (agents, sandboxes,
 * their keys and cheapest models), secret handling and process helpers.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Root of the Sandcastle checkout under test. */
export const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

// --- The combination ----------------------------------------------------------

export type Agent =
  | "claudeCode"
  | "pi"
  | "codex"
  | "cursor"
  | "opencode"
  | "copilot";
export const AGENTS: readonly Agent[] = [
  "claudeCode",
  "pi",
  "codex",
  "cursor",
  "opencode",
  "copilot",
];

/** Sandboxes a world may run. noSandbox is left out on purpose: it runs the
 *  agent on this host with the host's full env, and its unit tests cover it. */
export type Sandbox = "docker" | "podman" | "vercel" | "daytona";
export const SANDBOXES: readonly Sandbox[] = [
  "docker",
  "podman",
  "vercel",
  "daytona",
];

/**
 * The cheapest model each agent can do a one-file, one-commit task with. A
 * pricier model proves nothing more about Sandcastle. Override one run with
 * VERIFY_MODEL=<id>.
 */
const CHEAP_MODELS: Record<Agent, string> = {
  claudeCode: "claude-haiku-5-5", // Claude Haiku 5.5
  pi: "anthropic/claude-haiku-5-5", // pi takes provider/id
  codex: "gpt-6-luna", // "most efficient" Codex model
  cursor: "composer-2", // init's default; cheapest id unconfirmed
  opencode: "opencode/big-pickle", // free on OpenCode Zen
  copilot: "claude-haiku-4.5", // 0.33x premium requests
};

export const cheapModel = (agent: Agent): string =>
  process.env.VERIFY_MODEL || CHEAP_MODELS[agent];

/** The `sandcastle init --agent` value for each factory. */
export const INIT_AGENT: Record<Agent, string> = {
  claudeCode: "claude-code",
  pi: "pi",
  codex: "codex",
  cursor: "cursor",
  opencode: "opencode",
  copilot: "copilot",
};

/** Keys each agent needs; any one of a group's alternatives is enough. */
export const AGENT_KEYS: Record<Agent, readonly (readonly string[])[]> = {
  claudeCode: [["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]],
  pi: [["ANTHROPIC_API_KEY"]],
  codex: [["CODEX_API_KEY"]],
  cursor: [["CURSOR_API_KEY"]],
  opencode: [["OPENCODE_API_KEY"]],
  // GH_TOKEN is usually the issue tracker's PAT; copilot needs "Copilot Requests".
  copilot: [["COPILOT_GITHUB_TOKEN"]],
};

/** What each sandbox needs on this machine: keys, or a working command. */
export const SANDBOX_NEEDS: Record<
  Sandbox,
  { keys: readonly (readonly string[])[]; command?: readonly string[] }
> = {
  docker: { keys: [], command: ["docker", "info"] },
  podman: { keys: [], command: ["podman", "info"] },
  vercel: { keys: [["VERCEL_TOKEN", "VERCEL_OIDC_TOKEN"]] },
  daytona: { keys: [["DAYTONA_API_KEY"]] },
};

/** The keys groups that are missing from the environment, by first name. */
export const missingKeys = (groups: readonly (readonly string[])[]): string[] =>
  groups
    .filter((alts) => !alts.some((k) => process.env[k]))
    .map((alts) => alts.join("|"));

// --- Keys -------------------------------------------------------------------

/**
 * The keys file: this checkout's `.sandcastle/.env`, or, from a git
 * worktree that has none, the main checkout's. Matt fills it with
 * `.sandcastle/setup-verify-keys.sh`.
 */
export const keysFile = (): string | undefined => {
  const own = join(REPO_ROOT, ".sandcastle", ".env");
  if (existsSync(own)) return own;
  const common = sh(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      cwd: REPO_ROOT,
    },
  ).stdout.trim();
  const main = common ? join(dirname(common), ".sandcastle", ".env") : "";
  return main && existsSync(main) ? main : undefined;
};

/** Load the keys file into process.env (shell values win). Never prints. */
export const loadKeys = (): void => {
  const file = keysFile();
  if (!file) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const [, key, raw] = m as unknown as [string, string, string];
    const value = raw.replace(/^(['"])(.*)\1$/, "$2");
    if (value && !process.env[key]) process.env[key] = value;
  }
};

// --- Secret redaction -----------------------------------------------------------

export const SECRET_NAME = /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL/i;

/** Every secret-looking variable in `env`, as name → value. */
export const secretsIn = (
  env: NodeJS.ProcessEnv = process.env,
): Map<string, string> => {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(env)) {
    if (v && v.length >= 8 && SECRET_NAME.test(k)) out.set(k, v);
  }
  return out;
};

/** Replace the value of every secret-looking env var with `<NAME>`. */
export const redact = (text: string): string => {
  let out = text;
  for (const [key, value] of secretsIn())
    out = out.split(value).join(`<${key}>`);
  return out;
};

// --- Processes --------------------------------------------------------------

export interface ShResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run a command to completion. Never throws: inspect `code`. */
export const sh = (
  command: string,
  args: readonly string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): ShResult => {
  const r = spawnSync(command, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: (r.stderr ?? "") + (r.error ? `\n${r.error.message}` : ""),
  };
};

/** True when `command args…` exits 0. */
export const works = (command: readonly string[]): boolean =>
  sh(command[0]!, command.slice(1), { timeoutMs: 30_000 }).code === 0;
