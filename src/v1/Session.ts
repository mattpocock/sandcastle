import type {
  OutputDefinition,
  OutputObjectDefinition,
  OutputStringDefinition,
} from "../Output.js";
import type { AgentProvider } from "./agents.js";

/** The value a session's `output` definition produces. */
export type OutputType<O extends OutputDefinition | undefined> =
  O extends OutputObjectDefinition<infer T>
    ? T
    : O extends OutputStringDefinition
      ? string
      : undefined;

/** Options for `session` and `spawnSession`: one agent working on one prompt. */
export interface SessionOptions<
  O extends OutputDefinition | undefined = OutputDefinition | undefined,
> {
  /**
   * A label for errors and logs. Defaults to `session-<n>`. Must be unique
   * among the sandbox's sessions running at once.
   */
  readonly name?: string;
  /** The built-in agent and model this session runs, e.g. `claudeCode("claude-opus-4-8")`. */
  readonly agent: AgentProvider;
  /**
   * The prompt, used exactly as written. When `output` is set it must contain
   * the opening tag (`<tag>`), or the session fails before it starts.
   */
  readonly prompt: string;
  /** What the session must hand back. Its result's `output` is typed from it. */
  readonly output?: O;
  /** Fail the session if the agent prints nothing for this long. Default 600. */
  readonly idleTimeoutSeconds?: number;
  /**
   * Once the output's closing tag has appeared, how long the agent may stay
   * silent before its process is stopped and the session counts as done.
   * Covers a stray child process holding the agent's output open. Default 60.
   */
  readonly completionTimeoutSeconds?: number;
  /**
   * Continue an earlier session's conversation instead of starting fresh,
   * with the agent's own resume. Same sandbox, same agent and working
   * directory; nothing is copied to or from your machine.
   */
  readonly continueSession?: SessionResult;
  /** Directory the agent starts in. Relative paths resolve against `workingDirectory`. Default the sandbox's. */
  readonly workingDirectory?: string;
  /** Extra env for this session only, on top of the sandbox's env. */
  readonly env?: Readonly<Record<string, string>>;
  /** Stops the agent. `session()` and `wait()` then reject with `SessionFailedError` (`aborted`). */
  readonly abortSignal?: AbortSignal;
}

/** How a session ended. `closing-tag`: it printed its output's closing tag and went quiet, so it was stopped and counts as done. */
export type SessionExitReason =
  | "completed"
  | "closing-tag"
  | "failed"
  | "idle-timeout"
  | "aborted";

/** Token counts for a session's last model call. */
export interface SessionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

/** How full the agent's context window got: the input side of its last model call. */
export interface SessionContextWindow {
  /** Input tokens of the last model call, cached and uncached together. */
  readonly tokens: number;
  /** The model's context window, when the agent reports it. */
  readonly limit?: number;
}

/** What a finished session hands back. `O` is its structured output's type. */
export interface SessionResult<O = unknown> {
  /** The session's name. */
  readonly name: string;
  /** The agent's id, e.g. `"claude-code"`. */
  readonly agent: string;
  /** The agent's own session id, when it reports one. Needed to continue the session. */
  readonly sessionId?: string;
  /** The directory the agent ran in. A continued session runs there too. */
  readonly workingDirectory: string;
  /** `completed`, or `closing-tag` when it printed its output and hung. */
  readonly exitReason: "completed" | "closing-tag";
  /** The agent's final message. */
  readonly finalMessage: string;
  /** The structured output, validated against the session's schema. `undefined` without `output`. */
  readonly output: O;
  readonly usage?: SessionUsage;
  readonly contextWindow?: SessionContextWindow;
  /** The last few KB the agent printed. */
  readonly outputTail: string;
}

/** Something the agent did, as it did it. */
export type AgentStreamEvent =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "toolCall";
      readonly name: string;
      /** The tool's main argument (a command, a URL, a query), for display. */
      readonly args: string;
    };

/** A session started by `spawnSession`, already running. */
export interface SessionProcess<O = unknown> {
  /** The session's name. */
  readonly name: string;
  /** What the agent does, as it does it. Ends when the session ends. Read it once. */
  readonly events: AsyncIterable<AgentStreamEvent>;
  /**
   * Resolves with the result once the session ends. Rejects with
   * `SessionFailedError`, or `StructuredOutputError` when its output is
   * missing or doesn't match the schema.
   */
  readonly wait: () => Promise<SessionResult<O>>;
  /** Stops the agent. `wait()` then rejects with `SessionFailedError` (`aborted`). Safe to call twice. */
  readonly kill: () => Promise<void>;
}
