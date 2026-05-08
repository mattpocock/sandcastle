import { describe, expect, it } from "vitest";
import { claudeCode, codex, copilot, opencode, pi } from "./AgentProvider.js";
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
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("claude-sonnet-4-6");
    expect(command).toContain("--output-format stream-json");
    expect(command).toContain("--print");
  });

  it("buildPrintCommand delivers prompt via stdin, not argv", () => {
    const provider = claudeCode("claude-opus-4-6");
    const { command, stdin } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("-p -");
    expect(command).not.toContain("'do something'");
    expect(stdin).toBe("do something");
  });

  it("buildPrintCommand shell-escapes the model", () => {
    const provider = claudeCode("claude-opus-4-6");
    const { command } = provider.buildPrintCommand(opts("do something"));
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
    expect(provider1.buildPrintCommand(opts("test")).command).toContain(
      "model-a",
    );
    expect(provider2.buildPrintCommand(opts("test")).command).toContain(
      "model-b",
    );
    expect(provider1.buildPrintCommand(opts("test")).command).not.toContain(
      "model-b",
    );
  });

  it("buildPrintCommand includes --effort when specified", () => {
    const provider = claudeCode("claude-opus-4-6", { effort: "high" });
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("--effort high");
  });

  it("buildPrintCommand omits --effort when not specified", () => {
    const provider = claudeCode("claude-opus-4-6");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).not.toContain("--effort");
  });

  it("buildPrintCommand omits --effort when options is empty", () => {
    const provider = claudeCode("claude-opus-4-6", {});
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).not.toContain("--effort");
  });

  it("supports all effort levels", () => {
    for (const effort of ["low", "medium", "high", "max"] as const) {
      const provider = claudeCode("claude-opus-4-6", { effort });
      expect(provider.buildPrintCommand(opts("test")).command).toContain(
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
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
    });
    expect(command).toContain("--dangerously-skip-permissions");
  });

  it("parseStreamLine emits session_id from Claude Code init line", () => {
    const provider = claudeCode("claude-opus-4-6");
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "abc-123-def",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "session_id", sessionId: "abc-123-def" },
    ]);
  });

  it("parseStreamLine ignores system events without subtype init", () => {
    const provider = claudeCode("claude-opus-4-6");
    const line = JSON.stringify({
      type: "system",
      subtype: "other",
      session_id: "abc-123-def",
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine ignores system init without session_id", () => {
    const provider = claudeCode("claude-opus-4-6");
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("buildPrintCommand includes --resume when resumeSession is set", () => {
    const provider = claudeCode("claude-opus-4-6");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
    });
    expect(command).toContain("--resume 'abc-123'");
  });

  it("buildPrintCommand omits --resume when resumeSession is not set", () => {
    const provider = claudeCode("claude-opus-4-6");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
    });
    expect(command).not.toContain("--resume");
  });

  it("buildPrintCommand omits --dangerously-skip-permissions when false", () => {
    const provider = claudeCode("claude-opus-4-6");
    const { command } = provider.buildPrintCommand({
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
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("claude-sonnet-4-6");
    expect(command).toContain("--mode json");
    expect(command).toContain("--no-session");
    expect(command).toContain("-p");
  });

  it("buildPrintCommand delivers prompt via stdin, not argv", () => {
    const provider = pi("claude-sonnet-4-6");
    const { command, stdin } = provider.buildPrintCommand(opts("it's a test"));
    expect(command).not.toContain("it's a test");
    expect(stdin).toBe("it's a test");
  });

  it("buildPrintCommand shell-escapes the model", () => {
    const provider = pi("claude-sonnet-4-6");
    const { command } = provider.buildPrintCommand(opts("do something"));
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

  it("parseStreamLine does not emit session_id for system init lines", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "abc-123",
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
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
    expect(provider1.buildPrintCommand(opts("test")).command).toContain(
      "model-a",
    );
    expect(provider2.buildPrintCommand(opts("test")).command).toContain(
      "model-b",
    );
    expect(provider1.buildPrintCommand(opts("test")).command).not.toContain(
      "model-b",
    );
  });

  it("parseStreamLine captures agent_error event with string error as result", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "agent_error",
      error: "Authentication failed: invalid API key",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "result",
        result: "Authentication failed: invalid API key",
      },
    ]);
  });

  it("parseStreamLine captures agent_error event with object error as result", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "agent_error",
      error: { message: "Rate limit exceeded", code: "rate_limit" },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "result",
        result: "Rate limit exceeded",
      },
    ]);
  });

  it("parseStreamLine captures error event with string message as result", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "error",
      message: "Internal server error",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "result",
        result: "Internal server error",
      },
    ]);
  });

  it("parseStreamLine captures error event with string error field as result", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "error",
      error: "Connection refused",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "result",
        result: "Connection refused",
      },
    ]);
  });

  it("parseStreamLine returns empty array for agent_error with no extractable message", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "agent_error",
      // no error field
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine returns empty array for error event with no extractable message", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "error",
      // no message or error field
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
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
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("gpt-5.4-mini");
    expect(command).toContain("--json");
  });

  it("buildPrintCommand delivers prompt via stdin, not argv", () => {
    const provider = codex("gpt-5.4-mini");
    const { command, stdin } = provider.buildPrintCommand(opts("it's a test"));
    expect(command).not.toContain("it's a test");
    expect(stdin).toBe("it's a test");
  });

  it("buildPrintCommand shell-escapes the model", () => {
    const provider = codex("gpt-5.4-mini");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("-m 'gpt-5.4-mini'");
  });

  it("buildPrintCommand includes model reasoning effort config when specified", () => {
    const provider = codex("gpt-5.4-mini", { effort: "high" });
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain(`-c 'model_reasoning_effort="high"'`);
  });

  it("buildPrintCommand omits model reasoning effort config when not specified", () => {
    const provider = codex("gpt-5.4-mini");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).not.toContain("model_reasoning_effort");
  });

  it("supports all codex effort levels", () => {
    for (const effort of ["low", "medium", "high", "xhigh"] as const) {
      const provider = codex("gpt-5.4-mini", { effort });
      expect(provider.buildPrintCommand(opts("test")).command).toContain(
        `model_reasoning_effort="${effort}"`,
      );
    }
  });
  it("parseStreamLine extracts text and result from item.completed agent_message", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Hello world" },
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

  it("parseStreamLine handles item.completed with missing text", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message" },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine does not extract from item.content (array form), only item.text", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        content: [{ type: "text", text: "from content array" }],
      },
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
    expect(provider1.buildPrintCommand(opts("test")).command).toContain(
      "model-a",
    );
    expect(provider2.buildPrintCommand(opts("test")).command).toContain(
      "model-b",
    );
    expect(provider1.buildPrintCommand(opts("test")).command).not.toContain(
      "model-b",
    );
  });

  // --- error event parsing tests ---

  it("parseStreamLine captures error event with nested error object as result", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "error",
      error: { type: "server_error", message: "Internal server error" },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "result", result: "Internal server error" },
    ]);
  });

  it("parseStreamLine captures error event with string error as result", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "error",
      error: "Authentication failed: invalid API key",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "result", result: "Authentication failed: invalid API key" },
    ]);
  });

  it("parseStreamLine captures error event with top-level message as result", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "error",
      message: "Rate limit exceeded",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "result", result: "Rate limit exceeded" },
    ]);
  });

  it("parseStreamLine returns empty array for error event with no extractable message", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "error",
      code: "unknown",
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
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

  it("buildPrintCommand includes the model and prompt in command (no stdin)", () => {
    const provider = opencode("opencode/big-pickle");
    const { command, stdin } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("opencode run");
    expect(command).toContain("opencode/big-pickle");
    expect(command).toContain("'do something'");
    expect(stdin).toBeUndefined();
  });

  it("buildPrintCommand does not include --format json", () => {
    const provider = opencode("opencode/big-pickle");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).not.toContain("--format json");
    expect(command).not.toContain("--format");
  });

  it("buildPrintCommand shell-escapes the prompt", () => {
    const provider = opencode("opencode/big-pickle");
    const { command } = provider.buildPrintCommand(opts("it's a test"));
    expect(command).toContain("'it'\\''s a test'");
  });

  it("buildPrintCommand shell-escapes the model", () => {
    const provider = opencode("opencode/big-pickle");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("--model 'opencode/big-pickle'");
  });

  it("buildPrintCommand includes --variant when specified", () => {
    const provider = opencode("opencode/big-pickle", { variant: "high" });
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("--variant 'high'");
  });

  it("buildPrintCommand omits --variant when not specified", () => {
    const provider = opencode("opencode/big-pickle");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).not.toContain("--variant");
  });

  it("buildPrintCommand omits --variant when options is empty", () => {
    const provider = opencode("opencode/big-pickle", {});
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).not.toContain("--variant");
  });

  it("passes through arbitrary variant values to the CLI flag", () => {
    for (const variant of ["low", "high", "max", "minimal", "custom-value"]) {
      const provider = opencode("opencode/big-pickle", { variant });
      expect(provider.buildPrintCommand(opts("test")).command).toContain(
        "--variant",
      );
    }
  });

  it("buildPrintCommand shell-escapes the variant value", () => {
    const provider = opencode("opencode/big-pickle", { variant: "it's tricky" });
    const { command } = provider.buildPrintCommand(opts("test"));
    expect(command).toContain("--variant 'it'\\''s tricky'");
  });

  it("parseStreamLine returns empty array for all input (raw passthrough)", () => {
    const provider = opencode("opencode/big-pickle");
    expect(provider.parseStreamLine("some output text")).toEqual([]);
    expect(provider.parseStreamLine("")).toEqual([]);
    expect(
      provider.parseStreamLine(JSON.stringify({ type: "text", text: "hi" })),
    ).toEqual([]);
  });

  it("parseStreamLine returns empty array for non-JSON lines", () => {
    const provider = opencode("opencode/big-pickle");
    expect(provider.parseStreamLine("not json")).toEqual([]);
  });

  it("parseStreamLine returns empty array for malformed JSON", () => {
    const provider = opencode("opencode/big-pickle");
    expect(provider.parseStreamLine("{bad json")).toEqual([]);
  });

  it("bakes model into each provider instance independently", () => {
    const provider1 = opencode("model-a");
    const provider2 = opencode("model-b");
    expect(provider1.buildPrintCommand(opts("test")).command).toContain(
      "model-a",
    );
    expect(provider2.buildPrintCommand(opts("test")).command).toContain(
      "model-b",
    );
    expect(provider1.buildPrintCommand(opts("test")).command).not.toContain(
      "model-b",
    );
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

describe("resumeSession on non-Claude providers", () => {
  it("pi ignores resumeSession in buildPrintCommand", () => {
    const provider = pi("claude-sonnet-4-6");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
    });
    expect(command).not.toContain("--resume");
    expect(command).not.toContain("abc-123");
  });

  it("codex ignores resumeSession in buildPrintCommand", () => {
    const provider = codex("gpt-5.4-mini");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
    });
    expect(command).not.toContain("--resume");
    expect(command).not.toContain("abc-123");
  });

  it("opencode ignores resumeSession in buildPrintCommand", () => {
    const provider = opencode("opencode/big-pickle");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
    });
    expect(command).not.toContain("--resume");
    expect(command).not.toContain("abc-123");
  });
});

// ---------------------------------------------------------------------------
// copilot factory
// ---------------------------------------------------------------------------

describe("copilot factory", () => {
  it("returns a provider with name 'copilot'", () => {
    const provider = copilot("claude-sonnet-4.5");
    expect(provider.name).toBe("copilot");
  });

  it("does not capture sessions by default", () => {
    const provider = copilot("claude-sonnet-4.5");
    expect(provider.captureSessions).toBe(false);
  });

  it("buildPrintCommand includes the model and -p prompt", () => {
    const provider = copilot("claude-sonnet-4.5");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("copilot -p");
    expect(command).toContain("'do something'");
    expect(command).toContain("--model 'claude-sonnet-4.5'");
    expect(command).toContain("--output-format json");
  });
  it("buildPrintCommand includes --allow-all-tools when dangerouslySkipPermissions is true", () => {
    const provider = copilot("claude-sonnet-4.5");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
    });
    expect(command).toContain("--allow-all-tools");
  });

  it("buildPrintCommand omits --allow-all-tools when dangerouslySkipPermissions is false", () => {
    const provider = copilot("claude-sonnet-4.5");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: false,
    });
    expect(command).not.toContain("--allow-all-tools");
  });

  it("buildPrintCommand shell-escapes the prompt", () => {
    const provider = copilot("claude-sonnet-4.5");
    const { command } = provider.buildPrintCommand(opts("it's a test"));
    expect(command).toContain("'it'\\''s a test'");
  });

  it("buildPrintCommand includes --effort when specified", () => {
    const provider = copilot("claude-sonnet-4.5", { effort: "high" });
    const { command } = provider.buildPrintCommand(opts("test"));
    expect(command).toContain("--effort high");
  });

  it("buildPrintCommand omits --effort when not specified", () => {
    const provider = copilot("claude-sonnet-4.5");
    const { command } = provider.buildPrintCommand(opts("test"));
    expect(command).not.toContain("--effort");
  });

  it("buildPrintCommand ignores resumeSession (resume not yet supported)", () => {
    const provider = copilot("claude-sonnet-4.5");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
    });
    expect(command).not.toContain("--resume");
    expect(command).not.toContain("abc-123");
  });

  it("buildInteractiveArgs includes copilot binary, --model, and prompt", () => {
    const provider = copilot("claude-sonnet-4.5");
    const args = provider.buildInteractiveArgs!(opts("hello"));
    expect(args[0]).toBe("copilot");
    expect(args).toContain("--model");
    expect(args).toContain("claude-sonnet-4.5");
    expect(args).toContain("hello");
  });

  it("parseStreamLine returns empty array for non-JSON and unrecognised input", () => {
    const provider = copilot("claude-sonnet-4.5");
    expect(provider.parseStreamLine("some output text")).toEqual([]);
    expect(provider.parseStreamLine("")).toEqual([]);
    expect(
      provider.parseStreamLine(JSON.stringify({ type: "text", text: "hi" })),
    ).toEqual([]);
  });

  it("parseStreamLine extracts text from assistant.message_delta event", () => {
    const provider = copilot("claude-sonnet-4.5");
    const line = JSON.stringify({
      type: "assistant.message_delta",
      data: { messageId: "m1", deltaContent: "hello" },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "text", text: "hello" },
    ]);
  });

  it("parseStreamLine extracts tool call from tool.execution_start (bash → Bash)", () => {
    const provider = copilot("claude-sonnet-4.5");
    const line = JSON.stringify({
      type: "tool.execution_start",
      data: {
        toolCallId: "t1",
        toolName: "bash",
        arguments: { command: "ls /", description: "list root" },
        turnId: "0",
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "Bash", args: "ls /" },
    ]);
  });

  it("parseStreamLine skips non-allowlisted tools (e.g. report_intent)", () => {
    const provider = copilot("claude-sonnet-4.5");
    const line = JSON.stringify({
      type: "tool.execution_start",
      data: {
        toolCallId: "t1",
        toolName: "report_intent",
        arguments: { intent: "doing things" },
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine extracts result from assistant.message content", () => {
    const provider = copilot("claude-sonnet-4.5");
    const line = JSON.stringify({
      type: "assistant.message",
      data: {
        messageId: "m1",
        content: "Final answer.",
        toolRequests: [],
        interactionId: "i1",
        turnId: "0",
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "result", result: "Final answer." },
    ]);
  });

  it("parseStreamLine ignores assistant.message with empty content", () => {
    const provider = copilot("claude-sonnet-4.5");
    const line = JSON.stringify({
      type: "assistant.message",
      data: { messageId: "m1", content: "", toolRequests: [] },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine extracts session_id from terminal result event", () => {
    const provider = copilot("claude-sonnet-4.5");
    const line = JSON.stringify({
      type: "result",
      sessionId: "08f6db99-c0af-4d97-a927-a526b205de12",
      exitCode: 0,
      usage: { premiumRequests: 1 },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "session_id",
        sessionId: "08f6db99-c0af-4d97-a927-a526b205de12",
      },
    ]);
  });

  it("parseStreamLine ignores ephemeral session/lifecycle events", () => {
    const provider = copilot("claude-sonnet-4.5");
    for (const type of [
      "session.mcp_server_status_changed",
      "session.mcp_servers_loaded",
      "session.skills_loaded",
      "session.tools_updated",
      "user.message",
      "assistant.turn_start",
      "assistant.turn_end",
      "assistant.message_start",
      "assistant.reasoning_delta",
      "assistant.reasoning",
      "tool.execution_complete",
    ]) {
      expect(
        provider.parseStreamLine(JSON.stringify({ type, data: {} })),
      ).toEqual([]);
    }
  });

  it("parseStreamLine returns empty array for malformed JSON", () => {
    const provider = copilot("claude-sonnet-4.5");
    expect(provider.parseStreamLine("{bad json")).toEqual([]);
  });

  it("parseStreamLine surfaces error events as result (string error)", () => {
    const provider = copilot("claude-sonnet-4.5");
    const line = JSON.stringify({
      type: "error",
      error: "Connection refused",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "result", result: "Connection refused" },
    ]);
  });

  it("parseStreamLine surfaces error events as result (object error)", () => {
    const provider = copilot("claude-sonnet-4.5");
    const line = JSON.stringify({
      type: "agent_error",
      error: { message: "Rate limit exceeded", code: "rate_limit" },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "result", result: "Rate limit exceeded" },
    ]);
  });

  it("parseStreamLine end-to-end: streams deltas, tool call, and final result from a captured fixture", () => {
    const provider = copilot("claude-sonnet-4.5");
    // Fixture mirrors a real `copilot --output-format json` capture: two text
    // deltas, an assistant.message that finalises the text and includes a
    // tool request, the corresponding tool.execution_start, then the
    // terminal result event with sessionId.
    const lines = [
      JSON.stringify({
        type: "session.mcp_servers_loaded",
        data: { servers: [] },
      }),
      JSON.stringify({ type: "assistant.turn_start", data: { turnId: "0" } }),
      JSON.stringify({
        type: "assistant.message_start",
        data: { messageId: "m1" },
      }),
      JSON.stringify({
        type: "assistant.message_delta",
        data: { messageId: "m1", deltaContent: "I'll run " },
      }),
      JSON.stringify({
        type: "assistant.message_delta",
        data: { messageId: "m1", deltaContent: "ls /." },
      }),
      JSON.stringify({
        type: "assistant.message",
        data: {
          messageId: "m1",
          content: "I'll run ls /.",
          toolRequests: [
            {
              toolCallId: "tc1",
              name: "bash",
              arguments: { command: "ls /" },
              type: "function",
            },
          ],
          interactionId: "i1",
          turnId: "0",
        },
      }),
      JSON.stringify({
        type: "tool.execution_start",
        data: {
          toolCallId: "tc1",
          toolName: "bash",
          arguments: { command: "ls /", description: "list root" },
          turnId: "0",
        },
      }),
      JSON.stringify({
        type: "tool.execution_complete",
        data: { toolCallId: "tc1", success: true },
      }),
      JSON.stringify({ type: "assistant.turn_end", data: { turnId: "0" } }),
      JSON.stringify({
        type: "result",
        sessionId: "sess-123",
        exitCode: 0,
        usage: {},
      }),
    ];

    const events = lines.flatMap((l) => provider.parseStreamLine(l));
    expect(events).toEqual([
      { type: "text", text: "I'll run " },
      { type: "text", text: "ls /." },
      { type: "result", result: "I'll run ls /." },
      { type: "tool_call", name: "Bash", args: "ls /" },
      { type: "session_id", sessionId: "sess-123" },
    ]);
  });

  it("accepts an env option and exposes it on the provider", () => {
    const provider = copilot("claude-sonnet-4.5", {
      env: { GITHUB_TOKEN: "ghp_test" },
    });
    expect(provider.env).toEqual({ GITHUB_TOKEN: "ghp_test" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = copilot("claude-sonnet-4.5");
    expect(provider.env).toEqual({});
  });

  it("bakes model into each provider instance independently", () => {
    const provider1 = copilot("model-a");
    const provider2 = copilot("model-b");
    expect(provider1.buildPrintCommand(opts("test")).command).toContain(
      "model-a",
    );
    expect(provider2.buildPrintCommand(opts("test")).command).toContain(
      "model-b",
    );
    expect(provider1.buildPrintCommand(opts("test")).command).not.toContain(
      "model-b",
    );
  });
});

describe("parseSessionUsage (Claude Code)", () => {
  const provider = claudeCode("claude-opus-4-6");

  it("extracts usage from the last assistant message in a JSONL string", () => {
    const content = [
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-6",
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 300,
            output_tokens: 50,
          },
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-6",
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: 9294,
            cache_read_input_tokens: 8526,
            output_tokens: 458,
          },
        },
      }),
    ].join("\n");

    expect(provider.parseSessionUsage!(content)).toEqual({
      inputTokens: 3,
      cacheCreationInputTokens: 9294,
      cacheReadInputTokens: 8526,
      outputTokens: 458,
    });
  });

  it("returns undefined for empty content", () => {
    expect(provider.parseSessionUsage!("")).toBeUndefined();
  });

  it("returns undefined for content with no assistant messages", () => {
    const content = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "abc" }),
      JSON.stringify({ type: "result", result: "done" }),
    ].join("\n");
    expect(provider.parseSessionUsage!(content)).toBeUndefined();
  });

  it("returns undefined when assistant message has no usage block", () => {
    const content = JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        content: [{ type: "text", text: "hi" }],
      },
    });
    expect(provider.parseSessionUsage!(content)).toBeUndefined();
  });

  it("returns undefined for malformed JSON lines", () => {
    const content = "not json\n{bad json\n";
    expect(provider.parseSessionUsage!(content)).toBeUndefined();
  });

  it("skips malformed lines and finds valid assistant message", () => {
    const content = [
      "not json",
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-6",
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
            output_tokens: 40,
          },
        },
      }),
    ].join("\n");

    expect(provider.parseSessionUsage!(content)).toEqual({
      inputTokens: 10,
      cacheCreationInputTokens: 20,
      cacheReadInputTokens: 30,
      outputTokens: 40,
    });
  });

  it("is not defined on pi provider", () => {
    expect(pi("model").parseSessionUsage).toBeUndefined();
  });

  it("is not defined on codex provider", () => {
    expect(codex("model").parseSessionUsage).toBeUndefined();
  });

  it("is not defined on opencode provider", () => {
    expect(opencode("model").parseSessionUsage).toBeUndefined();
  });
});

describe("captureSessions flag", () => {
  it("claudeCode defaults captureSessions to true", () => {
    expect(claudeCode("claude-opus-4-6").captureSessions).toBe(true);
  });

  it("claudeCode allows opting out of captureSessions", () => {
    expect(
      claudeCode("claude-opus-4-6", { captureSessions: false }).captureSessions,
    ).toBe(false);
  });

  it("pi has captureSessions false", () => {
    expect(pi("pi-model").captureSessions).toBe(false);
  });

  it("codex has captureSessions false", () => {
    expect(codex("codex-model").captureSessions).toBe(false);
  });

  it("opencode has captureSessions false", () => {
    expect(opencode("opencode-model").captureSessions).toBe(false);
  });
});
