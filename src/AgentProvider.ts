export type ParsedStreamEvent =
  | { type: "text"; text: string }
  | { type: "result"; result: string }
  | { type: "tool_call"; name: string; args: string }
  | { type: "session_id"; sessionId: string };

const shellEscape = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

/** Maps allowlisted tool names to the input field containing the display arg */
const TOOL_ARG_FIELDS: Record<string, string> = {
  Bash: "command",
  WebSearch: "query",
  WebFetch: "url",
  Agent: "description",
};

/**
 * Extract an error message from a parsed JSON error event.
 * Handles { error: "string" }, { error: { message: "string" } }, and { message: "string" }.
 */
const extractErrorMessage = (obj: any): string | undefined => {
  const err = obj.error;
  if (typeof err === "string") return err;
  if (
    typeof err === "object" &&
    err !== null &&
    typeof err.message === "string"
  ) {
    return err.message;
  }
  if (typeof obj.message === "string") return obj.message;
  return undefined;
};

const parseStreamJsonLine = (line: string): ParsedStreamEvent[] => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line);
    if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
      const events: ParsedStreamEvent[] = [];
      const texts: string[] = [];
      for (const block of obj.message.content as {
        type: string;
        text?: string;
        name?: string;
        input?: Record<string, unknown>;
      }[]) {
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (
          block.type === "tool_use" &&
          typeof block.name === "string" &&
          block.input !== undefined
        ) {
          const argField = TOOL_ARG_FIELDS[block.name];
          if (argField === undefined) continue; // not allowlisted
          const argValue = block.input[argField];
          if (typeof argValue !== "string") continue; // missing/wrong arg field
          if (texts.length > 0) {
            events.push({ type: "text", text: texts.join("") });
            texts.length = 0;
          }
          events.push({
            type: "tool_call",
            name: block.name,
            args: argValue,
          });
        }
      }
      if (texts.length > 0) {
        events.push({ type: "text", text: texts.join("") });
      }
      return events;
    }
    if (obj.type === "result" && typeof obj.result === "string") {
      return [{ type: "result", result: obj.result }];
    }
    if (
      obj.type === "system" &&
      obj.subtype === "init" &&
      typeof obj.session_id === "string"
    ) {
      return [{ type: "session_id", sessionId: obj.session_id }];
    }
  } catch {
    // Not valid JSON — skip
  }
  return [];
};

/** Options passed to buildPrintCommand and buildInteractiveArgs. */
export interface AgentCommandOptions {
  readonly prompt: string;
  readonly dangerouslySkipPermissions: boolean;
  /** When set, the agent should resume the given session ID instead of starting fresh. */
  readonly resumeSession?: string;
}

/** Return type of buildPrintCommand — command string plus optional stdin content.
 *  When `stdin` is set, the sandbox pipes it to the child process's stdin
 *  instead of inlining the prompt in argv, avoiding the Linux 128 KB per-arg limit. */
export interface PrintCommand {
  readonly command: string;
  readonly stdin?: string;
}

/** Per-iteration token usage snapshot extracted from the agent session. */
export interface IterationUsage {
  readonly inputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly outputTokens: number;
}

export interface AgentProvider {
  readonly name: string;
  /** Environment variables injected by this agent provider. Merged at launch time with env resolver and sandbox provider env. */
  readonly env: Record<string, string>;
  /** When true, session capture is enabled for this provider. Default: true for Claude Code, false for others. */
  readonly captureSessions: boolean;
  buildPrintCommand(options: AgentCommandOptions): PrintCommand;
  buildInteractiveArgs?(options: AgentCommandOptions): string[];
  parseStreamLine(line: string): ParsedStreamEvent[];
  /** Parse token usage from the captured session JSONL content. Only implemented by Claude Code. */
  parseSessionUsage?(content: string): IterationUsage | undefined;
}

export const DEFAULT_MODEL = "claude-opus-4-7";

// ---------------------------------------------------------------------------
// Pi agent provider
// ---------------------------------------------------------------------------

const parsePiStreamLine = (line: string): ParsedStreamEvent[] => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line);
    if (obj.type === "message_update" && obj.assistantMessageEvent) {
      const evt = obj.assistantMessageEvent as {
        type: string;
        delta?: string;
      };
      if (evt.type === "text_delta" && typeof evt.delta === "string") {
        return [{ type: "text", text: evt.delta }];
      }
      return [];
    }
    if (obj.type === "tool_execution_start") {
      const toolName = obj.toolName;
      if (typeof toolName !== "string") return [];
      const argField = TOOL_ARG_FIELDS[toolName];
      if (argField === undefined) return [];
      const args = obj.args as Record<string, unknown> | undefined;
      if (!args) return [];
      const argValue = args[argField];
      if (typeof argValue !== "string") return [];
      return [{ type: "tool_call", name: toolName, args: argValue }];
    }
    // Pi emits agent_error / error events on stdout (not stderr) for auth
    // failures, rate limits, and API errors. Capture them as result events so
    // the Orchestrator's stderr-empty fallback can surface them to the user.
    if (obj.type === "agent_error" || obj.type === "error") {
      const msg = extractErrorMessage(obj);
      return msg ? [{ type: "result", result: msg }] : [];
    }
    if (obj.type === "agent_end" && Array.isArray(obj.messages)) {
      const messages = obj.messages as {
        role: string;
        content: { type: string; text?: string }[];
      }[];
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg?.role === "assistant") {
          const texts: string[] = [];
          for (const block of msg.content) {
            if (block.type === "text" && typeof block.text === "string") {
              texts.push(block.text);
            }
          }
          if (texts.length > 0) {
            return [{ type: "result", result: texts.join("") }];
          }
          break;
        }
      }
      return [];
    }
  } catch {
    // Not valid JSON — skip
  }
  return [];
};

/** Options for the pi agent provider. */
export interface PiOptions {
  /** Environment variables injected by this agent provider. */
  readonly env?: Record<string, string>;
}

export const pi = (model: string, options?: PiOptions): AgentProvider => ({
  name: "pi",
  env: options?.env ?? {},
  captureSessions: false,

  buildPrintCommand({ prompt }: AgentCommandOptions): PrintCommand {
    return {
      command: `pi -p --mode json --no-session --model ${shellEscape(model)}`,
      stdin: prompt,
    };
  },

  buildInteractiveArgs({ prompt }: AgentCommandOptions): string[] {
    const args = ["pi", "--model", model];
    if (prompt) args.push(prompt);
    return args;
  },

  parseStreamLine(line: string): ParsedStreamEvent[] {
    return parsePiStreamLine(line);
  },
});

// ---------------------------------------------------------------------------
// Codex agent provider
// ---------------------------------------------------------------------------

const parseCodexStreamLine = (line: string): ParsedStreamEvent[] => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line);

    // item.completed with agent_message → text + result
    if (
      obj.type === "item.completed" &&
      obj.item?.type === "agent_message" &&
      typeof obj.item.text === "string"
    ) {
      const text = obj.item.text;
      return [
        { type: "text", text },
        { type: "result", result: text },
      ];
    }

    // item.started with command_execution → tool call
    if (
      obj.type === "item.started" &&
      obj.item?.type === "command_execution" &&
      typeof obj.item.command === "string"
    ) {
      return [{ type: "tool_call", name: "Bash", args: obj.item.command }];
    }

    // Codex emits error events on stdout (not stderr) for auth failures,
    // rate limits, and API errors. Capture them as result events so the
    // Orchestrator's stderr-empty fallback can surface them to the user.
    if (obj.type === "error") {
      const msg = extractErrorMessage(obj);
      return msg ? [{ type: "result", result: msg }] : [];
    }

    // turn.completed → skip
  } catch {
    // Not valid JSON — skip
  }
  return [];
};

/** Options for the codex agent provider. */
export interface CodexOptions {
  readonly effort?: "low" | "medium" | "high" | "xhigh";
  /** Environment variables injected by this agent provider. */
  readonly env?: Record<string, string>;
}

export const codex = (
  model: string,
  options?: CodexOptions,
): AgentProvider => ({
  name: "codex",
  env: options?.env ?? {},
  captureSessions: false,

  buildPrintCommand({ prompt }: AgentCommandOptions): PrintCommand {
    const effortFlag = options?.effort
      ? ` -c ${shellEscape(`model_reasoning_effort="${options.effort}"`)}`
      : "";
    return {
      command: `codex exec --json --dangerously-bypass-approvals-and-sandbox -m ${shellEscape(model)}${effortFlag}`,
      stdin: prompt,
    };
  },

  buildInteractiveArgs({ prompt }: AgentCommandOptions): string[] {
    const args = ["codex", "--model", model];
    if (prompt) args.push(prompt);
    return args;
  },

  parseStreamLine(line: string): ParsedStreamEvent[] {
    return parseCodexStreamLine(line);
  },
});

// ---------------------------------------------------------------------------
// OpenCode agent provider
// ---------------------------------------------------------------------------

/** Options for the opencode agent provider. */
export interface OpenCodeOptions {
  /** Provider-specific reasoning effort variant (e.g. "high", "max", "low", "minimal"). */
  readonly variant?: string;
  /** Environment variables injected by this agent provider. */
  readonly env?: Record<string, string>;
}

export const opencode = (
  model: string,
  options?: OpenCodeOptions,
): AgentProvider => ({
  name: "opencode",
  env: options?.env ?? {},
  captureSessions: false,

  buildPrintCommand({ prompt }: AgentCommandOptions): PrintCommand {
    const variantFlag = options?.variant
      ? ` --variant ${shellEscape(options.variant)}`
      : "";
    return {
      command: `opencode run --model ${shellEscape(model)}${variantFlag} ${shellEscape(prompt)}`,
    };
  },

  buildInteractiveArgs({ prompt }: AgentCommandOptions): string[] {
    const args = ["opencode", "--model", model];
    if (prompt) args.push("-p", prompt);
    return args;
  },

  parseStreamLine(_line: string): ParsedStreamEvent[] {
    return [];
  },
});

// ---------------------------------------------------------------------------
// Cursor agent provider
// ---------------------------------------------------------------------------

const parseCursorToolCall = (toolCall: unknown): ParsedStreamEvent[] => {
  if (typeof toolCall !== "object" || toolCall === null) return [];

  const obj = toolCall as Record<string, any>;
  if (typeof obj.writeToolCall?.args?.path === "string") {
    return [
      { type: "tool_call", name: "Write", args: obj.writeToolCall.args.path },
    ];
  }
  if (typeof obj.readToolCall?.args?.path === "string") {
    return [
      { type: "tool_call", name: "Read", args: obj.readToolCall.args.path },
    ];
  }
  if (
    typeof obj.function?.name === "string" &&
    typeof obj.function?.arguments === "string"
  ) {
    const functionName = obj.function.name;
    const functionArgs = obj.function.arguments;
    if (functionName === "shell" || functionName === "bash") {
      let command = functionArgs;
      try {
        const parsedArgs = JSON.parse(functionArgs);
        if (
          typeof parsedArgs === "object" &&
          parsedArgs !== null &&
          typeof parsedArgs.command === "string"
        ) {
          command = parsedArgs.command;
        }
      } catch {
        // Function arguments are often plain strings; use them as-is.
      }
      return [{ type: "tool_call", name: "Bash", args: command }];
    }
    return [
      {
        type: "tool_call",
        name: functionName,
        args: functionArgs,
      },
    ];
  }
  return [];
};

const parseCursorStreamLine = (line: string): ParsedStreamEvent[] => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line);
    if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
      const texts: string[] = [];
      for (const block of obj.message.content as {
        type: string;
        text?: string;
      }[]) {
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        }
      }
      return texts.length > 0 ? [{ type: "text", text: texts.join("") }] : [];
    }
    if (
      obj.type === "result" &&
      obj.subtype === "success" &&
      obj.is_error === false &&
      typeof obj.result === "string"
    ) {
      return [{ type: "result", result: obj.result }];
    }
    if (obj.type === "tool_call" && obj.subtype === "started") {
      return parseCursorToolCall(obj.tool_call);
    }
    if (
      obj.type === "system" &&
      obj.subtype === "init" &&
      typeof obj.session_id === "string"
    ) {
      return [{ type: "session_id", sessionId: obj.session_id }];
    }
    if (obj.type === "error") {
      const msg = extractErrorMessage(obj);
      return msg ? [{ type: "result", result: msg }] : [];
    }
  } catch {
    // Not valid JSON — skip
  }
  return [];
};

/** Options for the cursor agent provider. */
export interface CursorOptions {
  /** Environment variables injected by this agent provider. */
  readonly env?: Record<string, string>;
}

export const cursor = (
  model: string = "auto",
  options?: CursorOptions,
): AgentProvider => ({
  name: "cursor",
  env: options?.env ?? {},
  captureSessions: false,

  buildPrintCommand({ prompt }: AgentCommandOptions): PrintCommand {
    return {
      command: `agent -p --force --output-format stream-json --model ${shellEscape(model)} ${shellEscape(prompt)}`,
    };
  },

  buildInteractiveArgs({ prompt }: AgentCommandOptions): string[] {
    const args = ["agent", "--model", model];
    if (prompt) args.push(prompt);
    return args;
  },

  parseStreamLine(line: string): ParsedStreamEvent[] {
    return parseCursorStreamLine(line);
  },
});

// ---------------------------------------------------------------------------
// Claude Code agent provider
// ---------------------------------------------------------------------------

export interface ClaudeCodeOptions {
  readonly effort?: "low" | "medium" | "high" | "max";
  /** Environment variables injected by this agent provider. */
  readonly env?: Record<string, string>;
  /** When false, session capture is disabled. Default: true. */
  readonly captureSessions?: boolean;
}

export const claudeCode = (
  model: string,
  options?: ClaudeCodeOptions,
): AgentProvider => ({
  name: "claude-code",
  env: options?.env ?? {},
  captureSessions: options?.captureSessions ?? true,

  buildPrintCommand({
    prompt,
    dangerouslySkipPermissions,
    resumeSession,
  }: AgentCommandOptions): PrintCommand {
    const skipPerms = dangerouslySkipPermissions
      ? " --dangerously-skip-permissions"
      : "";
    const effortFlag = options?.effort ? ` --effort ${options.effort}` : "";
    const resumeFlag = resumeSession
      ? ` --resume ${shellEscape(resumeSession)}`
      : "";
    return {
      command: `claude --print --verbose${skipPerms} --output-format stream-json --model ${shellEscape(model)}${effortFlag}${resumeFlag} -p -`,
      stdin: prompt,
    };
  },

  buildInteractiveArgs({
    prompt,
    dangerouslySkipPermissions,
  }: AgentCommandOptions): string[] {
    const args = ["claude"];
    if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
    args.push("--model", model);
    if (options?.effort) args.push("--effort", options.effort);
    if (prompt) args.push(prompt);
    return args;
  },

  parseStreamLine(line: string): ParsedStreamEvent[] {
    return parseStreamJsonLine(line);
  },

  parseSessionUsage(content: string): IterationUsage | undefined {
    const lines = content.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.startsWith("{")) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === "assistant" && obj.message?.usage) {
          const u = obj.message.usage;
          if (
            typeof u.input_tokens === "number" &&
            typeof u.cache_creation_input_tokens === "number" &&
            typeof u.cache_read_input_tokens === "number" &&
            typeof u.output_tokens === "number"
          ) {
            return {
              inputTokens: u.input_tokens,
              cacheCreationInputTokens: u.cache_creation_input_tokens,
              cacheReadInputTokens: u.cache_read_input_tokens,
              outputTokens: u.output_tokens,
            };
          }
        }
      } catch {
        // Not valid JSON — skip
      }
    }
    return undefined;
  },
});
