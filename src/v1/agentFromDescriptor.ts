import type { AgentProvider } from "../AgentProvider.js";
import {
  claudeCode,
  codex,
  copilot,
  cursor,
  opencode,
  pi,
} from "../AgentProvider.js";
import type { AgentDescriptor } from "./supervisorProtocol.js";

// Inside the sandbox: the supervisor rebuilds a session's agent from the
// descriptor the host sent, using the same agent providers 0.x runs on the
// host, so the command lines and stream parsers are the ones users know.

const FACTORIES: Readonly<
  Record<
    AgentDescriptor["id"],
    (model: string, options: Record<string, unknown>) => AgentProvider
  >
> = {
  "claude-code": claudeCode,
  codex,
  cursor,
  opencode,
  copilot,
  pi,
};

/** The agent provider a descriptor names, built inside the sandbox. */
export const agentFromDescriptor = (
  descriptor: AgentDescriptor,
): AgentProvider =>
  FACTORIES[descriptor.id](descriptor.model, {
    ...descriptor.options,
    captureSessions: false,
  });
