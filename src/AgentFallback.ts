import type { AgentProvider } from "./AgentProvider.js";

/** Identity of one provider choice, recorded on every attempt. Never contains credentials. */
export interface AgentTargetDescriptor {
  readonly provider: string;
  readonly model?: string;
  readonly effort?: string;
}

/** One entry of an ordered provider chain. */
export interface AgentChainEntry {
  readonly agent: AgentProvider;
  readonly target: AgentTargetDescriptor;
}

/** Outcome of one provider attempt within an iteration. */
export interface ProviderAttempt extends AgentTargetDescriptor {
  /** `succeeded`: the agent ran to exit 0. `fell-back`: a classified provider failure before any tool call moved on to the next entry. `failed`: the failure ended the iteration. */
  readonly outcome: "succeeded" | "fell-back" | "failed";
  /** Classified failure kind, when the attempt failed. */
  readonly reason?: ProviderFailureKind;
}

/** Provider failures that may move to a fallback when no tool call has happened. */
export type ProviderFailureKind =
  | "rate-limit"
  | "unavailable"
  | "authentication"
  | "missing-cli"
  | "model-unavailable"
  | "startup-timeout";

const patterns: readonly [ProviderFailureKind, RegExp][] = [
  ["rate-limit", /\b429\b|rate.?limit|too many requests|quota|usage limit/i],
  [
    "model-unavailable",
    /model[^\n]{0,80}\b(not found|not available|unavailable|not supported|does not exist|unknown)\b|unknown model|invalid model/i,
  ],
  [
    "authentication",
    /\b401\b|\b403\b|unauthori[sz]ed|not logged in|please log ?in|authentication|invalid api key|api key[^\n]{0,40}(missing|invalid)|credentials? (missing|expired|invalid)|token[^\n]{0,20}(expired|revoked)/i,
  ],
  [
    "missing-cli",
    /exited with code 127\b|command not found|ENOENT|no such file or directory[^\n]{0,40}(codex|claude|pi|opencode|copilot|cursor)/i,
  ],
  [
    "unavailable",
    /\b(500|502|503|504|529)\b|overloaded|service unavailable|bad gateway|gateway timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network error|socket hang up/i,
  ],
];

/**
 * Classify a provider failure message. Returns null for anything that is not
 * clearly a provider/infrastructure failure, so task failures never fall back.
 */
export const classifyProviderFailure = (
  message: string,
): ProviderFailureKind | null => {
  for (const [kind, pattern] of patterns)
    if (pattern.test(message)) return kind;
  return null;
};

const chainKey = Symbol.for("sandcastle.agentChain");

/**
 * Attach an ordered fallback chain to the primary provider. The returned
 * provider behaves exactly like the primary; run/createSandbox use the chain
 * only for classified provider failures before any tool call.
 */
export const withAgentFallback = (
  primary: AgentChainEntry,
  fallbacks: readonly AgentChainEntry[],
): AgentProvider => {
  if (fallbacks.length === 0) return primary.agent;
  // Copy own properties, including non-enumerable symbols such as a credential scope.
  const provider = Object.create(
    Object.getPrototypeOf(primary.agent) as object,
    Object.getOwnPropertyDescriptors(primary.agent),
  ) as AgentProvider;
  Object.defineProperty(provider, chainKey, {
    value: Object.freeze([primary, ...fallbacks]),
    enumerable: false,
  });
  return provider;
};

/** The provider's ordered chain; a plain provider is a chain of one. */
export const agentChainOf = (
  provider: AgentProvider,
): readonly AgentChainEntry[] =>
  (provider as unknown as Record<symbol, readonly AgentChainEntry[]>)[
    chainKey
  ] ?? [{ agent: provider, target: { provider: provider.name } }];
