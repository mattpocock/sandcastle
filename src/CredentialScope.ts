import type { AgentProvider } from "./AgentProvider.js";

/** Vendor API keys usable by multi-vendor agents (pi, opencode). */
const vendorKeys = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
] as const;

/**
 * Well-known agent credential variables each provider may read. Variables
 * outside this table (e.g. GH_TOKEN, project variables) are never touched.
 */
export const providerCredentialEnv: Record<string, readonly string[]> = {
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  claudeCode: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ],
  copilot: ["COPILOT_GITHUB_TOKEN"],
  cursor: ["CURSOR_API_KEY"],
  pi: vendorKeys,
  opencode: vendorKeys,
};
const allCredentialEnv = [
  ...new Set(Object.values(providerCredentialEnv).flat()),
].sort();

const scopeKey = Symbol.for("sandcastle.credentialScope");

/**
 * Mark a role-configured provider so each invocation receives only its own
 * agent credentials: every other well-known agent credential variable is
 * unset for that command. Unknown provider names are left unscoped.
 */
export const withCredentialScope = <P extends AgentProvider>(
  agent: P,
  provider: string,
): P => {
  if (!(provider in providerCredentialEnv)) return agent;
  Object.defineProperty(agent, scopeKey, {
    value: provider,
    enumerable: false,
  });
  return agent;
};

/** Credential variables to unset for this provider's command; empty when unscoped. */
export const credentialsToUnset = (agent: AgentProvider): readonly string[] => {
  const provider = (agent as unknown as Record<symbol, string | undefined>)[
    scopeKey
  ];
  if (provider === undefined) return [];
  const allowed = new Set(providerCredentialEnv[provider]);
  return allCredentialEnv.filter((name) => !allowed.has(name));
};

/** Prefix a sandbox command so it runs without the given variables. */
export const scopeCommand = (command: string, unset: readonly string[]) =>
  unset.length === 0
    ? command
    : `env ${unset.map((name) => `-u ${name}`).join(" ")} ${command}`;
