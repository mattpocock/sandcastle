import {
  claudeCode,
  codex,
  copilot,
  cursor,
  opencode,
  pi,
  type AgentProvider,
  type ClaudeCodeOptions,
  type CodexOptions,
  type CopilotOptions,
  type CursorOptions,
  type OpenCodeOptions,
  type PiOptions,
} from "./AgentProvider.js";
import { withAgentFallback, type AgentChainEntry } from "./AgentFallback.js";
import { withCredentialScope } from "./CredentialScope.js";
import type { RoleProvider, RoleSetting, RoleTarget } from "./Operator.js";

/**
 * Project-owned provider options (sessions, env, permission modes). Top-level
 * fields are Codex options, preserving the original `agent(role, options)`
 * contract; other providers read their own entry under `providers`. Effort is
 * always taken from the role configuration.
 */
export type RoleAgentOptions = Omit<CodexOptions, "effort"> & {
  readonly providers?: {
    readonly claudeCode?: Omit<ClaudeCodeOptions, "effort">;
    readonly pi?: Omit<PiOptions, "thinking">;
    readonly opencode?: Omit<OpenCodeOptions, "variant">;
    readonly copilot?: Omit<CopilotOptions, "effort">;
    readonly cursor?: CursorOptions;
  };
};

const builders: {
  [P in RoleProvider]: (
    target: RoleTarget,
    options: RoleAgentOptions | undefined,
  ) => AgentProvider;
} = {
  codex: (target, options) => {
    const { providers: _ignored, ...codexOptions } = options ?? {};
    return codex(target.model, {
      ...codexOptions,
      effort: target.effort as CodexOptions["effort"],
    });
  },
  claudeCode: (target, options) =>
    claudeCode(target.model, {
      ...options?.providers?.claudeCode,
      effort: target.effort as ClaudeCodeOptions["effort"],
    }),
  pi: (target, options) =>
    pi(target.model, {
      ...options?.providers?.pi,
      thinking: target.effort as PiOptions["thinking"],
    }),
  opencode: (target, options) =>
    opencode(target.model, {
      ...options?.providers?.opencode,
      ...(target.effort === undefined ? {} : { variant: target.effort }),
    }),
  copilot: (target, options) =>
    copilot(target.model, {
      ...options?.providers?.copilot,
      effort: target.effort as CopilotOptions["effort"],
    }),
  cursor: (target, options) => cursor(target.model, options?.providers?.cursor),
};

/** Build the agent provider for one validated role target. */
export const buildRoleAgent = (
  target: RoleTarget,
  options?: RoleAgentOptions,
): AgentProvider =>
  withCredentialScope(
    builders[target.provider](target, options),
    target.provider,
  );

const entry = (
  target: RoleTarget,
  options: RoleAgentOptions | undefined,
): AgentChainEntry => ({
  agent: buildRoleAgent(target, options),
  target: {
    provider: target.provider,
    model: target.model,
    ...(target.effort === undefined ? {} : { effort: target.effort }),
  },
});

/**
 * Build the role's primary provider with its configured fallback chain
 * attached. Without fallbacks this is exactly `buildRoleAgent(setting)`.
 */
export const buildRoleAgentWithFallback = (
  setting: RoleSetting,
  options?: RoleAgentOptions,
): AgentProvider =>
  withAgentFallback(
    entry(setting, options),
    setting.fallback.map((target) => entry(target, options)),
  );
