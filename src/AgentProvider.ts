import { join, posix, basename } from "node:path";
import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { BindMountSandboxHandle } from "./SandboxProvider.js";
import {
  hostSessionStore,
  sandboxSessionStore,
  transferSession,
  type SessionStore,
} from "./SessionStore.js";

export interface ParsedStreamEvent {
  readonly type: "text" | "result" | "tool_call" | "session_id";
  readonly text?: string;
  readonly result?: string;
  readonly name?: string;
  readonly args?: string;
  readonly sessionId?: string;
}

const shellEscape = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

/** Maps allowlisted tool names to the input field containing the display arg */
const TOOL_ARG_FIELDS: Record<string, string> = {
  Bash: "command",
  WebSearch: "query",
  WebFetch: "url",
  Agent: "description",
  // Gemini-cli and Sandcastle-specific tool names
  update_topic: "strategic_intent",
  read_file: "file_path",
  grep_search: "pattern",
  run_shell_command: "command",
  ask_user: "questions",
};

/**
 * Extract an error message from a parsed JSON error event.
 * Handles { error: "string" }, { error: { message: "string" } }, and { message: "string" }.
 */
const extractErrorMessage = (obj: any): string | undefined => {
  const err = obj.error;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null && typeof err.message === "string") {
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
  /** Optional session storage configuration. Only implemented by Gemini. */
  readonly sessionStorage?: {
    hostStore: (cwd: string) => SessionStore;
    sandboxStore: (cwd: string, handle: BindMountSandboxHandle) => SessionStore;
    transfer: (from: SessionStore, to: SessionStore, id: string) => Promise<void>;
  };
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

// ---------------------------------------------------------------------------
// Gemini agent provider
// ---------------------------------------------------------------------------

const parseGeminiStreamLine = (line: string): ParsedStreamEvent[] => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line);
    if (
      obj.type === "message" &&
      obj.role === "assistant" &&
      typeof obj.content === "string"
    ) {
      return [{ type: "text", text: obj.content }];
    }
    if (
      obj.type === "tool_use" &&
      typeof obj.tool_name === "string" &&
      obj.parameters !== undefined
    ) {
      const toolName = obj.tool_name;
      const argField = TOOL_ARG_FIELDS[toolName];
      if (argField === undefined) return [];
      const argValue = obj.parameters[argField];
      if (typeof argValue !== "string") return [];
      return [{ type: "tool_call", name: toolName, args: argValue }];
    }
    if (obj.type === "result" && typeof obj.status === "string") {
      // If result has content or we just want to signal end
      return [{ type: "result", result: obj.status }];
    }
    if (obj.type === "init" && typeof obj.session_id === "string") {
      return [{ type: "session_id", sessionId: obj.session_id }];
    }
  } catch {
    // Not valid JSON — skip
  }
  return [];
};

/** Options for the gemini agent provider. */
export interface GeminiOptions {
  /** Environment variables injected by this agent provider. */
  readonly env?: Record<string, string>;
  /** When false, session capture is enabled. Default: true. */
  readonly captureSessions?: boolean;
  /** Optional overrides for session storage paths. */
  readonly sessionStorage?: {
    /** Override for the host-side gemini root directory (default: ~/.gemini) */
    readonly hostGeminiDir?: string;
    /** Override for the sandbox-side gemini root directory (default: /home/agent/.gemini) */
    readonly sandboxGeminiDir?: string;
  };
}

export const gemini = (
  model: string,
  options?: GeminiOptions,
): AgentProvider => ({
  name: "gemini",
  env: options?.env ?? {},
  captureSessions: options?.captureSessions ?? true,
  sessionStorage: {
    hostStore: (cwd) => {
      const project = basename(cwd);
      const baseDir = join(
        options?.sessionStorage?.hostGeminiDir ?? process.env.HOME ?? "~",
        ".gemini",
        "tmp",
        project,
        "chats",
      );
      return {
        cwd,
        sessionFilePath: (id) => join(baseDir, id + ".jsonl"),
        readSession: async (id) => {
          const prefix = id.slice(0, 8);
          const files = await readdir(baseDir).catch(() => []);
          const match = files.find(
            (f) => f.includes(prefix) && f.endsWith(".jsonl"),
          );
          if (!match) throw new Error(`Session ${id} not found in ${baseDir}`);
          return await readFile(join(baseDir, match), "utf-8");
        },
        writeSession: async (id, content) => {
          await mkdir(baseDir, { recursive: true });
          const now = new Date()
            .toISOString()
            .replace(/:/g, "-")
            .replace(/\..+/, "");
          const filename = `session-${now}-${id.slice(0, 8)}.jsonl`;
          await writeFile(join(baseDir, filename), content);
        },
      };
    },
    sandboxStore: (cwd, handle) => {
      const project = basename(cwd);
      const baseDir = posix.join(
        options?.sessionStorage?.sandboxGeminiDir ?? "/home/agent",
        ".gemini",
        "tmp",
        project,
        "chats",
      );
      return {
        cwd,
        sessionFilePath: (id) => posix.join(baseDir, id + ".jsonl"),
        readSession: async (id) => {
          const prefix = id.slice(0, 8);
          const match = (
            await handle
              .exec(`ls ${baseDir} | grep ${prefix}`)
              .catch(() => ({ stdout: "" }))
          ).stdout.trim();
          if (!match) throw new Error(`Session ${id} not found in ${baseDir}`);
          const sandboxPath = posix.join(baseDir, match.split("\n")[0]!);
          const tmpPath = join(
            tmpdir(),
            `sandcastle-gemini-${id}-${Date.now()}.jsonl`,
          );
          await handle.copyFileOut(sandboxPath, tmpPath);
          try {
            return await readFile(tmpPath, "utf-8");
          } finally {
            await rm(tmpPath, { force: true }).catch(() => {});
          }
        },
        writeSession: async (id, content) => {
          const now = new Date()
            .toISOString()
            .replace(/:/g, "-")
            .replace(/\..+/, "");
          const filename = `session-${now}-${id.slice(0, 8)}.jsonl`;
          const sandboxPath = posix.join(baseDir, filename);
          const tmpPath = join(
            tmpdir(),
            `sandcastle-gemini-${id}-${Date.now()}.jsonl`,
          );
          await writeFile(tmpPath, content);
          try {
            await handle.exec(`mkdir -p ${baseDir}`);
            await handle.copyFileIn(tmpPath, sandboxPath);
          } finally {
            await rm(tmpPath, { force: true }).catch(() => {});
          }
        },
      };
    },
    transfer: async (from, to, id) => {
      const content = await from.readSession(id);
      const rewritten = content.replaceAll(from.cwd, to.cwd);
      await to.writeSession(id, rewritten);
    },
  },

  buildPrintCommand({
    prompt,
    resumeSession,
  }: AgentCommandOptions): PrintCommand {
    const resumeFlag = resumeSession
      ? ` --resume ${shellEscape(resumeSession)}`
      : "";
    return {
      command: `gemini -p - -o stream-json --approval-mode yolo --raw-output --accept-raw-output-risk --model ${shellEscape(model)}${resumeFlag}`,
      stdin: prompt,
    };
  },

  buildInteractiveArgs({ prompt }: AgentCommandOptions): string[] {
    const args = ["gemini", "--model", model];
    if (prompt) args.push(prompt);
    return args;
  },

  parseStreamLine(line: string): ParsedStreamEvent[] {
    return parseGeminiStreamLine(line);
  },

  parseSessionUsage(content: string): IterationUsage | undefined {
    const lines = content.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.startsWith("{")) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === "result" && obj.stats) {
          const s = obj.stats;
          // Note: gemini-cli stats fields might differ from Claude Code
          // but we map them as best as we can.
          return {
            inputTokens: s.input_tokens ?? 0,
            cacheCreationInputTokens: 0, // not directly available in result event
            cacheReadInputTokens: s.cached ?? 0,
            outputTokens: s.output_tokens ?? 0,
          };
        }
      } catch {
        // Not valid JSON — skip
      }
    }
    return undefined;
  },
});
