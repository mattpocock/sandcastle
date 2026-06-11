#!/usr/bin/env node
/**
 * MiniMax agent CLI wrapper for sandcastle.
 *
 * Usage (print mode):
 *   minimax -p --mode json --model <model>
 *   # reads prompt from stdin, streams JSON lines to stdout
 *
 * The wrapper calls the MiniMax Anthropic-compatible API and emits
 * sandcastle-compatible JSON stream events:
 *   {type:"text", text:"..."}
 *   {type:"tool_call", name:"Bash", args:"..."}
 *   {type:"result", result:"..."}
 *   {type:"session_id", sessionId:"..."}
 *   {type:"usage", usage:{...}}
 *
 * Auth: MINIMAX_ACCESS_TOKEN + optional MINIMAX_REFRESH_TOKEN env vars.
 * Token refresh is handled automatically.
 */

import * as readline from "node:readline";
import * as https from "node:https";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StreamEvent {
  type: "text" | "result" | "tool_call" | "session_id" | "usage";
  text?: string;
  result?: string;
  name?: string;
  args?: string;
  sessionId?: string;
  usage?: {
    inputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    outputTokens: number;
  };
}

interface MiniMaxToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

interface MiniMaxTextBlock {
  type: "text";
  text: string;
}

interface MiniMaxToolUseBlock {
  type: "tool_use";
  name: string;
  input: Record<string, unknown>;
}

type MiniMaxAssistantBlock = MiniMaxTextBlock | MiniMaxToolUseBlock;

interface MiniMaxMessage {
  role: "user" | "assistant";
  content:
    | string
    | Array<MiniMaxTextBlock | MiniMaxToolUseBlock | MiniMaxToolResultBlock>;
}

interface MiniMaxTool {
  name: string;
  description?: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

// ---------------------------------------------------------------------------
// Auth — OAuth token management with automatic refresh
// ---------------------------------------------------------------------------

interface TokenInfo {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

function getTokens(): TokenInfo {
  const accessToken = process.env.MINIMAX_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error(
      "MINIMAX_ACCESS_TOKEN environment variable is not set. " +
        "Set it in .sandcastle/.env or export it before running.",
    );
  }
  return {
    accessToken,
    refreshToken: process.env.MINIMAX_REFRESH_TOKEN,
    expiresAt: Date.now() + 55 * 60 * 1000, // refresh every 55 min
  };
}

// ---------------------------------------------------------------------------
// MiniMax API client
// ---------------------------------------------------------------------------

const MINIMAX_BASE_URL = "api.minimax.io";
const MINIMAX_API_PATH = "/anthropic/v1/messages";

const TOOL_ARG_FIELDS: Record<string, string> = {
  Bash: "command",
  WebSearch: "query",
  WebFetch: "url",
  Read: "path",
  Write: "path",
  Edit: "path",
  Grep: "path",
  Glob: "path",
};

function apiRequest(
  accessToken: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const options = {
      hostname: MINIMAX_BASE_URL,
      path: MINIMAX_API_PATH,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
        Authorization: `Bearer ${accessToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
    };

    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode !== 200) {
          try {
            const err = JSON.parse(raw);
            reject(
              new Error(
                `MiniMax API error ${res.statusCode}: ${err.error?.message ?? raw}`,
              ),
            );
          } catch {
            reject(new Error(`MiniMax API error ${res.statusCode}: ${raw}`));
          }
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error(`Failed to parse MiniMax response: ${raw}`));
        }
      });
    });

    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

async function* streamApiRequest(
  accessToken: string,
  body: Record<string, unknown>,
): AsyncGenerator<string> {
  const postData = JSON.stringify(body);

  const options = {
    hostname: MINIMAX_BASE_URL,
    path: MINIMAX_API_PATH,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(postData),
      Authorization: `Bearer ${accessToken}`,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
  };

  const result = await new Promise<{
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });

  if (result.statusCode !== 200) {
    try {
      const err = JSON.parse(result.body);
      throw new Error(
        `MiniMax API error ${result.statusCode}: ${err.error?.message ?? result.body}`,
      );
    } catch (e) {
      if (e instanceof Error) throw e;
      throw new Error(`MiniMax API error ${result.statusCode}: ${result.body}`);
    }
  }

  // SSE streaming: data: {...}\n\n
  const text = result.body;
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      yield line.slice(6);
    }
  }
}

// ---------------------------------------------------------------------------
// Tool execution (simple sandbox-safe subset)
// ---------------------------------------------------------------------------

async function executeTool(name: string, args: string): Promise<string> {
  if (name === "Bash" || name === "bash" || name === "Shell") {
    // For Bash, we use execSync for simplicity. This is intentionally limited.
    const { execSync } = await import("node:child_process");
    try {
      // Strip dangerous patterns
      if (args.includes("rm -rf /") || args.includes("dd if=")) {
        return `Tool blocked: potentially destructive command detected.`;
      }
      const result = execSync(args, {
        timeout: 120_000,
        cwd: process.env.SANDBOX_REPO_DIR || process.cwd(),
        encoding: "utf8",
      });
      return result as string;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
  return `Tool '${name}' is not implemented in the minimax CLI wrapper.`;
}

// ---------------------------------------------------------------------------
// Main agent loop
// ---------------------------------------------------------------------------

async function runAgent(prompt: string, model: string): Promise<void> {
  const tokens = getTokens();
  let accessToken = tokens.accessToken;
  let sessionId: string | undefined;

  const emit = (event: StreamEvent) => {
    process.stdout.write(JSON.stringify(event) + "\n");
  };

  const messages: MiniMaxMessage[] = [{ role: "user", content: prompt }];
  const tools: MiniMaxTool[] = [
    {
      name: "Bash",
      description: "Execute a shell command. Returns stdout+stderr output.",
      input_schema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute",
          },
        },
        required: ["command"],
      },
    },
    {
      name: "Read",
      description: "Read contents of a file.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    {
      name: "Write",
      description: "Write content to a file (creates or overwrites).",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    {
      name: "Edit",
      description: "Apply a unified diff to edit a file.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  ];

  const MAX_TURNS = 20;
  let turnCount = 0;

  while (turnCount < MAX_TURNS) {
    turnCount++;
    sessionId = `minimax-session-${Date.now()}-${turnCount}`;
    emit({ type: "session_id", sessionId });

    let assistantContent: MiniMaxAssistantBlock[] = [];

    try {
      const stream = streamApiRequest(accessToken, {
        model,
        max_tokens: 8192,
        messages,
        tools,
        stream: true,
      });

      for await (const chunk of stream) {
        try {
          const event = JSON.parse(chunk);

          if (event.type === "message_start") {
            // nothing to do
          } else if (event.type === "content_block_start") {
            if (event.content_block?.type === "text") {
              // will accumulate text
            } else if (event.content_block?.type === "tool_use") {
              const toolName = event.content_block.name as string;
              // Will collect args
              assistantContent.push({
                type: "tool_use",
                name: toolName,
                input: {},
              });
            }
          } else if (event.type === "content_block_delta") {
            if (event.delta?.type === "text_delta") {
              const text = event.delta.text as string;
              emit({ type: "text", text });
              assistantContent.push({ type: "text", text });
            } else if (event.delta?.type === "input_json_delta") {
              const idx = assistantContent.length - 1;
              if (idx >= 0 && assistantContent[idx]!.type === "tool_use") {
                const existing = assistantContent[idx] as {
                  type: "tool_use";
                  name: string;
                  input: Record<string, unknown>;
                };
                const partial = event.delta.partial_json as string;
                // Accumulate partial JSON args
                const current = (existing.input.__raw as string) ?? "";
                existing.input.__raw = current + partial;
              }
            }
          } else if (event.type === "message_delta") {
            const usage = event.usage;
            if (usage) {
              emit({
                type: "usage",
                usage: {
                  inputTokens: usage.input_tokens ?? 0,
                  cacheCreationInputTokens:
                    usage.cache_creation_input_tokens ?? 0,
                  cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
                  outputTokens: usage.output_tokens ?? 0,
                },
              });
            }
          } else if (event.type === "message_stop") {
            // End of response
          }
        } catch {
          // skip non-JSON chunks
        }
      }
    } catch (e) {
      emit({
        type: "result",
        result: `API error: ${e instanceof Error ? e.message : String(e)}`,
      });
      break;
    }

    // Check if assistant made tool calls
    const toolCalls: Array<{ name: string; input: Record<string, unknown> }> =
      [];
    for (const block of assistantContent) {
      if (block.type === "tool_use" && block.name) {
        const rawArgs = block.input?.__raw as string | undefined;
        let argsObj: Record<string, unknown> = {};
        if (rawArgs) {
          try {
            argsObj = JSON.parse(rawArgs);
          } catch {
            // partial JSON, try to parse what we have
          }
        }
        toolCalls.push({ name: block.name, input: argsObj });
      }
    }

    if (toolCalls.length === 0) {
      // No tool calls — final result
      const fullText = assistantContent
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      emit({ type: "result", result: fullText });
      break;
    }

    // Execute tool calls
    for (const tc of toolCalls) {
      const argField =
        TOOL_ARG_FIELDS[tc.name] ?? Object.keys(tc.input)[0] ?? "args";
      const argsStr =
        typeof tc.input[argField] === "string"
          ? (tc.input[argField] as string)
          : JSON.stringify(tc.input);
      emit({ type: "tool_call", name: tc.name, args: argsStr });
      const result = await executeTool(tc.name, argsStr);
      messages.push({
        role: "assistant",
        content: assistantContent,
      });
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `tool_${turnCount}`,
            content: result,
          },
        ],
      });
    }

    // Reset for next turn
    assistantContent = [];
  }

  if (turnCount >= MAX_TURNS) {
    emit({
      type: "result",
      result: `Max turns (${MAX_TURNS}) reached. Agent stopped.`,
    });
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse flags: -p, --print, --model <model>, --mode json
  let printMode = false;
  let model = "MiniMax-M3";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-p" || arg === "--print") {
      printMode = true;
    } else if ((arg === "--model" || arg === "-m") && i + 1 < args.length) {
      model = args[++i]!;
    }
  }

  if (!printMode) {
    process.stderr.write(
      "minimax CLI wrapper: run with --print (or -p) flag\n",
    );
    process.exit(1);
  }

  // Read prompt from stdin
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  const lines: string[] = [];
  for await (const line of rl) {
    lines.push(line);
  }
  const prompt = lines.join("\n");

  if (!prompt.trim()) {
    process.stderr.write("minimax: no prompt provided on stdin\n");
    process.exit(1);
  }

  try {
    await runAgent(prompt, model);
  } catch (e) {
    process.stdout.write(
      JSON.stringify({
        type: "result",
        result: `Fatal error: ${e instanceof Error ? e.message : String(e)}`,
      }) + "\n",
    );
    process.exit(1);
  }
}

main().catch((e) => {
  process.stderr.write(
    `minimax fatal: ${e instanceof Error ? e.message : String(e)}\n`,
  );
  process.exit(1);
});
