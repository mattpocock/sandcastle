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

// v1's own agent options: 0.x's minus `captureSessions` and `sessionStorage`,
// which only applied to 0.x's host-side session capture. v1 writes nothing
// to the host. Each factory below checks its options still fit the 0.x
// provider the supervisor rebuilds the agent with.

/** Options for `claudeCode()`. */
export interface ClaudeCodeAgentOptions {
  /** Environment variables the agent's process gets, on top of the sandbox's. */
  readonly env?: Readonly<Record<string, string>>;
  /** Reasoning effort level. */
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * Claude's `--permission-mode` flag. When set, it replaces the default
   * `--dangerously-skip-permissions`.
   */
  readonly permissionMode?:
    | "default"
    | "acceptEdits"
    | "plan"
    | "auto"
    | "dontAsk"
    | "bypassPermissions";
}

/** Options for `codex()`. */
export interface CodexAgentOptions {
  /** Environment variables the agent's process gets, on top of the sandbox's. */
  readonly env?: Readonly<Record<string, string>>;
  /** Reasoning effort level. */
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * Codex's `approvals_reviewer` config key. `"auto_review"` swaps the
   * default `--dangerously-bypass-approvals-and-sandbox` for `-a on-request`
   * and `-s danger-full-access`.
   */
  readonly approvalsReviewer?: "user" | "auto_review";
}

/** Options for `cursor()`. */
export interface CursorAgentOptions {
  /** Environment variables the agent's process gets, on top of the sandbox's. */
  readonly env?: Readonly<Record<string, string>>;
}

/** Options for `opencode()`. */
export interface OpenCodeAgentOptions {
  /** Environment variables the agent's process gets, on top of the sandbox's. */
  readonly env?: Readonly<Record<string, string>>;
  /** Provider-specific reasoning effort variant (e.g. "high", "max", "low", "minimal"). */
  readonly variant?: string;
  /** Named OpenCode agent/mode to run, OpenCode's own `--agent` flag (e.g. "build", "plan"). */
  readonly agent?: string;
}

/** Options for `copilot()`. */
export interface CopilotAgentOptions {
  /** Environment variables the agent's process gets, on top of the sandbox's. */
  readonly env?: Readonly<Record<string, string>>;
  /** Reasoning effort level, the CLI's `--effort` flag. */
  readonly effort?: "low" | "medium" | "high";
}

/** Options for `pi()`. */
export interface PiAgentOptions {
  /** Environment variables the agent's process gets, on top of the sandbox's. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Reasoning effort level, the CLI's `--thinking` flag. Left out, pi uses
   * its own default (`medium`), which some models reject: pass `"off"` for
   * those.
   */
  readonly thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

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
): AgentProvider =>
  make("claude-code", model, options satisfies ClaudeCodeOptions | undefined);

/** OpenAI's Codex CLI (`codex`). */
export const codex = (
  model: string,
  options?: CodexAgentOptions,
): AgentProvider =>
  make("codex", model, options satisfies CodexOptions | undefined);

/** Cursor's agent CLI (`agent`). */
export const cursor = (
  model: string,
  options?: CursorAgentOptions,
): AgentProvider =>
  make("cursor", model, options satisfies CursorOptions | undefined);

/** OpenCode (`opencode`). */
export const opencode = (
  model: string,
  options?: OpenCodeAgentOptions,
): AgentProvider =>
  make("opencode", model, options satisfies OpenCodeOptions | undefined);

/** GitHub Copilot CLI (`copilot`). */
export const copilot = (
  model: string,
  options?: CopilotAgentOptions,
): AgentProvider =>
  make("copilot", model, options satisfies CopilotOptions | undefined);

/** Pi (`pi`). */
export const pi = (model: string, options?: PiAgentOptions): AgentProvider =>
  make("pi", model, options satisfies PiOptions | undefined);
