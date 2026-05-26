import {
  codexHostSessionStore,
  codexSandboxSessionStore,
  hostSessionStore,
  sandboxSessionStore,
  transferClaudeSession,
  transferCodexSession,
  type LocatableSessionStore,
  type SessionStore,
} from "./SessionStore.js";
import type { BindMountSandboxHandle } from "./SandboxProvider.js";

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
 * Handles { error: "string" }, { error: { message: "string" } },
 * { error: { data: { message: "string" } } }, and { message: "string" }.
 */
const extractErrorMessage = (obj: any): string | undefined => {
  const err = obj.error;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    if (typeof err.message === "string") return err.message;
    if (typeof err.data?.message === "string") return err.data.message;
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

/**
 * Cursor Agent CLI print mode passes the prompt as a positional argv argument; stdin is not
 * documented for delivering the prompt. Linux enforces a per-argument limit (~128 KiB, ARG_MAX
 * stack). Stay slightly under so users get a clear error instead of spawn E2BIG.
 */
const CURSOR_PRINT_PROMPT_MAX_BYTES = 120 * 1024;

function assertCursorPrintPromptFitsArgv(prompt: string): void {
  const n = Buffer.byteLength(prompt, "utf8");
  if (n > CURSOR_PRINT_PROMPT_MAX_BYTES) {
    throw new Error(
      `Cursor print-mode prompt is ${n} bytes (max ${CURSOR_PRINT_PROMPT_MAX_BYTES} bytes). The Cursor CLI accepts the prompt only as a command-line argument; shorten the prompt or split the work. Other Sandcastle providers use stdin for large prompts.`,
    );
  }
}

/** Cursor stream-json emits top-level `tool_call` events (see Cursor CLI output-format docs). */
const parseCursorToolCallStarted = (
  obj: Record<string, unknown>,
): ParsedStreamEvent[] => {
  if (obj.type !== "tool_call" || obj.subtype !== "started") return [];
  const toolCall = obj.tool_call;
  if (!toolCall || typeof toolCall !== "object") return [];

  const tc = toolCall as Record<string, unknown>;

  const readToolCall = tc.readToolCall as
    | { args?: { path?: unknown } }
    | undefined;
  if (readToolCall?.args && typeof readToolCall.args.path === "string") {
    return [{ type: "tool_call", name: "Read", args: readToolCall.args.path }];
  }

  const writeToolCall = tc.writeToolCall as
    | { args?: { path?: unknown } }
    | undefined;
  if (writeToolCall?.args && typeof writeToolCall.args.path === "string") {
    return [
      { type: "tool_call", name: "Write", args: writeToolCall.args.path },
    ];
  }

  const fn = tc.function as { name?: unknown; arguments?: unknown } | undefined;
  if (fn && typeof fn.name === "string") {
    const rawArgs = typeof fn.arguments === "string" ? fn.arguments : "";
    if (rawArgs) {
      try {
        const parsedArgs = JSON.parse(rawArgs) as Record<string, unknown>;
        if (typeof parsedArgs.command === "string") {
          return [
            { type: "tool_call", name: "Bash", args: parsedArgs.command },
          ];
        }
      } catch {
        // Use raw arguments string for display.
      }
      return [{ type: "tool_call", name: fn.name, args: rawArgs }];
    }
    return [{ type: "tool_call", name: fn.name, args: "" }];
  }

  return [];
};

const parseCursorStreamLine = (line: string): ParsedStreamEvent[] => {
  if (!line.startsWith("{")) return [];
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    // Not valid JSON — skip
    return [];
  }
  if (obj.type === "tool_call") {
    return parseCursorToolCallStarted(obj);
  }
  return parseStreamJsonLine(line);
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

export interface AgentSessionStorage {
  hostStore(cwd: string): SessionStore;
  sandboxStore(cwd: string, handle: BindMountSandboxHandle): SessionStore;
  transfer(from: SessionStore, to: SessionStore, id: string): Promise<void>;
}

export interface AgentProvider {
  readonly name: string;
  /** Environment variables injected by this agent provider. Merged at launch time with env resolver and sandbox provider env. */
  readonly env: Record<string, string>;
  /** When true, session capture is enabled for this provider. Default: true for Claude Code, false for others. */
  readonly captureSessions: boolean;
  /** Provider-owned storage and transfer behavior for resumable agent sessions. */
  readonly sessionStorage?: AgentSessionStorage;
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

    if (obj.type === "thread.started" && typeof obj.thread_id === "string") {
      return [{ type: "session_id", sessionId: obj.thread_id }];
    }

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
  /** When false, session capture is disabled. Default: true. */
  readonly captureSessions?: boolean;
  /** Override Codex session directories for tests or non-standard installs. */
  readonly sessionStorage?: {
    readonly hostSessionsDir?: string;
    readonly sandboxSessionsDir?: string;
  };
}

export const codex = (
  model: string,
  options?: CodexOptions,
): AgentProvider & { readonly sessionStorage: AgentSessionStorage } => ({
  name: "codex",
  env: options?.env ?? {},
  captureSessions: options?.captureSessions ?? true,
  sessionStorage: {
    hostStore: (cwd) =>
      codexHostSessionStore(cwd, options?.sessionStorage?.hostSessionsDir),
    sandboxStore: (cwd, handle) =>
      codexSandboxSessionStore(
        cwd,
        handle,
        options?.sessionStorage?.sandboxSessionsDir,
      ),
    // Both stores above are LocatableSessionStore by construction; the
    // AgentSessionStorage seam types them as the narrower SessionStore.
    transfer: (from, to, id) =>
      transferCodexSession(
        from as LocatableSessionStore,
        to as LocatableSessionStore,
        id,
      ),
  },

  buildPrintCommand({
    prompt,
    resumeSession,
  }: AgentCommandOptions): PrintCommand {
    const effortFlag = options?.effort
      ? ` -c ${shellEscape(`model_reasoning_effort="${options.effort}"`)}`
      : "";
    const base = resumeSession
      ? `codex exec resume ${shellEscape(resumeSession)}`
      : "codex exec";
    const stdinArg = resumeSession ? " -" : "";
    return {
      command: `${base} --json --dangerously-bypass-approvals-and-sandbox -m ${shellEscape(model)}${effortFlag}${stdinArg}`,
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
// Cursor agent provider
// ---------------------------------------------------------------------------

/** Options for the cursor agent provider. */
export interface CursorOptions {
  /** Environment variables injected by this agent provider. */
  readonly env?: Record<string, string>;
}

export const cursor = (
  model: string,
  options?: CursorOptions,
): AgentProvider => ({
  name: "cursor",
  env: options?.env ?? {},
  captureSessions: false,

  // Cursor has no filesystem-backed session storage (captureSessions: false, no
  // sessionStorage), so it is non-resumable per ADR 0012/0016. resumeSession is
  // ignored here — like pi and opencode — rather than wired to --resume.
  buildPrintCommand({
    prompt,
    dangerouslySkipPermissions,
  }: AgentCommandOptions): PrintCommand {
    assertCursorPrintPromptFitsArgv(prompt);
    const forceFlag = dangerouslySkipPermissions ? " --force" : "";

    return {
      command: `agent --print --output-format stream-json --model ${shellEscape(model)} ${forceFlag} ${shellEscape(prompt)}`,
    };
  },

  buildInteractiveArgs({
    prompt,
    dangerouslySkipPermissions,
  }: AgentCommandOptions): string[] {
    const args = ["agent", "--model", model];
    if (dangerouslySkipPermissions) args.push("--force");
    if (prompt) args.push(prompt);
    return args;
  },

  parseStreamLine(line: string): ParsedStreamEvent[] {
    return parseCursorStreamLine(line);
  },
});

// ---------------------------------------------------------------------------
// OpenCode agent provider
// ---------------------------------------------------------------------------

/** Maps OpenCode tool names to the input field containing the friendly display
 *  arg. Tools not listed here are still surfaced, falling back to a JSON dump of
 *  the whole input. The tool name is surfaced as-is (OpenCode's lowercase names). */
const OPENCODE_TOOL_ARG_FIELDS: Record<string, string> = {
  bash: "command",
  webfetch: "url",
  task: "description",
};

const parseOpenCodeStreamLine = (line: string): ParsedStreamEvent[] => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line);
    const part = obj.part;

    // step_start carries the session ID for the run.
    if (obj.type === "step_start" && typeof obj.sessionID === "string") {
      return [{ type: "session_id", sessionId: obj.sessionID }];
    }

    // text event → assistant text. Emit both text (for streaming display) and
    // result (final message; the last result wins in the Orchestrator).
    if (
      obj.type === "text" &&
      part?.type === "text" &&
      typeof part.text === "string"
    ) {
      return [
        { type: "text", text: part.text },
        { type: "result", result: part.text },
      ];
    }

    // tool_use event → tool call. Tool name is in part.tool, args in
    // part.state.input. Gate on the completed status so intermediate
    // pending/running states don't surface duplicate tool calls.
    if (obj.type === "tool_use" && part?.type === "tool") {
      if (typeof part.tool !== "string") return [];
      const state = part.state as
        | { status?: string; input?: Record<string, unknown> }
        | undefined;
      if (state?.status !== "completed") return [];
      const input = state.input;
      if (!input) return [];
      const argField = OPENCODE_TOOL_ARG_FIELDS[part.tool];
      const argValue = argField !== undefined ? input[argField] : undefined;
      const args =
        typeof argValue === "string" ? argValue : JSON.stringify(input);
      return [{ type: "tool_call", name: part.tool, args }];
    }

    // OpenCode emits error events on stdout (not stderr) for auth failures,
    // rate limits, and API errors. Capture them as result events so the
    // Orchestrator's stderr-empty fallback can surface them to the user.
    if (obj.type === "error") {
      const msg = extractErrorMessage(obj);
      return msg ? [{ type: "result", result: msg }] : [];
    }

    // step_finish, tool output, etc. → skip
  } catch {
    // Not valid JSON — skip
  }
  return [];
};

/** Options for the opencode agent provider. */
export interface OpenCodeOptions {
  /** Provider-specific reasoning effort variant (e.g. "high", "max", "low", "minimal"). */
  readonly variant?: string;
  /**
   * Named OpenCode agent/mode to run, mapped to OpenCode's own `--agent` flag
   * (e.g. "build", "plan"). This is distinct from Sandcastle's `--agent`
   * provider selector — it chooses an agent *inside* OpenCode.
   */
  readonly agent?: string;
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

  buildPrintCommand({
    prompt,
    dangerouslySkipPermissions,
  }: AgentCommandOptions): PrintCommand {
    const variantFlag = options?.variant
      ? ` --variant ${shellEscape(options.variant)}`
      : "";
    const agentFlag = options?.agent
      ? ` --agent ${shellEscape(options.agent)}`
      : "";
    const permissionsFlag = dangerouslySkipPermissions
      ? " --dangerously-skip-permissions"
      : "";
    return {
      command: `opencode run --format json --model ${shellEscape(model)}${variantFlag}${agentFlag}${permissionsFlag} ${shellEscape(prompt)}`,
    };
  },

  buildInteractiveArgs({ prompt }: AgentCommandOptions): string[] {
    const args = ["opencode", "--model", model];
    if (options?.agent) args.push("--agent", options.agent);
    if (prompt) args.push("-p", prompt);
    return args;
  },

  parseStreamLine(line: string): ParsedStreamEvent[] {
    return parseOpenCodeStreamLine(line);
  },
});

// ---------------------------------------------------------------------------
// Claude Code agent provider
// ---------------------------------------------------------------------------

export interface ClaudeCodeOptions {
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Environment variables injected by this agent provider. */
  readonly env?: Record<string, string>;
  /** When false, session capture is disabled. Default: true. */
  readonly captureSessions?: boolean;
  /** Override Claude session directories for tests or non-standard installs. */
  readonly sessionStorage?: {
    readonly hostProjectsDir?: string;
    readonly sandboxProjectsDir?: string;
  };
}

export const claudeCode = (
  model: string,
  options?: ClaudeCodeOptions,
): AgentProvider & { readonly sessionStorage: AgentSessionStorage } => ({
  name: "claude-code",
  env: options?.env ?? {},
  captureSessions: options?.captureSessions ?? true,
  sessionStorage: {
    hostStore: (cwd) =>
      hostSessionStore(cwd, options?.sessionStorage?.hostProjectsDir),
    sandboxStore: (cwd, handle) =>
      sandboxSessionStore(
        cwd,
        handle,
        options?.sessionStorage?.sandboxProjectsDir ??
          "/home/agent/.claude/projects",
      ),
    transfer: transferClaudeSession,
  },

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
