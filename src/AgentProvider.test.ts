import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeCode,
  codex,
  copilot,
  cursor,
  opencode,
  pi,
} from "./AgentProvider.js";
import type { AgentCommandOptions } from "./AgentProvider.js";
import type { BindMountSandboxHandle } from "./SandboxProvider.js";

/** Shorthand: build options with dangerouslySkipPermissions: true (mirrors existing sandbox callers). */
const opts = (prompt: string): AgentCommandOptions => ({
  prompt,
  dangerouslySkipPermissions: true,
});

describe("claudeCode factory", () => {
  it("returns a provider with name 'claude-code'", () => {
    const provider = claudeCode("claude-opus-4-7");
    expect(provider.name).toBe("claude-code");
  });

  it("does not expose envManifest or dockerfileTemplate", () => {
    const provider = claudeCode("claude-opus-4-7");
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
    const provider = claudeCode("claude-opus-4-7");
    const { command, stdin } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("-p -");
    expect(command).not.toContain("'do something'");
    expect(stdin).toBe("do something");
  });

  it("buildPrintCommand shell-escapes the model", () => {
    const provider = claudeCode("claude-opus-4-7");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("--model 'claude-opus-4-7'");
  });

  it("parseStreamLine extracts text from assistant message", () => {
    const provider = claudeCode("claude-opus-4-7");
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello world" }] },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "text", text: "Hello world" },
    ]);
  });

  it("parseStreamLine extracts result from result message", () => {
    const provider = claudeCode("claude-opus-4-7");
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
    const provider = claudeCode("claude-opus-4-7");
    expect(provider.parseStreamLine("not json")).toEqual([]);
    expect(provider.parseStreamLine("")).toEqual([]);
  });

  it("parseStreamLine extracts tool_use block (Bash → command arg)", () => {
    const provider = claudeCode("claude-opus-4-7");
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
    const provider = claudeCode("claude-opus-4-7", { effort: "high" });
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("--effort high");
  });

  it("buildPrintCommand omits --effort when not specified", () => {
    const provider = claudeCode("claude-opus-4-7");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).not.toContain("--effort");
  });

  it("buildPrintCommand omits --effort when options is empty", () => {
    const provider = claudeCode("claude-opus-4-7", {});
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).not.toContain("--effort");
  });

  it("supports all effort levels", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const provider = claudeCode("claude-opus-4-7", { effort });
      expect(provider.buildPrintCommand(opts("test")).command).toContain(
        `--effort ${effort}`,
      );
    }
  });

  it("accepts an env option and exposes it on the provider", () => {
    const provider = claudeCode("claude-opus-4-7", {
      env: { ANTHROPIC_API_KEY: "sk-test" },
    });
    expect(provider.env).toEqual({ ANTHROPIC_API_KEY: "sk-test" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = claudeCode("claude-opus-4-7");
    expect(provider.env).toEqual({});
  });

  // --- dangerouslySkipPermissions conditional tests ---

  it("buildPrintCommand includes --dangerously-skip-permissions when true", () => {
    const provider = claudeCode("claude-opus-4-7");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
    });
    expect(command).toContain("--dangerously-skip-permissions");
  });

  it("parseStreamLine emits session_id from Claude Code init line", () => {
    const provider = claudeCode("claude-opus-4-7");
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
    const provider = claudeCode("claude-opus-4-7");
    const line = JSON.stringify({
      type: "system",
      subtype: "other",
      session_id: "abc-123-def",
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine ignores system init without session_id", () => {
    const provider = claudeCode("claude-opus-4-7");
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("buildPrintCommand includes --resume when resumeSession is set", () => {
    const provider = claudeCode("claude-opus-4-7");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
    });
    expect(command).toContain("--resume 'abc-123'");
  });

  it("buildPrintCommand omits --resume when resumeSession is not set", () => {
    const provider = claudeCode("claude-opus-4-7");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
    });
    expect(command).not.toContain("--resume");
  });

  it("buildPrintCommand appends --fork-session when resumeSession + forkSession are set", () => {
    const provider = claudeCode("claude-opus-4-7");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
      forkSession: true,
    });
    expect(command).toContain("--resume 'abc-123'");
    expect(command).toContain("--fork-session");
  });

  it("buildPrintCommand omits --fork-session when forkSession is set without resumeSession", () => {
    // RunOptions validation rejects this combination, but buildPrintCommand
    // is permissive and should simply not emit a meaningless flag.
    const provider = claudeCode("claude-opus-4-7");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
      forkSession: true,
    });
    expect(command).not.toContain("--fork-session");
    expect(command).not.toContain("--resume");
  });

  it("buildPrintCommand omits --fork-session when forkSession is false", () => {
    const provider = claudeCode("claude-opus-4-7");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
      forkSession: false,
    });
    expect(command).toContain("--resume 'abc-123'");
    expect(command).not.toContain("--fork-session");
  });

  it("buildPrintCommand omits --dangerously-skip-permissions when false", () => {
    const provider = claudeCode("claude-opus-4-7");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: false,
    });
    expect(command).not.toContain("--dangerously-skip-permissions");
  });

  it("buildInteractiveArgs includes --dangerously-skip-permissions when true", () => {
    const provider = claudeCode("claude-opus-4-7");
    const args = provider.buildInteractiveArgs!({
      prompt: "test",
      dangerouslySkipPermissions: true,
    });
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("buildInteractiveArgs omits --dangerously-skip-permissions when false", () => {
    const provider = claudeCode("claude-opus-4-7");
    const args = provider.buildInteractiveArgs!({
      prompt: "test",
      dangerouslySkipPermissions: false,
    });
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  // --- permissionMode option ---

  it("buildPrintCommand emits --permission-mode when permissionMode is set", () => {
    const provider = claudeCode("claude-opus-4-7", { permissionMode: "auto" });
    const { command } = provider.buildPrintCommand(opts("test"));
    expect(command).toContain("--permission-mode auto");
  });

  it("buildPrintCommand omits --dangerously-skip-permissions when permissionMode is set", () => {
    // Sandcastle's AFK call sites pass dangerouslySkipPermissions: true. When the
    // user opts into a specific permission mode on the provider, that mode takes
    // precedence over the default bypass — they are mutually exclusive on claude's CLI.
    const provider = claudeCode("claude-opus-4-7", { permissionMode: "auto" });
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
    });
    expect(command).not.toContain("--dangerously-skip-permissions");
  });

  it("buildPrintCommand omits --permission-mode when permissionMode is not set", () => {
    const provider = claudeCode("claude-opus-4-7");
    const { command } = provider.buildPrintCommand(opts("test"));
    expect(command).not.toContain("--permission-mode");
  });

  it("buildInteractiveArgs emits --permission-mode when permissionMode is set", () => {
    const provider = claudeCode("claude-opus-4-7", { permissionMode: "plan" });
    const args = provider.buildInteractiveArgs!({
      prompt: "test",
      dangerouslySkipPermissions: false,
    });
    expect(args).toContain("--permission-mode");
    expect(args).toContain("plan");
  });

  it("buildInteractiveArgs omits --dangerously-skip-permissions when permissionMode is set", () => {
    const provider = claudeCode("claude-opus-4-7", { permissionMode: "auto" });
    const args = provider.buildInteractiveArgs!({
      prompt: "test",
      dangerouslySkipPermissions: true,
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
    expect(command).toContain("-p");
    // Pi persists print-mode sessions by default so resume works; --no-session
    // is no longer emitted.
    expect(command).not.toContain("--no-session");
  });

  it("buildPrintCommand omits --session when resumeSession is not set", () => {
    const provider = pi("claude-sonnet-4-6");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).not.toContain("--session");
  });

  it("buildPrintCommand appends --session when resumeSession is set", () => {
    const provider = pi("claude-sonnet-4-6", { thinking: "high" });
    const { command, stdin } = provider.buildPrintCommand({
      prompt: "continue",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
    });
    expect(command).toContain("--session 'abc-123'");
    expect(command).toContain("--mode json");
    expect(command).toContain("--model 'claude-sonnet-4-6'");
    expect(command).toContain("--thinking high");
    expect(stdin).toBe("continue");
  });

  it("buildPrintCommand shell-escapes the resume session id", () => {
    const provider = pi("claude-sonnet-4-6");
    const { command } = provider.buildPrintCommand({
      prompt: "go",
      dangerouslySkipPermissions: true,
      resumeSession: "it's a session",
    });
    expect(command).toContain("--session 'it'\\''s a session'");
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

  it("parseStreamLine extracts session id from session header line", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "session",
      version: 3,
      id: "9ba1c695-2222-4444-8888-e7e847bf34dd",
      timestamp: "2026-05-29T08:00:00Z",
      cwd: "/sandbox/repo",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "session_id",
        sessionId: "9ba1c695-2222-4444-8888-e7e847bf34dd",
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

  it("buildPrintCommand includes --thinking when specified", () => {
    const provider = pi("claude-sonnet-4-6", { thinking: "high" });
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("--thinking high");
  });

  it("buildPrintCommand omits --thinking when not specified", () => {
    const provider = pi("claude-sonnet-4-6");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).not.toContain("--thinking");
  });

  it("buildPrintCommand omits --thinking when options is empty", () => {
    const provider = pi("claude-sonnet-4-6", {});
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).not.toContain("--thinking");
  });

  it("supports all thinking levels", () => {
    for (const thinking of [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ] as const) {
      const provider = pi("claude-sonnet-4-6", { thinking });
      expect(provider.buildPrintCommand(opts("test")).command).toContain(
        `--thinking ${thinking}`,
      );
    }
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

  it("buildPrintCommand resumes with stdin prompt when resumeSession is set", () => {
    const provider = codex("gpt-5.4-mini", { effort: "high" });
    const { command, stdin } = provider.buildPrintCommand({
      prompt: "continue",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
    });
    expect(command).toContain("codex exec resume 'abc-123'");
    expect(command).toContain("--json");
    expect(command).toContain("-m 'gpt-5.4-mini'");
    expect(command).toContain(`-c 'model_reasoning_effort="high"'`);
    expect(command.endsWith(" -")).toBe(true);
    expect(stdin).toBe("continue");
  });

  it("buildPrintCommand uses `codex exec fork` when resumeSession + forkSession are set", () => {
    const provider = codex("gpt-5.4-mini", { effort: "high" });
    const { command, stdin } = provider.buildPrintCommand({
      prompt: "branch off",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
      forkSession: true,
    });
    expect(command).toContain("codex exec fork 'abc-123'");
    expect(command).not.toContain("codex exec resume");
    expect(command).toContain("--json");
    expect(command).toContain("-m 'gpt-5.4-mini'");
    expect(command.endsWith(" -")).toBe(true);
    expect(stdin).toBe("branch off");
  });

  it("buildPrintCommand stays on `codex exec resume` when forkSession is false", () => {
    const provider = codex("gpt-5.4-mini");
    const { command } = provider.buildPrintCommand({
      prompt: "continue",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
      forkSession: false,
    });
    expect(command).toContain("codex exec resume 'abc-123'");
    expect(command).not.toContain("codex exec fork");
  });

  it("buildPrintCommand ignores forkSession without resumeSession", () => {
    const provider = codex("gpt-5.4-mini");
    const { command } = provider.buildPrintCommand({
      prompt: "fresh start",
      dangerouslySkipPermissions: true,
      forkSession: true,
    });
    expect(command).toContain("codex exec --json");
    expect(command).not.toContain("codex exec fork");
    expect(command).not.toContain("codex exec resume");
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

  // --- approvalsReviewer option ---

  it("buildPrintCommand sets approvals_reviewer config when approvalsReviewer is 'auto_review'", () => {
    const provider = codex("gpt-5.4-mini", {
      approvalsReviewer: "auto_review",
    });
    const { command } = provider.buildPrintCommand(opts("test"));
    expect(command).toContain(`-c 'approvals_reviewer="auto_review"'`);
  });

  it("buildPrintCommand drops --dangerously-bypass-approvals-and-sandbox when approvalsReviewer is 'auto_review'", () => {
    // auto_review only applies to interactive approvals — the bypass flag would
    // silence them entirely, defeating the reviewer agent.
    const provider = codex("gpt-5.4-mini", {
      approvalsReviewer: "auto_review",
    });
    const { command } = provider.buildPrintCommand(opts("test"));
    expect(command).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("buildPrintCommand emits -a on-request and -s danger-full-access when approvalsReviewer is 'auto_review'", () => {
    // Approvals must be interactive for the reviewer to have anything to evaluate;
    // codex's own filesystem sandbox is disabled because the safety boundary is the reviewer.
    const provider = codex("gpt-5.4-mini", {
      approvalsReviewer: "auto_review",
    });
    const { command } = provider.buildPrintCommand(opts("test"));
    expect(command).toContain("-a on-request");
    expect(command).toContain("-s danger-full-access");
  });

  it("buildPrintCommand keeps --dangerously-bypass-approvals-and-sandbox when approvalsReviewer is unset", () => {
    const provider = codex("gpt-5.4-mini");
    const { command } = provider.buildPrintCommand(opts("test"));
    expect(command).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("buildPrintCommand omits approvals_reviewer config when approvalsReviewer is unset", () => {
    const provider = codex("gpt-5.4-mini");
    const { command } = provider.buildPrintCommand(opts("test"));
    expect(command).not.toContain("approvals_reviewer");
  });

  it("parseStreamLine extracts session id from thread.started", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "thread.started",
      thread_id: "9ba1c695-2222-4444-8888-e7e847bf34dd",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "session_id",
        sessionId: "9ba1c695-2222-4444-8888-e7e847bf34dd",
      },
    ]);
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

  it("parseStreamLine skips turn.completed events without usage", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({ type: "turn.completed" });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine extracts usage from turn.completed", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 8497,
        cached_input_tokens: 8448,
        output_tokens: 51,
      },
    });
    // OpenAI semantics: input_tokens is the total prompt count and
    // cached_input_tokens is a subset already included. Map cached tokens to
    // cache-read and the remainder to input so the context-window display does
    // not double-count them.
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "usage",
        usage: {
          inputTokens: 49,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 8448,
          outputTokens: 51,
        },
      },
    ]);
  });

  it("parseStreamLine skips turn.completed with malformed usage", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: "lots", output_tokens: 51 },
    });
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
// cursor factory
// ---------------------------------------------------------------------------

describe("cursor factory", () => {
  it("returns a provider with name 'cursor'", () => {
    const provider = cursor("claude-sonnet-4-6");
    expect(provider.name).toBe("cursor");
  });

  it("does not expose envManifest or dockerfileTemplate", () => {
    const provider = cursor("claude-sonnet-4-6");
    expect(provider).not.toHaveProperty("envManifest");
    expect(provider).not.toHaveProperty("dockerfileTemplate");
  });

  it("buildPrintCommand includes stream-json flags and model", () => {
    const provider = cursor("claude-sonnet-4-6");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("--print");
    expect(command).toContain("--output-format stream-json");
    expect(command).toContain("--force");
    expect(command).toContain("--model 'claude-sonnet-4-6'");
  });

  it("buildPrintCommand passes prompt as a positional shell-escaped argument", () => {
    const provider = cursor("claude-sonnet-4-6");
    const { command, stdin } = provider.buildPrintCommand(opts("it's a test"));
    expect(command.endsWith("'it'\\''s a test'")).toBe(true);
    expect(command).not.toContain(" -p ");
    expect(stdin).toBeUndefined();
  });

  it("buildPrintCommand rejects prompts larger than the argv-safe limit", () => {
    const provider = cursor("claude-sonnet-4-6");
    const huge = "x".repeat(120 * 1024 + 1);
    expect(() => provider.buildPrintCommand(opts(huge))).toThrow(
      /Cursor print-mode prompt/,
    );
  });

  it("buildInteractiveArgs includes binary, model and prompt", () => {
    const provider = cursor("claude-sonnet-4-6");
    const args = provider.buildInteractiveArgs!({
      prompt: "test prompt",
      dangerouslySkipPermissions: true,
    });
    expect(args).toEqual([
      "agent",
      "--model",
      "claude-sonnet-4-6",
      "--force",
      "test prompt",
    ]);
  });

  it("buildInteractiveArgs omits prompt when empty", () => {
    const provider = cursor("claude-sonnet-4-6");
    const args = provider.buildInteractiveArgs!({
      prompt: "",
      dangerouslySkipPermissions: true,
    });
    expect(args).toEqual(["agent", "--model", "claude-sonnet-4-6", "--force"]);
  });

  // Orchestrator.invokeAgent always passes dangerouslySkipPermissions: true in print mode;
  // this branch is still used by interactive mode and direct provider.buildPrintCommand callers.
  it("buildPrintCommand does not include --force when dangerouslySkipPermissions is false", () => {
    const provider = cursor("claude-sonnet-4-6");
    const { command } = provider.buildPrintCommand({
      prompt: "do something",
      dangerouslySkipPermissions: false,
    });
    expect(command).not.toContain("--force");
  });

  it("parseStreamLine extracts text from assistant message", () => {
    const provider = cursor("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello from Cursor" }] },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "text", text: "Hello from Cursor" },
    ]);
  });

  it("parseStreamLine extracts tool_use block (Bash → command arg)", () => {
    const provider = cursor("claude-sonnet-4-6");
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

  it("parseStreamLine extracts top-level tool_call readToolCall (Cursor stream-json)", () => {
    const provider = cursor("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "tool_call",
      subtype: "started",
      call_id: "toolu_vrtx_01",
      tool_call: {
        readToolCall: { args: { path: "README.md" } },
      },
      session_id: "c6b62c6f-7ead-4fd6-9922-e952131177ff",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "Read", args: "README.md" },
    ]);
  });

  it("parseStreamLine extracts top-level tool_call writeToolCall (Cursor stream-json)", () => {
    const provider = cursor("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "tool_call",
      subtype: "started",
      call_id: "toolu_vrtx_02",
      tool_call: {
        writeToolCall: { args: { path: "src/index.ts" } },
      },
      session_id: "c6b62c6f-7ead-4fd6-9922-e952131177ff",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "Write", args: "src/index.ts" },
    ]);
  });

  it("parseStreamLine ignores tool_call completed events", () => {
    const provider = cursor("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "tool_call",
      subtype: "completed",
      call_id: "toolu_vrtx_01",
      tool_call: {
        readToolCall: {
          args: { path: "README.md" },
          result: { success: { content: "hello" } },
        },
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine extracts result event", () => {
    const provider = cursor("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "result",
      result: "Done <promise>COMPLETE</promise>",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "result", result: "Done <promise>COMPLETE</promise>" },
    ]);
  });

  it("accepts an env option and exposes it on the provider", () => {
    const provider = cursor("claude-sonnet-4-6", {
      env: { CURSOR_API_KEY: "cursor-key" },
    });
    expect(provider.env).toEqual({ CURSOR_API_KEY: "cursor-key" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = cursor("claude-sonnet-4-6");
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

  it("buildPrintCommand includes --format json so the parser receives JSON events", () => {
    const provider = opencode("opencode/big-pickle");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("--format json");
  });

  it("buildPrintCommand includes --dangerously-skip-permissions when requested", () => {
    const provider = opencode("opencode/big-pickle");
    const { command } = provider.buildPrintCommand({
      prompt: "do something",
      dangerouslySkipPermissions: true,
    });
    expect(command).toContain("--dangerously-skip-permissions");
  });

  it("buildPrintCommand omits --dangerously-skip-permissions when not requested", () => {
    const provider = opencode("opencode/big-pickle");
    const { command } = provider.buildPrintCommand({
      prompt: "do something",
      dangerouslySkipPermissions: false,
    });
    expect(command).not.toContain("--dangerously-skip-permissions");
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
    const provider = opencode("opencode/big-pickle", {
      variant: "it's tricky",
    });
    const { command } = provider.buildPrintCommand(opts("test"));
    expect(command).toContain("--variant 'it'\\''s tricky'");
  });

  it("buildPrintCommand includes --agent when specified", () => {
    const provider = opencode("opencode/big-pickle", { agent: "build" });
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("--agent 'build'");
  });

  it("buildPrintCommand omits --agent when not specified", () => {
    const provider = opencode("opencode/big-pickle");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).not.toContain("--agent");
  });

  it("buildPrintCommand omits --agent when options is empty", () => {
    const provider = opencode("opencode/big-pickle", {});
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).not.toContain("--agent");
  });

  it("passes through arbitrary agent values to the CLI flag", () => {
    for (const agent of ["build", "plan", "general", "custom-agent"]) {
      const provider = opencode("opencode/big-pickle", { agent });
      expect(provider.buildPrintCommand(opts("test")).command).toContain(
        "--agent",
      );
    }
  });

  it("buildPrintCommand shell-escapes the agent value", () => {
    const provider = opencode("opencode/big-pickle", {
      agent: "it's tricky",
    });
    const { command } = provider.buildPrintCommand(opts("test"));
    expect(command).toContain("--agent 'it'\\''s tricky'");
  });

  it("buildInteractiveArgs includes --agent when specified", () => {
    const provider = opencode("opencode/big-pickle", { agent: "build" });
    const args = provider.buildInteractiveArgs!(opts("do something"));
    expect(args).toEqual([
      "opencode",
      "--model",
      "opencode/big-pickle",
      "--agent",
      "build",
      "--prompt",
      "do something",
    ]);
  });

  it("buildInteractiveArgs omits --agent when not specified", () => {
    const provider = opencode("opencode/big-pickle");
    const args = provider.buildInteractiveArgs!(opts("do something"));
    expect(args).not.toContain("--agent");
  });

  it("parseStreamLine extracts session id from step_start", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({
      type: "step_start",
      sessionID: "ses_19cb8236effe4lu1aSmQyzbeP2",
      part: {
        type: "step-start",
        sessionID: "ses_19cb8236effe4lu1aSmQyzbeP2",
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "session_id", sessionId: "ses_19cb8236effe4lu1aSmQyzbeP2" },
    ]);
  });

  it("parseStreamLine extracts text and result from a text event", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({
      type: "text",
      sessionID: "ses_abc",
      part: { type: "text", text: "Hello world <promise>COMPLETE</promise>" },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "text", text: "Hello world <promise>COMPLETE</promise>" },
      { type: "result", result: "Hello world <promise>COMPLETE</promise>" },
    ]);
  });

  it("parseStreamLine extracts tool call from tool_use (bash → command)", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({
      type: "tool_use",
      sessionID: "ses_abc",
      part: {
        type: "tool",
        tool: "bash",
        callID: "call_00",
        state: { status: "completed", input: { command: "npm test" } },
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "bash", args: "npm test" },
    ]);
  });

  it("parseStreamLine extracts tool call from tool_use (webfetch → url)", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({
      type: "tool_use",
      sessionID: "ses_abc",
      part: {
        type: "tool",
        tool: "webfetch",
        state: { status: "completed", input: { url: "https://example.com" } },
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "webfetch", args: "https://example.com" },
    ]);
  });

  it("parseStreamLine extracts tool call from tool_use (task → description)", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({
      type: "tool_use",
      sessionID: "ses_abc",
      part: {
        type: "tool",
        tool: "task",
        state: {
          status: "completed",
          input: { description: "Explore the repo" },
        },
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "task", args: "Explore the repo" },
    ]);
  });

  it("parseStreamLine falls back to JSON.stringify(input) for read (not specially mapped)", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({
      type: "tool_use",
      sessionID: "ses_abc",
      part: {
        type: "tool",
        tool: "read",
        state: { status: "completed", input: { filePath: "/some/file" } },
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "read", args: '{"filePath":"/some/file"}' },
    ]);
  });

  it("parseStreamLine falls back to JSON.stringify(input) for grep (not specially mapped)", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({
      type: "tool_use",
      sessionID: "ses_abc",
      part: {
        type: "tool",
        tool: "grep",
        state: { status: "completed", input: { pattern: "TODO" } },
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "grep", args: '{"pattern":"TODO"}' },
    ]);
  });

  it("parseStreamLine falls back to JSON.stringify(input) for unknown tools", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({
      type: "tool_use",
      sessionID: "ses_abc",
      part: {
        type: "tool",
        tool: "mystery",
        state: { status: "completed", input: { foo: "bar" } },
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "mystery", args: '{"foo":"bar"}' },
    ]);
  });

  it("parseStreamLine falls back to JSON.stringify(input) when the known arg field is absent", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({
      type: "tool_use",
      sessionID: "ses_abc",
      part: {
        type: "tool",
        tool: "bash",
        state: { status: "completed", input: { description: "no command" } },
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "bash", args: '{"description":"no command"}' },
    ]);
  });

  it("parseStreamLine skips tool_use with a missing tool name", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({
      type: "tool_use",
      sessionID: "ses_abc",
      part: {
        type: "tool",
        state: { status: "completed", input: { command: "npm test" } },
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine skips tool_use that has not completed", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({
      type: "tool_use",
      sessionID: "ses_abc",
      part: {
        type: "tool",
        tool: "bash",
        state: { status: "running", input: { command: "npm test" } },
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine extracts error message from an error event", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({
      type: "error",
      error: {
        name: "ProviderAuthError",
        data: { message: "Invalid API key" },
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "result", result: "Invalid API key" },
    ]);
  });

  it("parseStreamLine skips step_finish events", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({
      type: "step_finish",
      sessionID: "ses_abc",
      part: { type: "step-finish", tokens: { total: 100 } },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine returns empty array for unrecognized event types", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({ type: "unknown_event", data: "foo" });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine returns empty array for non-JSON lines", () => {
    const provider = opencode("opencode/big-pickle");
    expect(provider.parseStreamLine("not json")).toEqual([]);
    expect(provider.parseStreamLine("")).toEqual([]);
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
  it("pi uses resumeSession in buildPrintCommand via --session", () => {
    const provider = pi("claude-sonnet-4-6");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
    });
    expect(command).toContain("--session 'abc-123'");
  });

  it("codex uses resumeSession in buildPrintCommand", () => {
    const provider = codex("gpt-5.4-mini");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
    });
    expect(command).toContain("codex exec resume 'abc-123'");
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

  it("cursor ignores resumeSession in buildPrintCommand", () => {
    const provider = cursor("claude-sonnet-4-6");
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

  it("buildPrintCommand rejects prompts larger than the argv-safe limit", () => {
    const provider = copilot("claude-sonnet-4.5");
    const huge = "x".repeat(120 * 1024 + 1);
    expect(() => provider.buildPrintCommand(opts(huge))).toThrow(
      /Copilot print-mode prompt/,
    );
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

  it("buildInteractiveArgs seeds the prompt with -i, not -p", () => {
    // `-p`/`--prompt` runs programmatically and exits; interactive sessions
    // must use `-i`/`--interactive` to launch the TUI without exiting.
    const provider = copilot("claude-sonnet-4.5");
    const args = provider.buildInteractiveArgs!(opts("hello"));
    expect(args).toContain("-i");
    expect(args).not.toContain("-p");
    // The prompt immediately follows the -i flag.
    expect(args[args.indexOf("-i") + 1]).toBe("hello");
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
  const provider = claudeCode("claude-opus-4-7");

  it("extracts usage from the last assistant message in a JSONL string", () => {
    const content = [
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-7",
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
          model: "claude-opus-4-7",
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
        model: "claude-opus-4-7",
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
          model: "claude-opus-4-7",
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

  it("is not defined on cursor provider", () => {
    expect(cursor("model").parseSessionUsage).toBeUndefined();
  });
});

describe("captureSessions flag", () => {
  it("claudeCode defaults captureSessions to true", () => {
    expect(claudeCode("claude-opus-4-7").captureSessions).toBe(true);
  });

  it("claudeCode allows opting out of captureSessions", () => {
    expect(
      claudeCode("claude-opus-4-7", { captureSessions: false }).captureSessions,
    ).toBe(false);
  });

  it("pi defaults captureSessions to true", () => {
    expect(pi("pi-model").captureSessions).toBe(true);
  });

  it("pi allows opting out of captureSessions", () => {
    expect(pi("pi-model", { captureSessions: false }).captureSessions).toBe(
      false,
    );
  });

  it("codex defaults captureSessions to true", () => {
    expect(codex("codex-model").captureSessions).toBe(true);
  });

  it("codex allows opting out of captureSessions", () => {
    expect(
      codex("codex-model", { captureSessions: false }).captureSessions,
    ).toBe(false);
  });

  it("opencode has captureSessions false", () => {
    expect(opencode("opencode-model").captureSessions).toBe(false);
  });

  it("cursor has captureSessions false", () => {
    expect(cursor("cursor-model").captureSessions).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sessionStorage — captureToHost populates hostSessionFilePath
// ---------------------------------------------------------------------------

describe("sessionStorage", () => {
  /** Bind-mount handle backed by the host filesystem (sandbox path == host path). */
  const fsBindMountHandle = (): BindMountSandboxHandle => ({
    worktreePath: "/workspace",
    exec: async (command) => {
      const { exec } = await import("node:child_process");
      return new Promise((resolve) => {
        exec(command, (err, stdout, stderr) => {
          resolve({
            stdout: stdout.toString(),
            stderr: stderr.toString(),
            exitCode: err && typeof err.code === "number" ? err.code : 0,
          });
        });
      });
    },
    copyFileIn: async (hostPath, sandboxPath) => {
      const { copyFile } = await import("node:fs/promises");
      await copyFile(hostPath, sandboxPath);
    },
    copyFileOut: async (sandboxPath, hostPath) => {
      const { copyFile } = await import("node:fs/promises");
      await copyFile(sandboxPath, hostPath);
    },
    close: async () => {},
  });

  it("claudeCode hostSessionFilePath is derivable without capture", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-claude-hostpath-"));
    try {
      const provider = claudeCode("claude-opus-4-7", {
        sessionStorage: { hostProjectsDir: dir },
      });
      // Path is purely a function of (cwd, id) — available before any capture.
      const path = provider.sessionStorage!.hostSessionFilePath(
        "/some/cwd",
        "abc-123",
      );
      expect(path).toContain("-some-cwd");
      expect(path).toContain("abc-123.jsonl");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("pi captureToHost transfers a session JSONL with header cwd rewritten and lands it in the host-cwd-encoded dir", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-pi-hostpath-"));
    const sandboxDir = await mkdtemp(join(tmpdir(), "sandcastle-pi-sbx-"));
    try {
      const id = "9ba1c695-2222-4444-8888-e7e847bf34dd";
      const sandboxCwd = "/sandbox/repo";
      const hostCwd = "/host/repo";
      const filename = `2026-05-29T08-00-00_${id}.jsonl`;
      const sandboxSessionDir = join(sandboxDir, "--sandbox-repo--");
      await mkdir(sandboxSessionDir, { recursive: true });
      const sandboxPath = join(sandboxSessionDir, filename);
      const jsonl = [
        JSON.stringify({
          type: "session",
          version: 3,
          id,
          timestamp: "2026-05-29T08:00:00Z",
          cwd: sandboxCwd,
        }),
        JSON.stringify({
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
        }),
      ].join("\n");
      await writeFile(sandboxPath, jsonl);

      const provider = pi("claude-sonnet-4-6", {
        sessionStorage: {
          hostSessionsDir: hostDir,
          sandboxSessionsDir: sandboxDir,
        },
      });

      await provider.sessionStorage!.captureToHost({
        hostCwd,
        sandboxCwd,
        sessionId: id,
        handle: fsBindMountHandle(),
      });

      // File lands in the host-cwd-encoded directory, preserving the filename
      // so pi's `--session <id>` glob (`*_<id>.jsonl`) resolves it.
      const expectedHostPath = join(hostDir, "--host-repo--", filename);
      const content = await readFile(expectedHostPath, "utf-8");
      const lines = content.split("\n");
      const header = JSON.parse(lines[0]!);
      expect(header.type).toBe("session");
      expect(header.cwd).toBe(hostCwd);
      // Non-header lines are preserved verbatim.
      expect(lines[1]).toBe(
        JSON.stringify({
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
        }),
      );

      // existsOnHost finds the captured session by globbing the dir.
      expect(await provider.sessionStorage!.existsOnHost(hostCwd, id)).toBe(
        true,
      );
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("pi resumeIntoSandbox transfers a host session into the sandbox-cwd-encoded dir with cwd rewritten", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-pi-resume-host-"));
    const sandboxDir = await mkdtemp(
      join(tmpdir(), "sandcastle-pi-resume-sbx-"),
    );
    try {
      const id = "9ba1c695-2222-4444-8888-e7e847bf34dd";
      const hostCwd = "/host/repo";
      const sandboxCwd = "/sandbox/repo";
      const filename = `2026-05-29T08-00-00_${id}.jsonl`;
      const hostSessionDir = join(hostDir, "--host-repo--");
      await mkdir(hostSessionDir, { recursive: true });
      const hostPath = join(hostSessionDir, filename);
      const jsonl = JSON.stringify({
        type: "session",
        version: 3,
        id,
        timestamp: "2026-05-29T08:00:00Z",
        cwd: hostCwd,
      });
      await writeFile(hostPath, jsonl);

      const provider = pi("claude-sonnet-4-6", {
        sessionStorage: {
          hostSessionsDir: hostDir,
          sandboxSessionsDir: sandboxDir,
        },
      });

      await provider.sessionStorage!.resumeIntoSandbox({
        hostCwd,
        sandboxCwd,
        sessionId: id,
        handle: fsBindMountHandle(),
      });

      const expectedSandboxPath = posix.join(
        sandboxDir,
        "--sandbox-repo--",
        filename,
      );
      const content = await readFile(expectedSandboxPath, "utf-8");
      const header = JSON.parse(content);
      expect(header.type).toBe("session");
      expect(header.cwd).toBe(sandboxCwd);
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("pi hostSessionFilePath returns the host-cwd-encoded directory", () => {
    const provider = pi("claude-sonnet-4-6", {
      sessionStorage: { hostSessionsDir: "/tmp/sessions" },
    });
    const path = provider.sessionStorage!.hostSessionFilePath(
      "/some/cwd",
      "abc-123",
    );
    expect(path).toBe("/tmp/sessions/--some-cwd--");
  });

  it("pi existsOnHost returns false when no matching session lives under the host root", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-pi-miss-"));
    try {
      const provider = pi("claude-sonnet-4-6", {
        sessionStorage: { hostSessionsDir: hostDir },
      });
      expect(
        await provider.sessionStorage!.existsOnHost("/some/cwd", "missing-id"),
      ).toBe(false);
    } finally {
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("codex hostSessionFilePath returns the captured rollout file after captureToHost", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-codex-hostpath-"));
    const sandboxDir = await mkdtemp(join(tmpdir(), "sandcastle-codex-sbx-"));
    try {
      const id = "9ba1c695-2222-4444-8888-e7e847bf34dd";
      // Stage a sandbox-side rollout file mirroring Codex's YYYY/MM/DD layout.
      const relativePath = posix.join(
        "2026",
        "05",
        "26",
        `rollout-2026-05-26T08-00-00-${id}.jsonl`,
      );
      const sandboxRollout = join(sandboxDir, relativePath);
      await mkdir(join(sandboxRollout, ".."), { recursive: true });
      await writeFile(
        sandboxRollout,
        JSON.stringify({
          type: "session_meta",
          payload: { id, cwd: "/sandbox/repo" },
        }),
      );

      const provider = codex("gpt-5.4-mini", {
        sessionStorage: {
          hostSessionsDir: hostDir,
          sandboxSessionsDir: sandboxDir,
        },
      });

      // Before capture, the path is unknown.
      expect(
        provider.sessionStorage!.hostSessionFilePath("/host/repo", id),
      ).toBeUndefined();

      await provider.sessionStorage!.captureToHost({
        hostCwd: "/host/repo",
        sandboxCwd: "/sandbox/repo",
        sessionId: id,
        handle: fsBindMountHandle(),
      });

      // After capture, the path resolves to the rewritten rollout under hostDir.
      const captured = provider.sessionStorage!.hostSessionFilePath(
        "/host/repo",
        id,
      );
      expect(captured).toBe(join(hostDir, relativePath));
      const content = await readFile(captured!, "utf-8");
      expect(JSON.parse(content).payload.cwd).toBe("/host/repo");
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(sandboxDir, { recursive: true, force: true });
    }
  });
});
