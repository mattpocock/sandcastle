import type {
  ClaudeCodeOptions,
  CodexOptions,
  CopilotOptions,
  CursorOptions,
  OpenCodeOptions,
  PiOptions,
} from "../AgentProvider.js";
import type { AgentDescriptor } from "./supervisorProtocol.js";

// Agents run inside the sandbox, under the session supervisor, so a session
// names its agent by id plus options: a value that can cross into the
// sandbox. Each factory below records that descriptor; the supervisor
// rebuilds the agent from it. Custom agent providers can't cross, because
// their functions can't.

/** The built-in agents' ids. */
export type AgentName =
  | "claude-code"
  | "codex"
  | "cursor"
  | "opencode"
  | "copilot"
  | "pi";

/** A built-in agent and model for a session. Make one with `claudeCode()` and friends. */
export interface AgentProvider {
  /** The agent's id, e.g. `"claude-code"`. */
  readonly name: AgentName;
  /** The model it runs. */
  readonly model: string;
}

// `captureSessions` and `sessionStorage` only applied to 0.x's host-side
// session capture, which v1 doesn't do.

/** Options for `claudeCode()`. */
export type ClaudeCodeAgentOptions = Omit<
  ClaudeCodeOptions,
  "captureSessions" | "sessionStorage"
>;
/** Options for `codex()`. */
export type CodexAgentOptions = Omit<
  CodexOptions,
  "captureSessions" | "sessionStorage"
>;
/** Options for `cursor()`. */
export type CursorAgentOptions = Omit<
  CursorOptions,
  "captureSessions" | "sessionStorage"
>;
/** Options for `opencode()`. */
export type OpenCodeAgentOptions = Omit<
  OpenCodeOptions,
  "captureSessions" | "sessionStorage"
>;
/** Options for `copilot()`. */
export type CopilotAgentOptions = Omit<
  CopilotOptions,
  "captureSessions" | "sessionStorage"
>;
/** Options for `pi()`. */
export type PiAgentOptions = Omit<
  PiOptions,
  "captureSessions" | "sessionStorage"
>;

const descriptors = new WeakMap<AgentProvider, AgentDescriptor>();

/** Records how the supervisor rebuilds `agent`. */
export const registerAgent = (descriptor: AgentDescriptor): AgentProvider => {
  const agent: AgentProvider = {
    name: descriptor.id,
    model: descriptor.model,
  };
  descriptors.set(agent, descriptor);
  return agent;
};

/** How the supervisor rebuilds `agent`; throws for an agent not made by a built-in factory. */
export const agentDescriptor = (agent: AgentProvider): AgentDescriptor => {
  const descriptor = descriptors.get(agent);
  if (descriptor === undefined) {
    throw new TypeError(
      "session: `agent` must come from a built-in agent factory (claudeCode(), codex(), cursor(), opencode(), copilot() or pi()) of @ai-hero/sandcastle/v1. Custom agent providers can't run inside the sandbox.",
    );
  }
  return descriptor;
};

const make = (
  id: AgentName,
  model: string,
  options: object | undefined,
): AgentProvider => registerAgent({ id, model, options: { ...options } });

/** Claude Code (`claude`). */
export const claudeCode = (
  model: string,
  options?: ClaudeCodeAgentOptions,
): AgentProvider => make("claude-code", model, options);

/** OpenAI's Codex CLI (`codex`). */
export const codex = (
  model: string,
  options?: CodexAgentOptions,
): AgentProvider => make("codex", model, options);

/** Cursor's agent CLI (`agent`). */
export const cursor = (
  model: string,
  options?: CursorAgentOptions,
): AgentProvider => make("cursor", model, options);

/** OpenCode (`opencode`). */
export const opencode = (
  model: string,
  options?: OpenCodeAgentOptions,
): AgentProvider => make("opencode", model, options);

/** GitHub Copilot CLI (`copilot`). */
export const copilot = (
  model: string,
  options?: CopilotAgentOptions,
): AgentProvider => make("copilot", model, options);

/** Pi (`pi`). */
export const pi = (model: string, options?: PiAgentOptions): AgentProvider =>
  make("pi", model, options);
