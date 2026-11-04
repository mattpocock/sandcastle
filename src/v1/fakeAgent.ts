import type { AgentName, AgentProvider } from "./agents.js";
import { registerAgent } from "./agents.js";

/** What a fake agent replays. */
export interface FakeAgentScript {
  /**
   * Whose stream format the lines are in; that agent's real stream parser
   * reads them. Default `"claude-code"`.
   */
  readonly format?: AgentName;
  /** Raw stream lines to print, in order, e.g. recorded from a real run. */
  readonly lines: readonly string[];
  /** The exit code once the lines are printed. Default 0. */
  readonly exitCode?: number;
  /**
   * Keep running after the last line instead of exiting, like an agent whose
   * stray child process holds its output open. Default `false`.
   */
  readonly hang?: boolean;
}

/**
 * An agent for tests: the session supervisor runs it inside the sandbox in
 * place of the real CLI, and it prints recorded stream lines instead of
 * calling a model. Everything else is real: the agent's own command line,
 * its stream parser, timeouts and structured output. In `claude-code` format
 * it also keeps its session file where Claude Code would (under the sandbox
 * user's home), so `continueSession` works only in the same sandbox and
 * directory, and a resumed session fails like the real CLI when it can't
 * find the conversation.
 */
export const fakeAgent = (script: FakeAgentScript): AgentProvider =>
  registerAgent({
    id: script.format ?? "claude-code",
    model: "fake",
    options: {},
    replay: {
      lines: [...script.lines],
      exitCode: script.exitCode ?? 0,
      hang: script.hang ?? false,
    },
  });
