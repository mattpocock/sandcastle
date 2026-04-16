import { describe, expect, it } from "vitest";
import { claudeCode, codex, opencode, pi } from "./AgentProvider.js";
import type { AgentCommandOptions } from "./AgentProvider.js";

/** Shorthand: build options with dangerouslySkipPermissions: true (mirrors existing sandbox callers). */
const opts = (prompt: string): AgentCommandOptions => ({
  prompt,
  dangerouslySkipPermissions: true,
});

describe("claudeCode factory", () => {
  it("returns a provider with name 'claude-code'", () => {
    const provider = claudeCode("claude-opus-4-6");
    expect(provider.name).toBe("claude-code");
  });

  it("does not expose envManifest or dockerfileTemplate", () => {
    const provider = claudeCode("claude-opus-4-6");
    expect(provider).not.toHaveProperty("envManifest");
    expect(provider).not.toHaveProperty("dockerfileTemplate");
  });

  it("buildPrintCommand includes the model", () => {
    const provider = claudeCode("claude-sonnet-4-6");
    const command = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("claude-sonnet-4-6");
    expect(command).toContain("--output-format stream-json");
    expect(command).toContain("--print");
  });

  it("buildPrintCommand shell-escapes the prompt", () => {
    const provider = claudeCode("claude-opus-4-6");
    const command = provider.buildPrintCommand(opts("it's a test"));
    // Single-quoted shell escaping: ' -> '\''
    expect(command).toContain("'it'\\''s a test'");
  });

  it("buildPrintCommand shell-escapes the model", () => {
    const provider = claudeCode("claude-opus-4-6");
    const command = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("--model 'claude-opus-4-6'");
  });

  it("parseStreamLine extracts text from assistant message", () => {
    const provider = claudeCode("claude-opus-4-6");
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello world" }] },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "text", text: "Hello world" },
    ]);
  });

  it("parseStreamLine extracts result from result message", () => {
    const provider = claudeCode("claude-opus-4-6");
    const line = JSON.stringify({
      type: "result",
      result: "Final answer <promise>COMPLETE</promise>",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "result",
        result: "Final answer <promise>COMPLETE</promise>",
      },
    ]);
  });

  it("parseStreamLine returns empty array for non-JSON lines", () => {
    const provider = claudeCode("claude-opus-4-6");
    expect(provider.parseStreamLine("not json")).toEqual([]);
    expect(provider.parseStreamLine("")).toEqual([]);
  });

  it("parseStreamLine extracts tool_use block (Bash → command arg)", () => {
    const provider = claudeCode("claude-opus-4-6");
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "npm test" } },
        ],
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "Bash", args: "npm test" },
    ]);
  });

  it("parseStreamLine bakes model into each provider instance independently", () => {
    const provider1 = claudeCode("model-a");
    const provider2 = claudeCode("model-b");
    expect(provider1.buildPrintCommand(opts("test"))).toContain("model-a");
    expect(provider2.buildPrintCommand(opts("test"))).toContain("model-b");
    expect(provider1.buildPrintCommand(opts("test"))).not.toContain("model-b");
  });

  it("buildPrintCommand includes --effort when specified", () => {
    const provider = claudeCode("claude-opus-4-6", { effort: "high" });
    const command = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("--effort high");
  });

  it("buildPrintCommand omits --effort when not specified", () => {
    const provider = claudeCode("claude-opus-4-6");
    const command = provider.buildPrintCommand(opts("do something"));
    expect(command).not.toContain("--effort");
  });

  it("buildPrintCommand omits --effort when options is empty", () => {
    const provider = claudeCode("claude-opus-4-6", {});
    const command = provider.buildPrintCommand(opts("do something"));
    expect(command).not.toContain("--effort");
  });

  it("supports all effort levels", () => {
    for (const effort of ["low", "medium", "high", "max"] as const) {
      const provider = claudeCode("claude-opus-4-6", { effort });
      expect(provider.buildPrintCommand(opts("test"))).toContain(
        `--effort ${effort}`,
      );
    }
  });

  it("accepts an env option and exposes it on the provider", () => {
    const provider = claudeCode("claude-opus-4-6", {
      env: { ANTHROPIC_API_KEY: "sk-test" },
    });
    expect(provider.env).toEqual({ ANTHROPIC_API_KEY: "sk-test" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = claudeCode("claude-opus-4-6");
    expect(provider.env).toEqual({});
  });

  // --- dangerouslySkipPermissions conditional tests ---

  it("buildPrintCommand includes --dangerously-skip-permissions when true", () => {
    const provider = claudeCode("claude-opus-4-6");
    const command = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
    });
    expect(command).toContain("--dangerously-skip-permissions");
  });

  it("buildPrintCommand omits --dangerously-skip-permissions when false", () => {
    const provider = claudeCode("claude-opus-4-6");
    const command = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: false,
    });
    expect(command).not.toContain("--dangerously-skip-permissions");
  });

  it("buildInteractiveArgs includes --dangerously-skip-permissions when true", () => {
    const provider = claudeCode("claude-opus-4-6");
    const args = provider.buildInteractiveArgs!({
      prompt: "test",
      dangerouslySkipPermissions: true,
    });
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("buildInteractiveArgs omits --dangerously-skip-permissions when false", () => {
    const provider = claudeCode("claude-opus-4-6");
    const args = provider.buildInteractiveArgs!({
      prompt: "test",
      dangerouslySkipPermissions: false,
    });
    expect(args).not.toContain("--dangerously-skip-permissions");
  });
});

// ---------------------------------------------------------------------------
// pi factory
// ---------------------------------------------------------------------------

describe("pi factory", () => {
  it("returns a provider with name 'pi'", () => {
    const provider = pi("claude-sonnet-4-6");
    expect(provider.name).toBe("pi");
  });

  it("does not expose envManifest or dockerfileTemplate", () => {
    const provider = pi("claude-sonnet-4-6");
    expect(provider).not.toHaveProperty("envManifest");
    expect(provider).not.toHaveProperty("dockerfileTemplate");
  });

  it("buildPrintCommand includes the model and pi flags", () => {
    const provider = pi("claude-sonnet-4-6");
    const command = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("claude-sonnet-4-6");
    expect(command).toContain("--mode json");
    expect(command).toContain("--no-session");
    expect(command).toContain("-p");
  });

  it("buildPrintCommand shell-escapes the prompt", () => {
    const provider = pi("claude-sonnet-4-6");
    const command = provider.buildPrintCommand(opts("it's a test"));
    expect(command).toContain("'it'\\''s a test'");
  });

  it("buildPrintCommand shell-escapes the model", () => {
    const provider = pi("claude-sonnet-4-6");
    const command = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("--model 'claude-sonnet-4-6'");
  });

  it("parseStreamLine extracts text from message_update event", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello world" },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "text", text: "Hello world" },
    ]);
  });

  it("parseStreamLine extracts tool call from tool_execution_start event", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "tool_execution_start",
      toolName: "Bash",
      args: { command: "npm test" },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "Bash", args: "npm test" },
    ]);
  });

  it("parseStreamLine skips non-allowlisted tools", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "tool_execution_start",
      toolName: "UnknownTool",
      args: { foo: "bar" },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine extracts result from agent_end event", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "Do the thing" }] },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Final answer <promise>COMPLETE</promise>",
            },
          ],
        },
      ],
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "result",
        result: "Final answer <promise>COMPLETE</promise>",
      },
    ]);
  });

  it("parseStreamLine returns empty array for non-JSON lines", () => {
    const provider = pi("claude-sonnet-4-6");
    expect(provider.parseStreamLine("not json")).toEqual([]);
    expect(provider.parseStreamLine("")).toEqual([]);
  });

  it("parseStreamLine returns empty array for unrecognized event types", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({ type: "unknown_event", data: "foo" });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine returns empty array for malformed JSON", () => {
    const provider = pi("claude-sonnet-4-6");
    expect(provider.parseStreamLine("{bad json")).toEqual([]);
  });

  it("parseStreamLine handles message_update with missing content", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({ type: "message_update" });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine handles tool_execution_start with missing fields", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "tool_execution_start",
      toolName: "Bash",
      // no args field
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("bakes model into each provider instance independently", () => {
    const provider1 = pi("model-a");
    const provider2 = pi("model-b");
    expect(provider1.buildPrintCommand(opts("test"))).toContain("model-a");
    expect(provider2.buildPrintCommand(opts("test"))).toContain("model-b");
    expect(provider1.buildPrintCommand(opts("test"))).not.toContain("model-b");
  });

  it("accepts an env option and exposes it on the provider", () => {
    const provider = pi("claude-sonnet-4-6", { env: { PI_KEY: "abc" } });
    expect(provider.env).toEqual({ PI_KEY: "abc" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = pi("claude-sonnet-4-6");
    expect(provider.env).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// codex factory
// ---------------------------------------------------------------------------

describe("codex factory", () => {
  it("returns a provider with name 'codex'", () => {
    const provider = codex("gpt-5.4-mini");
    expect(provider.name).toBe("codex");
  });

  it("does not expose envManifest or dockerfileTemplate", () => {
    const provider = codex("gpt-5.4-mini");
    expect(provider).not.toHaveProperty("envManifest");
    expect(provider).not.toHaveProperty("dockerfileTemplate");
  });

  it("buildPrintCommand includes the model and --json flag", () => {
    const provider = codex("gpt-5.4-mini");
    const command = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("gpt-5.4-mini");
    expect(command).toContain("--json");
  });

  it("buildPrintCommand shell-escapes the prompt", () => {
    const provider = codex("gpt-5.4-mini");
    const command = provider.buildPrintCommand(opts("it's a test"));
    expect(command).toContain("'it'\\''s a test'");
  });

  it("buildPrintCommand shell-escapes the model", () => {
    const provider = codex("gpt-5.4-mini");
    const command = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("-m 'gpt-5.4-mini'");
  });

  it("buildPrintCommand includes model reasoning effort config when specified", () => {
    const provider = codex("gpt-5.4-mini", { effort: "high" });
    const command = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain(`-c 'model_reasoning_effort="high"'`);
  });

  it("buildPrintCommand omits model reasoning effort config when not specified", () => {
    const provider = codex("gpt-5.4-mini");
    const command = provider.buildPrintCommand(opts("do something"));
    expect(command).not.toContain("model_reasoning_effort");
  });

  it("supports all codex effort levels", () => {
    for (const effort of ["low", "medium", "high", "xhigh"] as const) {
      const provider = codex("gpt-5.4-mini", { effort });
      expect(provider.buildPrintCommand(opts("test"))).toContain(
        `model_reasoning_effort="${effort}"`,
      );
    }
  });
  it("parseStreamLine extracts text and result from item.completed agent_message", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", content: "Hello world" },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "text", text: "Hello world" },
      { type: "result", result: "Hello world" },
    ]);
  });

  it("parseStreamLine extracts tool call from item.started command_execution", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "item.started",
      item: { type: "command_execution", command: "npm test" },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "Bash", args: "npm test" },
    ]);
  });

  it("parseStreamLine skips turn.completed events", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({ type: "turn.completed" });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine returns empty array for non-JSON lines", () => {
    const provider = codex("gpt-5.4-mini");
    expect(provider.parseStreamLine("not json")).toEqual([]);
    expect(provider.parseStreamLine("")).toEqual([]);
  });

  it("parseStreamLine returns empty array for unrecognized event types", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({ type: "unknown_event", data: "foo" });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine returns empty array for malformed JSON", () => {
    const provider = codex("gpt-5.4-mini");
    expect(provider.parseStreamLine("{bad json")).toEqual([]);
  });

  it("parseStreamLine handles item.completed with missing content", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message" },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine handles item.started with missing command", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "item.started",
      item: { type: "command_execution" },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine handles item.completed with non-agent_message type", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "other_type", content: "foo" },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine handles item.started with non-command_execution type", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "item.started",
      item: { type: "other_type", command: "foo" },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("bakes model into each provider instance independently", () => {
    const provider1 = codex("model-a");
    const provider2 = codex("model-b");
    expect(provider1.buildPrintCommand(opts("test"))).toContain("model-a");
    expect(provider2.buildPrintCommand(opts("test"))).toContain("model-b");
    expect(provider1.buildPrintCommand(opts("test"))).not.toContain("model-b");
  });

  it("accepts an env option and exposes it on the provider", () => {
    const provider = codex("gpt-5.4-mini", { env: { OPENAI_KEY: "xyz" } });
    expect(provider.env).toEqual({ OPENAI_KEY: "xyz" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = codex("gpt-5.4-mini");
    expect(provider.env).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// opencode factory
// ---------------------------------------------------------------------------

describe("opencode factory", () => {
  it("returns a provider with name 'opencode'", () => {
    const provider = opencode("opencode/big-pickle");
    expect(provider.name).toBe("opencode");
  });

  it("does not expose envManifest or dockerfileTemplate", () => {
    const provider = opencode("opencode/big-pickle");
    expect(provider).not.toHaveProperty("envManifest");
    expect(provider).not.toHaveProperty("dockerfileTemplate");
  });

  it("buildPrintCommand includes the model and prompt", () => {
    const provider = opencode("opencode/big-pickle");
    const command = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("opencode run");
    expect(command).toContain("opencode/big-pickle");
  });

  it("buildPrintCommand includes --format json", () => {
    const provider = opencode("opencode/big-pickle");
    const command = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("--format json");
  });

  it("buildPrintCommand includes --dangerously-skip-permissions when true", () => {
    const provider = opencode("opencode/big-pickle");
    const command = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
    });
    expect(command).toContain("--dangerously-skip-permissions");
  });

  it("buildPrintCommand omits --dangerously-skip-permissions when false", () => {
    const provider = opencode("opencode/big-pickle");
    const command = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: false,
    });
    expect(command).not.toContain("--dangerously-skip-permissions");
  });

  it("buildPrintCommand shell-escapes the prompt", () => {
    const provider = opencode("opencode/big-pickle");
    const command = provider.buildPrintCommand(opts("it's a test"));
    expect(command).toContain("'it'\\''s a test'");
  });

  it("buildPrintCommand shell-escapes the model", () => {
    const provider = opencode("opencode/big-pickle");
    const command = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("--model 'opencode/big-pickle'");
  });

  it("parseStreamLine extracts text from text event", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({
      type: "text",
      part: { type: "text", text: "Hello world" },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "text", text: "Hello world" },
    ]);
  });

  it("parseStreamLine extracts tool call from tool_use event (bash → command)", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "npm test", description: "Run tests" },
        },
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "bash", args: "npm test" },
    ]);
  });

  it("parseStreamLine extracts tool call for read tool (filePath)", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: "/tmp/test.ts" },
        },
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "read", args: "/tmp/test.ts" },
    ]);
  });

  it("parseStreamLine extracts tool call for write tool (filePath)", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "write",
        state: {
          status: "completed",
          input: { filePath: "/tmp/output.ts" },
        },
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "write", args: "/tmp/output.ts" },
    ]);
  });

  it("parseStreamLine extracts tool call for glob tool (pattern)", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "glob",
        state: {
          status: "completed",
          input: { pattern: "**/*.ts" },
        },
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "glob", args: "**/*.ts" },
    ]);
  });

  it("parseStreamLine extracts tool call for grep tool (pattern)", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "grep",
        state: {
          status: "completed",
          input: { pattern: "TODO" },
        },
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "grep", args: "TODO" },
    ]);
  });

  it("parseStreamLine skips non-allowlisted tools", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "unknown_tool",
        state: {
          status: "completed",
          input: { foo: "bar" },
        },
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine skips step_finish events (output collected via stdout)", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({
      type: "step_finish",
      part: { reason: "stop", messageID: "msg_123" },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine skips step_finish with tool-calls reason", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({
      type: "step_finish",
      part: { reason: "tool-calls", messageID: "msg_123" },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine skips step_start events", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({
      type: "step_start",
      part: { type: "step-start" },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine returns empty array for non-JSON lines", () => {
    const provider = opencode("opencode/big-pickle");
    expect(provider.parseStreamLine("some output text")).toEqual([]);
    expect(provider.parseStreamLine("")).toEqual([]);
  });

  it("parseStreamLine returns empty array for malformed JSON", () => {
    const provider = opencode("opencode/big-pickle");
    expect(provider.parseStreamLine("{bad json")).toEqual([]);
  });

  it("parseStreamLine handles text event with missing text field", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({
      type: "text",
      part: { type: "text" },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine handles tool_use event with missing state", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({
      type: "tool_use",
      part: { type: "tool", tool: "bash" },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine handles tool_use event with missing tool name", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({
      type: "tool_use",
      part: { type: "tool" },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("bakes model into each provider instance independently", () => {
    const provider1 = opencode("model-a");
    const provider2 = opencode("model-b");
    expect(provider1.buildPrintCommand(opts("test"))).toContain("model-a");
    expect(provider2.buildPrintCommand(opts("test"))).toContain("model-b");
    expect(provider1.buildPrintCommand(opts("test"))).not.toContain("model-b");
  });

  it("accepts an env option and exposes it on the provider", () => {
    const provider = opencode("opencode/big-pickle", {
      env: { OPENCODE_API_KEY: "sk-test" },
    });
    expect(provider.env).toEqual({ OPENCODE_API_KEY: "sk-test" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = opencode("opencode/big-pickle");
    expect(provider.env).toEqual({});
  });
});
