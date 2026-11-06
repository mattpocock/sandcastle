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
  /**
   * In `claude-code` format, how long a message sent with `send()` while the
   * agent's turn is still running (`hang`) waits before the agent reads it,
   * like one sent during a long tool call. Default 0.
   */
  readonly inputDelaySeconds?: number;
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
 *
 * In `claude-code` format it also takes messages like the real CLI: it reads
 * each one `send()` hands it and answers by repeating it (as its last text and
 * its result), so a test sees exactly what the model would read. A message
 * sent after its last line starts a new turn; one sent while it hangs is read
 * in the running turn, which then ends. An interrupt stops a hanging turn.
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
      ...(script.inputDelaySeconds === undefined
        ? {}
        : { inputDelayMs: script.inputDelaySeconds * 1000 }),
    },
  });
