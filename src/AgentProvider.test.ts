import { describe, expect, it } from "vitest";
import {
  claudeCodeProvider,
  piProvider,
  codexProvider,
  getAgentProvider,
  parseClaudeStreamLine,
  parsePiStreamLine,
  parseCodexStreamLine,
} from "./AgentProvider.js";

describe("claudeCodeProvider", () => {
  it("has name 'claude-code'", () => {
    expect(claudeCodeProvider.name).toBe("claude-code");
  });

  it("envManifest contains ANTHROPIC_API_KEY and GH_TOKEN but NOT CLAUDE_CODE_OAUTH_TOKEN", () => {
    expect(claudeCodeProvider.envManifest).not.toHaveProperty(
      "CLAUDE_CODE_OAUTH_TOKEN",
    );
    expect(claudeCodeProvider.envManifest).toHaveProperty("ANTHROPIC_API_KEY");
    expect(claudeCodeProvider.envManifest).toHaveProperty("GH_TOKEN");
  });

  it("has a non-empty dockerfileTemplate", () => {
    expect(claudeCodeProvider.dockerfileTemplate).toContain("FROM");
    expect(claudeCodeProvider.dockerfileTemplate).toContain("claude");
  });

  it("has a default model", () => {
    expect(claudeCodeProvider.defaultModel).toBe("claude-opus-4-6");
  });

  it("builds a print command with claude CLI flags", () => {
    const cmd = claudeCodeProvider.buildPrintCommand({
      model: "claude-sonnet-4-6",
      prompt: "Hello world",
    });
    expect(cmd).toContain("claude");
    expect(cmd).toContain("--print");
    expect(cmd).toContain("--output-format stream-json");
    expect(cmd).toContain("claude-sonnet-4-6");
    expect(cmd).toContain("Hello world");
  });

  it("shell-escapes model and prompt in print command", () => {
    const cmd = claudeCodeProvider.buildPrintCommand({
      model: "my'model",
      prompt: "Fix the user's code",
    });
    expect(cmd).toContain("my'\\''model");
    expect(cmd).toContain("user'\\''s");
  });

  it("builds interactive args for claude", () => {
    const args = claudeCodeProvider.buildInteractiveArgs({
      model: "claude-sonnet-4-6",
    });
    expect(args[0]).toBe("claude");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("claude-sonnet-4-6");
  });

  it("parseStreamLine delegates to parseClaudeStreamLine", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello" }] },
    });
    expect(claudeCodeProvider.parseStreamLine(line)).toEqual(
      parseClaudeStreamLine(line),
    );
  });
});

describe("piProvider", () => {
  it("has name 'pi'", () => {
    expect(piProvider.name).toBe("pi");
  });

  it("envManifest contains ANTHROPIC_API_KEY and GH_TOKEN", () => {
    expect(piProvider.envManifest).toHaveProperty("ANTHROPIC_API_KEY");
    expect(piProvider.envManifest).toHaveProperty("GH_TOKEN");
  });

  it("has a non-empty dockerfileTemplate that installs pi", () => {
    expect(piProvider.dockerfileTemplate).toContain("FROM");
    expect(piProvider.dockerfileTemplate).toContain("pi-coding-agent");
  });

  it("has a default model", () => {
    expect(piProvider.defaultModel).toBe("claude-sonnet-4-6");
  });

  it("builds a print command with pi CLI flags", () => {
    const cmd = piProvider.buildPrintCommand({
      model: "claude-sonnet-4-6",
      prompt: "Hello world",
    });
    expect(cmd).toContain("pi");
    expect(cmd).toContain("-p");
    expect(cmd).toContain("--mode json");
    expect(cmd).toContain("--no-session");
    expect(cmd).toContain("'claude-sonnet-4-6'");
    expect(cmd).toContain("'Hello world'");
  });

  it("shell-escapes single quotes in prompts and model", () => {
    const cmd = piProvider.buildPrintCommand({
      model: "my'model",
      prompt: "Fix the user's code",
    });
    expect(cmd).toContain("my'\\''model");
    expect(cmd).toContain("user'\\''s");
  });

  it("builds interactive args for pi", () => {
    const args = piProvider.buildInteractiveArgs({
      model: "claude-sonnet-4-6",
    });
    expect(args[0]).toBe("pi");
    expect(args).toContain("--model");
    expect(args).toContain("claude-sonnet-4-6");
  });

  it("parseStreamLine delegates to parsePiStreamLine", () => {
    const line = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    });
    expect(piProvider.parseStreamLine(line)).toEqual(parsePiStreamLine(line));
  });
});

describe("codexProvider", () => {
  it("has name 'codex'", () => {
    expect(codexProvider.name).toBe("codex");
  });

  it("envManifest contains OPENAI_API_KEY and GH_TOKEN", () => {
    expect(codexProvider.envManifest).toHaveProperty("OPENAI_API_KEY");
    expect(codexProvider.envManifest).toHaveProperty("GH_TOKEN");
  });

  it("has a non-empty dockerfileTemplate that installs codex", () => {
    expect(codexProvider.dockerfileTemplate).toContain("FROM");
    expect(codexProvider.dockerfileTemplate).toContain("@openai/codex");
  });

  it("has a default model", () => {
    expect(codexProvider.defaultModel).toBe("gpt-5.4-mini");
  });

  it("builds a print command with codex exec flags", () => {
    const cmd = codexProvider.buildPrintCommand({
      model: "gpt-5.4",
      prompt: "Hello world",
    });
    expect(cmd).toContain("codex exec");
    expect(cmd).toContain("--json");
    expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(cmd).toContain("'gpt-5.4'");
    expect(cmd).toContain("'Hello world'");
  });

  it("shell-escapes model and prompt in print command", () => {
    const cmd = codexProvider.buildPrintCommand({
      model: "my'model",
      prompt: "Fix the user's code",
    });
    expect(cmd).toContain("my'\\''model");
    expect(cmd).toContain("user'\\''s");
  });

  it("builds interactive args for codex", () => {
    const args = codexProvider.buildInteractiveArgs({ model: "gpt-5.4" });
    expect(args[0]).toBe("codex");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).toContain("gpt-5.4");
  });

  it("parseStreamLine delegates to parseCodexStreamLine", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Hello" },
    });
    expect(codexProvider.parseStreamLine(line)).toEqual(
      parseCodexStreamLine(line),
    );
  });
});

describe("getAgentProvider", () => {
  it("returns claude-code provider for 'claude-code'", () => {
    const provider = getAgentProvider("claude-code");
    expect(provider.name).toBe("claude-code");
  });

  it("returns pi provider for 'pi'", () => {
    const provider = getAgentProvider("pi");
    expect(provider.name).toBe("pi");
  });

  it("returns codex provider for 'codex'", () => {
    const provider = getAgentProvider("codex");
    expect(provider.name).toBe("codex");
  });

  it("throws for unknown agent name", () => {
    expect(() => getAgentProvider("unknown-agent")).toThrow(/unknown-agent/);
  });
});

describe("parseClaudeStreamLine", () => {
  it("extracts text from assistant message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello world" }] },
    });
    expect(parseClaudeStreamLine(line)).toEqual([
      { type: "text", text: "Hello world" },
    ]);
  });

  it("extracts result from result message", () => {
    const line = JSON.stringify({
      type: "result",
      result: "Final answer <promise>COMPLETE</promise>",
    });
    expect(parseClaudeStreamLine(line)).toEqual([
      {
        type: "result",
        result: "Final answer <promise>COMPLETE</promise>",
        usage: null,
      },
    ]);
  });

  it("returns empty array for non-JSON lines", () => {
    expect(parseClaudeStreamLine("not json")).toEqual([]);
    expect(parseClaudeStreamLine("")).toEqual([]);
  });

  it("returns empty array for malformed JSON starting with {", () => {
    expect(parseClaudeStreamLine("{bad json")).toEqual([]);
    expect(parseClaudeStreamLine('{"type": "assistant", broken')).toEqual([]);
  });

  it("returns empty array for unrecognized JSON types", () => {
    const line = JSON.stringify({ type: "system", data: "something" });
    expect(parseClaudeStreamLine(line)).toEqual([]);
  });

  it("handles multiple text content blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
      },
    });
    expect(parseClaudeStreamLine(line)).toEqual([
      { type: "text", text: "Hello world" },
    ]);
  });

  it("skips malformed tool_use blocks (no name/input)", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "123" },
          { type: "text", text: "result" },
        ],
      },
    });
    expect(parseClaudeStreamLine(line)).toEqual([
      { type: "text", text: "result" },
    ]);
  });

  it("extracts tool_use block from assistant event (Bash → command arg)", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "npm test" } },
        ],
      },
    });
    expect(parseClaudeStreamLine(line)).toEqual([
      { type: "tool_call", name: "Bash", args: "npm test" },
    ]);
  });

  it("handles mixed text and tool_use content blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Running tests..." },
          { type: "tool_use", name: "Bash", input: { command: "npm test" } },
        ],
      },
    });
    expect(parseClaudeStreamLine(line)).toEqual([
      { type: "text", text: "Running tests..." },
      { type: "tool_call", name: "Bash", args: "npm test" },
    ]);
  });

  it("handles multiple tool_use blocks in one event", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "npm test" } },
          {
            type: "tool_use",
            name: "WebSearch",
            input: { query: "typescript types" },
          },
        ],
      },
    });
    expect(parseClaudeStreamLine(line)).toEqual([
      { type: "tool_call", name: "Bash", args: "npm test" },
      { type: "tool_call", name: "WebSearch", args: "typescript types" },
    ]);
  });

  it("extracts WebFetch tool_use with url arg", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "WebFetch",
            input: { url: "https://example.com" },
          },
        ],
      },
    });
    expect(parseClaudeStreamLine(line)).toEqual([
      { type: "tool_call", name: "WebFetch", args: "https://example.com" },
    ]);
  });

  it("extracts Agent tool_use with description arg", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Agent",
            input: { description: "Run tests and report results" },
          },
        ],
      },
    });
    expect(parseClaudeStreamLine(line)).toEqual([
      {
        type: "tool_call",
        name: "Agent",
        args: "Run tests and report results",
      },
    ]);
  });

  it("filters out non-allowlisted tools (Read, Glob, Grep, Edit, Write)", () => {
    for (const name of ["Read", "Glob", "Grep", "Edit", "Write"]) {
      const line = JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name, input: { file_path: "/some/file" } },
          ],
        },
      });
      expect(parseClaudeStreamLine(line)).toEqual([]);
    }
  });

  it("filters out tool_use blocks with missing expected input field", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          // Bash with no `command` field
          { type: "tool_use", name: "Bash", input: { other: "value" } },
        ],
      },
    });
    expect(parseClaudeStreamLine(line)).toEqual([]);
  });

  it("keeps text events even when all tool_use blocks are filtered out", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Looking at files..." },
          { type: "tool_use", name: "Read", input: { file_path: "/foo" } },
        ],
      },
    });
    expect(parseClaudeStreamLine(line)).toEqual([
      { type: "text", text: "Looking at files..." },
    ]);
  });

  it("returns only text when event has no tool_use blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Just text, no tools" }],
      },
    });
    expect(parseClaudeStreamLine(line)).toEqual([
      { type: "text", text: "Just text, no tools" },
    ]);
  });

  it("extracts usage data from result message", () => {
    const line = JSON.stringify({
      type: "result",
      result: "Done.",
      total_cost_usd: 0.14,
      num_turns: 3,
      duration_ms: 12000,
      usage: {
        input_tokens: 52340,
        output_tokens: 3201,
        cache_read_input_tokens: 10000,
        cache_creation_input_tokens: 5000,
      },
    });
    const parsed = parseClaudeStreamLine(line);
    expect(parsed).toEqual([
      {
        type: "result",
        result: "Done.",
        usage: {
          input_tokens: 52340,
          output_tokens: 3201,
          cache_read_input_tokens: 10000,
          cache_creation_input_tokens: 5000,
          total_cost_usd: 0.14,
          num_turns: 3,
          duration_ms: 12000,
        },
      },
    ]);
  });

  it("returns null usage when result message has no usage data", () => {
    const line = JSON.stringify({
      type: "result",
      result: "Done.",
    });
    const parsed = parseClaudeStreamLine(line);
    expect(parsed).toEqual([
      {
        type: "result",
        result: "Done.",
        usage: null,
      },
    ]);
  });

  it("returns null usage when usage fields are partial", () => {
    const line = JSON.stringify({
      type: "result",
      result: "Done.",
      usage: { input_tokens: 100 },
    });
    const parsed = parseClaudeStreamLine(line);
    expect(parsed).toEqual([
      {
        type: "result",
        result: "Done.",
        usage: null,
      },
    ]);
  });
});

describe("parsePiStreamLine", () => {
  it("extracts text from message_update with text_delta", () => {
    const line = JSON.stringify({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "Hello world" },
    });
    expect(parsePiStreamLine(line)).toEqual([
      { type: "text", text: "Hello world" },
    ]);
  });

  it("extracts bash tool call from tool_execution_start", () => {
    const line = JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call_123",
      toolName: "bash",
      args: { command: "npm test" },
    });
    expect(parsePiStreamLine(line)).toEqual([
      { type: "tool_call", name: "Bash", args: "npm test" },
    ]);
  });

  it("extracts result from agent_end event", () => {
    const line = JSON.stringify({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "All done." }],
        },
      ],
    });
    expect(parsePiStreamLine(line)).toEqual([
      { type: "result", result: "All done.", usage: null },
    ]);
  });

  it("extracts result from last assistant message in agent_end", () => {
    const line = JSON.stringify({
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "Do something" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "First reply" }],
        },
        { role: "user", content: [{ type: "text", text: "And more" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "Final reply" }],
        },
      ],
    });
    expect(parsePiStreamLine(line)).toEqual([
      { type: "result", result: "Final reply", usage: null },
    ]);
  });

  it("returns empty array for non-JSON lines", () => {
    expect(parsePiStreamLine("not json")).toEqual([]);
    expect(parsePiStreamLine("")).toEqual([]);
  });

  it("returns empty array for unrecognized event types", () => {
    const line = JSON.stringify({ type: "turn_start" });
    expect(parsePiStreamLine(line)).toEqual([]);
  });

  it("returns empty array for message_update without text_delta", () => {
    const line = JSON.stringify({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "thinking_delta", delta: "..." },
    });
    expect(parsePiStreamLine(line)).toEqual([]);
  });

  it("filters out non-allowlisted tool calls", () => {
    const line = JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call_456",
      toolName: "read",
      args: { path: "/some/file" },
    });
    expect(parsePiStreamLine(line)).toEqual([]);
  });

  it("handles agent_end with no assistant messages", () => {
    const line = JSON.stringify({
      type: "agent_end",
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    });
    expect(parsePiStreamLine(line)).toEqual([]);
  });

  it("concatenates multiple text blocks in agent_end assistant message", () => {
    const line = JSON.stringify({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Part 1. " },
            { type: "text", text: "Part 2." },
          ],
        },
      ],
    });
    expect(parsePiStreamLine(line)).toEqual([
      { type: "result", result: "Part 1. Part 2.", usage: null },
    ]);
  });

  it("handles malformed JSON gracefully", () => {
    expect(parsePiStreamLine("{bad json")).toEqual([]);
  });
});

describe("parseCodexStreamLine", () => {
  it("extracts text and result from item.completed agent_message", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "Hello world" },
    });
    expect(parseCodexStreamLine(line)).toEqual([
      { type: "text", text: "Hello world" },
      { type: "result", result: "Hello world", usage: null },
    ]);
  });

  it("extracts command from item.started command_execution", () => {
    const line = JSON.stringify({
      type: "item.started",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "/bin/bash -c 'npm test'",
        status: "in_progress",
      },
    });
    expect(parseCodexStreamLine(line)).toEqual([
      { type: "tool_call", name: "Bash", args: "/bin/bash -c 'npm test'" },
    ]);
  });

  it("returns empty array for turn.completed (usage not yet extracted)", () => {
    const line = JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 18133,
        cached_input_tokens: 3456,
        output_tokens: 32,
      },
    });
    expect(parseCodexStreamLine(line)).toEqual([]);
  });

  it("ignores item.completed command_execution (not agent_message)", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "echo hello",
        aggregated_output: "hello\n",
        exit_code: 0,
        status: "completed",
      },
    });
    expect(parseCodexStreamLine(line)).toEqual([]);
  });

  it("ignores thread.started events", () => {
    const line = JSON.stringify({
      type: "thread.started",
      thread_id: "019d4ab1-34f2-7c60-a71e-1fc6bee265da",
    });
    expect(parseCodexStreamLine(line)).toEqual([]);
  });

  it("returns empty array for non-JSON lines", () => {
    expect(parseCodexStreamLine("not json")).toEqual([]);
    expect(parseCodexStreamLine("")).toEqual([]);
  });

  it("handles malformed JSON gracefully", () => {
    expect(parseCodexStreamLine("{bad json")).toEqual([]);
  });

  it("returns empty array for turn.completed without usage data", () => {
    const line = JSON.stringify({ type: "turn.completed" });
    expect(parseCodexStreamLine(line)).toEqual([]);
  });
});
