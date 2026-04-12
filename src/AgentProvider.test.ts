import { describe, expect, it } from "vitest";
import { claudeCode, codex, pi } from "./AgentProvider.js";

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
    const command = provider.buildPrintCommand("do something");
    expect(command).toContain("claude-sonnet-4-6");
    expect(command).toContain("--output-format stream-json");
    expect(command).toContain("--print");
  });

  it("buildPrintCommand shell-escapes the prompt", () => {
    const provider = claudeCode("claude-opus-4-6");
    const command = provider.buildPrintCommand("it's a test");
    // Single-quoted shell escaping: ' -> '\''
    expect(command).toContain("'it'\\''s a test'");
  });

  it("buildPrintCommand shell-escapes the model", () => {
    const provider = claudeCode("claude-opus-4-6");
    const command = provider.buildPrintCommand("do something");
    expect(command).toContain("--model 'claude-opus-4-6'");
  });

  it("buildInteractiveArgs includes the binary and model", () => {
    const provider = claudeCode("claude-sonnet-4-6");
    const args = provider.buildInteractiveArgs("");
    expect(args[0]).toBe("claude");
    expect(args).toContain("claude-sonnet-4-6");
    expect(args).toContain("--model");
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
    expect(provider1.buildPrintCommand("test")).toContain("model-a");
    expect(provider2.buildPrintCommand("test")).toContain("model-b");
    expect(provider1.buildPrintCommand("test")).not.toContain("model-b");
  });

  it("buildPrintCommand includes --effort when specified", () => {
    const provider = claudeCode("claude-opus-4-6", { effort: "high" });
    const command = provider.buildPrintCommand("do something");
    expect(command).toContain("--effort high");
  });

  it("buildPrintCommand omits --effort when not specified", () => {
    const provider = claudeCode("claude-opus-4-6");
    const command = provider.buildPrintCommand("do something");
    expect(command).not.toContain("--effort");
  });

  it("buildPrintCommand omits --effort when options is empty", () => {
    const provider = claudeCode("claude-opus-4-6", {});
    const command = provider.buildPrintCommand("do something");
    expect(command).not.toContain("--effort");
  });

  it("buildInteractiveArgs includes --effort when specified", () => {
    const provider = claudeCode("claude-opus-4-6", { effort: "low" });
    const args = provider.buildInteractiveArgs("");
    expect(args).toContain("--effort");
    expect(args).toContain("low");
  });

  it("buildInteractiveArgs omits --effort when not specified", () => {
    const provider = claudeCode("claude-opus-4-6");
    const args = provider.buildInteractiveArgs("");
    expect(args).not.toContain("--effort");
  });

  it("supports all effort levels", () => {
    for (const effort of ["low", "medium", "high", "max"] as const) {
      const provider = claudeCode("claude-opus-4-6", { effort });
      expect(provider.buildPrintCommand("test")).toContain(
        `--effort ${effort}`,
      );
    }
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
    const command = provider.buildPrintCommand("do something");
    expect(command).toContain("claude-sonnet-4-6");
    expect(command).toContain("--mode json");
    expect(command).toContain("--no-session");
    expect(command).toContain("-p");
  });

  it("buildPrintCommand shell-escapes the prompt", () => {
    const provider = pi("claude-sonnet-4-6");
    const command = provider.buildPrintCommand("it's a test");
    expect(command).toContain("'it'\\''s a test'");
  });

  it("buildPrintCommand shell-escapes the model", () => {
    const provider = pi("claude-sonnet-4-6");
    const command = provider.buildPrintCommand("do something");
    expect(command).toContain("--model 'claude-sonnet-4-6'");
  });

  it("buildInteractiveArgs includes the binary and model", () => {
    const provider = pi("claude-sonnet-4-6");
    const args = provider.buildInteractiveArgs("");
    expect(args[0]).toBe("pi");
    expect(args).toContain("claude-sonnet-4-6");
    expect(args).toContain("--model");
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
    expect(provider1.buildPrintCommand("test")).toContain("model-a");
    expect(provider2.buildPrintCommand("test")).toContain("model-b");
    expect(provider1.buildPrintCommand("test")).not.toContain("model-b");
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

  it("buildPrintCommand includes model and shell-escaped prompt", () => {
    const provider = codex("gpt-5.4-mini");
    const command = provider.buildPrintCommand("it's a test");
    expect(command).toContain("-m 'gpt-5.4-mini'");
    expect(command).toContain("'it'\\''s a test'");
  });

  it("buildPrintCommandFromStdin omits the prompt arg", () => {
    const provider = codex("gpt-5.4-mini");
    expect(provider.buildPrintCommandFromStdin?.()).toBe(
      "codex exec --json --dangerously-bypass-approvals-and-sandbox -m 'gpt-5.4-mini' -",
    );
  });

  it("does not expose envManifest or dockerfileTemplate", () => {
    const provider = codex("gpt-5.4-mini");
    expect(provider).not.toHaveProperty("envManifest");
    expect(provider).not.toHaveProperty("dockerfileTemplate");
  });

  it("buildPrintCommand includes the model and --json flag", () => {
    const provider = codex("gpt-5.4-mini");
    const command = provider.buildPrintCommand("do something");
    expect(command).toContain("gpt-5.4-mini");
    expect(command).toContain("--json");
  });

  it("buildPrintCommand shell-escapes the prompt", () => {
    const provider = codex("gpt-5.4-mini");
    const command = provider.buildPrintCommand("it's a test");
    expect(command).toContain("'it'\\''s a test'");
  });

  it("buildPrintCommand shell-escapes the model", () => {
    const provider = codex("gpt-5.4-mini");
    const command = provider.buildPrintCommand("do something");
    expect(command).toContain("-m 'gpt-5.4-mini'");
  });

  it("buildInteractiveArgs includes the binary and model", () => {
    const provider = codex("gpt-5.4-mini");
    const args = provider.buildInteractiveArgs("");
    expect(args[0]).toBe("codex");
    expect(args).toContain("gpt-5.4-mini");
    expect(args).toContain("--model");
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
    expect(provider1.buildPrintCommand("test")).toContain("model-a");
    expect(provider2.buildPrintCommand("test")).toContain("model-b");
    expect(provider1.buildPrintCommand("test")).not.toContain("model-b");
  });
});
