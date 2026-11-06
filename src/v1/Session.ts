import type {
  OutputDefinition,
  OutputObjectDefinition,
  OutputStringDefinition,
} from "./Output.js";
import type { AgentProvider } from "./agents.js";
import type { SessionRecordOptions } from "./SessionRecord.js";

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
  /**
   * Send the session's record (its native transcript plus its events) to
   * these sinks when it ends, redacted inside the sandbox first. Default none.
   */
  readonly record?: SessionRecordOptions;
  /** Stops the agent. `session()` and `wait()` then reject with `SessionFailedError` (`aborted`). */
  readonly abortSignal?: AbortSignal;
}

/**
 * How a session ended. `closing-tag`: it printed its output's closing tag and
 * went quiet, so it was stopped and counts as done. `time-limit`: it was
 * carried on past a detach and the detach deadline stopped it.
 */
export type SessionExitReason =
  | "completed"
  | "closing-tag"
  | "failed"
  | "idle-timeout"
  | "aborted"
  | "time-limit";

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
  /**
   * Hand the running agent a message, like `send()` on the sandbox, for this
   * session. Rejects with `SessionInputError` when it can't take one.
   */
  readonly send: (options: SessionSendOptions) => Promise<SendReceipt>;
}

/** Options for `SessionProcess.send()`. */
export interface SessionSendOptions {
  /** The message. The agent reads it as a user message. */
  readonly text: string;
  /**
   * Stop the agent's current turn first, so the message starts the next one
   * instead of waiting for a tool to finish. Default `false`.
   */
  readonly interrupt?: boolean;
  /**
   * Who is sending it, e.g. `"Ada"` or `"monitor"`. The agent reads the
   * message as `[from <from>] <text>`, so it can weigh who said it, and the
   * session's record keeps it. Left out, the text goes as it is.
   */
  readonly from?: string;
}

/**
 * Options for `send()` on a detachable sandbox, which hands a running
 * session's agent a message: guidance it reads at its next tool result, in
 * the turn it's in, or as the next turn once that has ended. With
 * `interrupt`, its current turn stops first and the message starts the
 * next. The session carries on and ends as it would have, its result from
 * its last turn. `send()` works on a held handle, after a detach, and on a
 * reattached one, while the session supervisor runs. It resolves once the
 * message is written to the agent's input; `follow()` and the session's
 * record show it as an `input` event. It rejects with `SessionInputError`
 * when no such session is running, when several are and `session` is left
 * out, when the agent has finished its last turn, or when its agent takes no
 * input (`acceptsInput`).
 */
export interface SendOptions extends SessionSendOptions {
  /** The running session's name. Default the only session running. */
  readonly session?: string;
}

/**
 * Proof that a message was written to a session's agent. It means "on its
 * way": the agent reads it at its next tool result, or once its turn ends,
 * as the next one. The session's events show it as an `input` event.
 */
export interface SendReceipt {
  /** The session's name. */
  readonly session: string;
  /** When it was written to the agent's input, by the sandbox's clock. */
  readonly at: Date;
  /** Whether the agent's turn was stopped first. */
  readonly interrupted: boolean;
}
