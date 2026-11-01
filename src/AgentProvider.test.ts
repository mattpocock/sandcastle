import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { assert, describe, expect, it } from "vitest";
import {
  claudeCode,
  codex,
  copilot,
  cursor,
  devin,
  opencode,
  pi,
} from "./AgentProvider.js";
import type { AgentCommandOptions, AgentProvider } from "./AgentProvider.js";
import { ForkNotSupportedError } from "./errors.js";
import type { BindMountSandboxHandle } from "./SandboxProvider.js";

/** Builds interactive args, failing the test if the provider has no interactive mode. */
const buildInteractiveArgs = (
  provider: AgentProvider,
  options: AgentCommandOptions,
): string[] => {
  assert(
    provider.buildInteractiveArgs !== undefined,
    `${provider.name} has no interactive mode`,
  );
  return provider.buildInteractiveArgs(options);
};

/** Parses session usage, failing the test if the provider cannot. */
/** How a console argument reads: an Error's message, anything else stringified. */
const consoleText = (value: unknown): string =>
  value instanceof Error ? value.message : String(value);

/** Decorates `base` so copying out any path ending in `suffix` fails. */
const failingCopyFileOut = (
  base: BindMountSandboxHandle,
  suffix: string,
): BindMountSandboxHandle => ({
  ...base,
  copyFileOut: async (sandboxPath, destPath) => {
    if (sandboxPath.endsWith(suffix)) {
      throw new Error("simulated copyFileOut failure");
    }
    return base.copyFileOut(sandboxPath, destPath);
  },
});

const parseSessionUsage = (provider: AgentProvider, content: string) => {
  assert(
    provider.parseSessionUsage !== undefined,
    `${provider.name} has no parseSessionUsage`,
  );
  return provider.parseSessionUsage(content);
};

/** The provider's session storage, failing the test if it has none. */
const sessionStorageOf = (provider: AgentProvider) => {
  assert.isDefined(
    provider.sessionStorage,
    `${provider.name} has no session storage`,
  );
  return provider.sessionStorage;
};

/** Shorthand: build options with dangerouslySkipPermissions: true (mirrors existing sandbox callers). */
const opts = (prompt: string): AgentCommandOptions => ({
  prompt,
  dangerouslySkipPermissions: true,
});

describe("claudeCode factory", () => {
  it("returns a provider with name 'claude-code'", () => {
    const provider = claudeCode("claude-opus-4-8");
    expect(provider.name).toBe("claude-code");
  });

  it("does not expose envManifest or dockerfileTemplate", () => {
    const provider = claudeCode("claude-opus-4-8");
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
    const provider = claudeCode("claude-opus-4-8");
    const { command, stdin } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("-p -");
    expect(command).not.toContain("'do something'");
    expect(stdin).toBe("do something");
  });

  it("buildPrintCommand shell-escapes the model", () => {
    const provider = claudeCode("claude-opus-4-8");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("--model 'claude-opus-4-8'");
  });

  it("parseStreamLine extracts text from assistant message", () => {
    const provider = claudeCode("claude-opus-4-8");
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello world" }] },
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([
      { type: "text", text: "Hello world" },
    ]);
  });

  it("parseStreamLine extracts result from result message", () => {
    const provider = claudeCode("claude-opus-4-8");
    const line = JSON.stringify({
      type: "result",
      result: "Final answer <promise>COMPLETE</promise>",
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([
      {
        type: "result",
        result: "Final answer <promise>COMPLETE</promise>",
      },
    ]);
  });

  it("parseStreamLine returns empty array for non-JSON lines", () => {
    const provider = claudeCode("claude-opus-4-8");
    expect(provider.parseStreamLine("not json")).toStrictEqual([]);
    expect(provider.parseStreamLine("")).toStrictEqual([]);
  });

  it("parseStreamLine extracts tool_use block (Bash → command arg)", () => {
    const provider = claudeCode("claude-opus-4-8");
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "npm test" } },
        ],
      },
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([
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
    const provider = claudeCode("claude-opus-4-8", { effort: "high" });
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("--effort high");
  });

  it("buildPrintCommand omits --effort when not specified", () => {
    const provider = claudeCode("claude-opus-4-8");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).not.toContain("--effort");
  });

  it("buildPrintCommand omits --effort when options is empty", () => {
    const provider = claudeCode("claude-opus-4-8", {});
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).not.toContain("--effort");
  });

  it("supports all effort levels", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const provider = claudeCode("claude-opus-4-8", { effort });
      expect(provider.buildPrintCommand(opts("test")).command).toContain(
        `--effort ${effort}`,
      );
    }
  });

  it("accepts an env option and exposes it on the provider", () => {
    const provider = claudeCode("claude-opus-4-8", {
      env: { ANTHROPIC_API_KEY: "sk-test" },
    });
    expect(provider.env).toStrictEqual({ ANTHROPIC_API_KEY: "sk-test" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = claudeCode("claude-opus-4-8");
    expect(provider.env).toStrictEqual({});
  });

  // --- dangerouslySkipPermissions conditional tests ---

  it("buildPrintCommand includes --dangerously-skip-permissions when true", () => {
    const provider = claudeCode("claude-opus-4-8");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
    });
    expect(command).toContain("--dangerously-skip-permissions");
  });

  it("parseStreamLine emits session_id from Claude Code init line", () => {
    const provider = claudeCode("claude-opus-4-8");
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "abc-123-def",
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([
      { type: "session_id", sessionId: "abc-123-def" },
    ]);
  });

  it("parseStreamLine ignores system events without subtype init", () => {
    const provider = claudeCode("claude-opus-4-8");
    const line = JSON.stringify({
      type: "system",
      subtype: "other",
      session_id: "abc-123-def",
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([]);
  });

  it("parseStreamLine ignores system init without session_id", () => {
    const provider = claudeCode("claude-opus-4-8");
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([]);
  });

  it("buildPrintCommand includes --resume when resumeSession is set", () => {
    const provider = claudeCode("claude-opus-4-8");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
    });
    expect(command).toContain("--resume 'abc-123'");
  });

  it("buildPrintCommand omits --resume when resumeSession is not set", () => {
    const provider = claudeCode("claude-opus-4-8");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
    });
    expect(command).not.toContain("--resume");
  });

  it("buildPrintCommand appends --fork-session when resumeSession + forkSession are set", () => {
    const provider = claudeCode("claude-opus-4-8");
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
    const provider = claudeCode("claude-opus-4-8");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
      forkSession: true,
    });
    expect(command).not.toContain("--fork-session");
    expect(command).not.toContain("--resume");
  });

  it("buildPrintCommand omits --fork-session when forkSession is false", () => {
    const provider = claudeCode("claude-opus-4-8");
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
    const provider = claudeCode("claude-opus-4-8");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: false,
    });
    expect(command).not.toContain("--dangerously-skip-permissions");
  });

  it("buildInteractiveArgs includes --dangerously-skip-permissions when true", () => {
    const provider = claudeCode("claude-opus-4-8");
    const args = buildInteractiveArgs(provider, {
      prompt: "test",
      dangerouslySkipPermissions: true,
    });
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("buildInteractiveArgs omits --dangerously-skip-permissions when false", () => {
    const provider = claudeCode("claude-opus-4-8");
    const args = buildInteractiveArgs(provider, {
      prompt: "test",
      dangerouslySkipPermissions: false,
    });
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  // --- permissionMode option ---

  it("buildPrintCommand emits --permission-mode when permissionMode is set", () => {
    const provider = claudeCode("claude-opus-4-8", { permissionMode: "auto" });
    const { command } = provider.buildPrintCommand(opts("test"));
    expect(command).toContain("--permission-mode auto");
  });

  it("buildPrintCommand omits --dangerously-skip-permissions when permissionMode is set", () => {
    // Sandcastle's AFK call sites pass dangerouslySkipPermissions: true. When the
    // user opts into a specific permission mode on the provider, that mode takes
    // precedence over the default bypass — they are mutually exclusive on claude's CLI.
    const provider = claudeCode("claude-opus-4-8", { permissionMode: "auto" });
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
    });
    expect(command).not.toContain("--dangerously-skip-permissions");
  });

  it("buildPrintCommand omits --permission-mode when permissionMode is not set", () => {
    const provider = claudeCode("claude-opus-4-8");
    const { command } = provider.buildPrintCommand(opts("test"));
    expect(command).not.toContain("--permission-mode");
  });

  it("buildInteractiveArgs emits --permission-mode when permissionMode is set", () => {
    const provider = claudeCode("claude-opus-4-8", { permissionMode: "plan" });
    const args = buildInteractiveArgs(provider, {
      prompt: "test",
      dangerouslySkipPermissions: false,
    });
    expect(args).toContain("--permission-mode");
    expect(args).toContain("plan");
  });

  it("buildInteractiveArgs omits --dangerously-skip-permissions when permissionMode is set", () => {
    const provider = claudeCode("claude-opus-4-8", { permissionMode: "auto" });
    const args = buildInteractiveArgs(provider, {
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
    expect(command).toContain(String.raw`--session 'it'\''s a session'`);
  });

  it("buildPrintCommand uses --fork (not --session) when resumeSession + forkSession are set", () => {
    // `--session <id>` appends to the parent in place; `--fork <id>` copies it
    // into a new session file under a fresh id. Pi rejects the two together.
    const provider = pi("claude-sonnet-4-6", { thinking: "off" });
    const { command } = provider.buildPrintCommand({
      prompt: "branch off",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
      forkSession: true,
    });
    expect(command).toContain("--fork 'abc-123'");
    expect(command).not.toContain("--session");
  });

  it("buildPrintCommand stays on --session when forkSession is false", () => {
    const provider = pi("claude-sonnet-4-6");
    const { command } = provider.buildPrintCommand({
      prompt: "go",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
      forkSession: false,
    });
    expect(command).toContain("--session 'abc-123'");
    expect(command).not.toContain("--fork");
  });

  it("buildPrintCommand ignores forkSession without resumeSession", () => {
    const provider = pi("claude-sonnet-4-6");
    const { command } = provider.buildPrintCommand({
      prompt: "go",
      dangerouslySkipPermissions: true,
      forkSession: true,
    });
    expect(command).not.toContain("--fork");
    expect(command).not.toContain("--session");
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
    expect(provider.parseStreamLine(line)).toStrictEqual([
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
    expect(provider.parseStreamLine(line)).toStrictEqual([
      { type: "tool_call", name: "Bash", args: "npm test" },
    ]);
  });

  it("parseStreamLine extracts pi's lowercase bash tool call as Bash", () => {
    const provider = pi("claude-haiku-5-5");
    // Real line from pi 0.80 --mode json (sandcastle-verify run 20261031-060336-31aa).
    const line =
      '{"type":"tool_execution_start","toolCallId":"toolu_01FFv8fPnapyEsUJu2xwkJyB","toolName":"bash","args":{"command":"cat seed/1.txt"}}';
    expect(provider.parseStreamLine(line)).toStrictEqual([
      { type: "tool_call", name: "Bash", args: "cat seed/1.txt" },
    ]);
  });

  it("parseStreamLine skips non-allowlisted tools", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "tool_execution_start",
      toolName: "UnknownTool",
      args: { foo: "bar" },
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([]);
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
    expect(provider.parseStreamLine(line)).toStrictEqual([
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
    expect(provider.parseStreamLine(line)).toStrictEqual([
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
    expect(provider.parseStreamLine(line)).toStrictEqual([]);
  });

  it("parseStreamLine returns empty array for non-JSON lines", () => {
    const provider = pi("claude-sonnet-4-6");
    expect(provider.parseStreamLine("not json")).toStrictEqual([]);
    expect(provider.parseStreamLine("")).toStrictEqual([]);
  });

  it("parseStreamLine returns empty array for unrecognized event types", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({ type: "unknown_event", data: "foo" });
    expect(provider.parseStreamLine(line)).toStrictEqual([]);
  });

  it("parseStreamLine returns empty array for malformed JSON", () => {
    const provider = pi("claude-sonnet-4-6");
    expect(provider.parseStreamLine("{bad json")).toStrictEqual([]);
  });

  it("parseStreamLine handles message_update with missing content", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({ type: "message_update" });
    expect(provider.parseStreamLine(line)).toStrictEqual([]);
  });

  it("parseStreamLine handles tool_execution_start with missing fields", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "tool_execution_start",
      toolName: "Bash",
      // no args field
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([]);
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

  it("parseStreamLine captures agent_error event with string error as an error event", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "agent_error",
      error: "Authentication failed: invalid API key",
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([
      { type: "error", message: "Authentication failed: invalid API key" },
    ]);
  });

  it("parseStreamLine captures agent_error event with object error as an error event", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "agent_error",
      error: { message: "Rate limit exceeded", code: "rate_limit" },
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([
      { type: "error", message: "Rate limit exceeded" },
    ]);
  });

  it("parseStreamLine captures error event with string message as an error event", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "error",
      message: "Internal server error",
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([
      { type: "error", message: "Internal server error" },
    ]);
  });

  it("parseStreamLine captures error event with string error field as an error event", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "error",
      error: "Connection refused",
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([
      { type: "error", message: "Connection refused" },
    ]);
  });

  it("parseStreamLine returns empty array for agent_error with no extractable message", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "agent_error",
      // no error field
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([]);
  });

  it("parseStreamLine returns empty array for error event with no extractable message", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "error",
      // no message or error field
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([]);
  });

  it("accepts an env option and exposes it on the provider", () => {
    const provider = pi("claude-sonnet-4-6", { env: { PI_KEY: "abc" } });
    expect(provider.env).toStrictEqual({ PI_KEY: "abc" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = pi("claude-sonnet-4-6");
    expect(provider.env).toStrictEqual({});
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
    expect(provider.parseStreamLine(line)).toStrictEqual([
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
    expect(provider.parseStreamLine(line)).toStrictEqual([
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
    expect(provider.parseStreamLine(line)).toStrictEqual([
      { type: "tool_call", name: "Bash", args: "npm test" },
    ]);
  });

  it("parseStreamLine skips turn.completed events without usage", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({ type: "turn.completed" });
    expect(provider.parseStreamLine(line)).toStrictEqual([]);
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
    expect(provider.parseStreamLine(line)).toStrictEqual([
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
    expect(provider.parseStreamLine(line)).toStrictEqual([]);
  });

  it("parseStreamLine returns empty array for non-JSON lines", () => {
    const provider = codex("gpt-5.4-mini");
    expect(provider.parseStreamLine("not json")).toStrictEqual([]);
    expect(provider.parseStreamLine("")).toStrictEqual([]);
  });

  it("parseStreamLine returns empty array for unrecognized event types", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({ type: "unknown_event", data: "foo" });
    expect(provider.parseStreamLine(line)).toStrictEqual([]);
  });

  it("parseStreamLine returns empty array for malformed JSON", () => {
    const provider = codex("gpt-5.4-mini");
    expect(provider.parseStreamLine("{bad json")).toStrictEqual([]);
  });

  it("parseStreamLine handles item.completed with missing text", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message" },
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([]);
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
    expect(provider.parseStreamLine(line)).toStrictEqual([]);
  });

  it("parseStreamLine handles item.started with missing command", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "item.started",
      item: { type: "command_execution" },
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([]);
  });

  it("parseStreamLine handles item.completed with non-agent_message type", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "other_type", content: "foo" },
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([]);
  });

  it("parseStreamLine handles item.started with non-command_execution type", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "item.started",
      item: { type: "other_type", command: "foo" },
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([]);
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
    expect(provider.parseStreamLine(line)).toStrictEqual([
      { type: "result", result: "Internal server error" },
    ]);
  });

  it("parseStreamLine captures error event with string error as result", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "error",
      error: "Authentication failed: invalid API key",
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([
      { type: "result", result: "Authentication failed: invalid API key" },
    ]);
  });

  it("parseStreamLine captures error event with top-level message as result", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "error",
      message: "Rate limit exceeded",
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([
      { type: "result", result: "Rate limit exceeded" },
    ]);
  });

  it("parseStreamLine returns empty array for error event with no extractable message", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "error",
      code: "unknown",
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([]);
  });

  it("accepts an env option and exposes it on the provider", () => {
    const provider = codex("gpt-5.4-mini", { env: { CODEX_API_KEY: "xyz" } });
    expect(provider.env).toStrictEqual({ CODEX_API_KEY: "xyz" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = codex("gpt-5.4-mini");
    expect(provider.env).toStrictEqual({});
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
    expect(command.endsWith(String.raw`'it'\''s a test'`)).toBe(true);
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
    const args = buildInteractiveArgs(provider, {
      prompt: "test prompt",
      dangerouslySkipPermissions: true,
    });
    expect(args).toStrictEqual([
      "agent",
      "--model",
      "claude-sonnet-4-6",
      "--force",
      "test prompt",
    ]);
  });

  it("buildInteractiveArgs omits prompt when empty", () => {
    const provider = cursor("claude-sonnet-4-6");
    const args = buildInteractiveArgs(provider, {
      prompt: "",
      dangerouslySkipPermissions: true,
    });
    expect(args).toStrictEqual([
      "agent",
      "--model",
      "claude-sonnet-4-6",
      "--force",
    ]);
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
    expect(provider.parseStreamLine(line)).toStrictEqual([
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
    expect(provider.parseStreamLine(line)).toStrictEqual([
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
    expect(provider.parseStreamLine(line)).toStrictEqual([
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
    expect(provider.parseStreamLine(line)).toStrictEqual([
      { type: "tool_call", name: "Write", args: "src/index.ts" },
    ]);
  });

  // Shapes from a real `cursor-agent` composer-2 run (2026-10-31), trimmed.
  it("parseStreamLine extracts top-level tool_call shellToolCall as Bash (Cursor stream-json)", () => {
    const provider = cursor("composer-2");
    const line = JSON.stringify({
      type: "tool_call",
      subtype: "started",
      call_id: "tool_c3c8b5b5",
      tool_call: {
        shellToolCall: {
          args: {
            command: "cat notes/notes1.md",
            workingDirectory: "/home/agent/workspace",
            timeout: 30_000,
            simpleCommands: ["cat"],
            description: "Cat notes/notes1.md",
          },
          description: "Cat notes/notes1.md",
        },
        toolCallId: "tool_c3c8b5b5",
      },
      session_id: "60cbceb8-65bb-4504-846b-6efc1b3d3e56",
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([
      { type: "tool_call", name: "Bash", args: "cat notes/notes1.md" },
    ]);
  });

  it("parseStreamLine extracts top-level tool_call editToolCall as Edit (Cursor stream-json)", () => {
    const provider = cursor("composer-2");
    const line = JSON.stringify({
      type: "tool_call",
      subtype: "started",
      call_id: "tool_d0facb6c",
      tool_call: {
        editToolCall: {
          args: {
            path: "/home/agent/workspace/cursor-a.txt",
            streamContent: "hello from cursor a\n",
          },
        },
        toolCallId: "tool_d0facb6c",
      },
      session_id: "60cbceb8-65bb-4504-846b-6efc1b3d3e56",
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([
      {
        type: "tool_call",
        name: "Edit",
        args: "/home/agent/workspace/cursor-a.txt",
      },
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
    expect(provider.parseStreamLine(line)).toStrictEqual([]);
  });

  it("parseStreamLine extracts result event", () => {
    const provider = cursor("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "result",
      result: "Done <promise>COMPLETE</promise>",
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([
      { type: "result", result: "Done <promise>COMPLETE</promise>" },
    ]);
  });

  it("accepts an env option and exposes it on the provider", () => {
    const provider = cursor("claude-sonnet-4-6", {
      env: { CURSOR_API_KEY: "cursor-key" },
    });
    expect(provider.env).toStrictEqual({ CURSOR_API_KEY: "cursor-key" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = cursor("claude-sonnet-4-6");
    expect(provider.env).toStrictEqual({});
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
    expect(command).toContain(String.raw`'it'\''s a test'`);
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
    expect(command).toContain(String.raw`--variant 'it'\''s tricky'`);
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
    expect(command).toContain(String.raw`--agent 'it'\''s tricky'`);
  });

  it("buildInteractiveArgs includes --agent when specified", () => {
    const provider = opencode("opencode/big-pickle", { agent: "build" });
    const args = buildInteractiveArgs(provider, opts("do something"));
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
    const args = buildInteractiveArgs(provider, opts("do something"));
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
    expect(provider.parseStreamLine(line)).toStrictEqual([
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
    expect(provider.parseStreamLine(line)).toStrictEqual([
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
    expect(provider.parseStreamLine(line)).toStrictEqual([
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
    expect(provider.parseStreamLine(line)).toStrictEqual([
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
    expect(provider.parseStreamLine(line)).toStrictEqual([
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
    expect(provider.parseStreamLine(line)).toStrictEqual([
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
    expect(provider.parseStreamLine(line)).toStrictEqual([
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
    expect(provider.parseStreamLine(line)).toStrictEqual([
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
    expect(provider.parseStreamLine(line)).toStrictEqual([
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
    expect(provider.parseStreamLine(line)).toStrictEqual([]);
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
    expect(provider.parseStreamLine(line)).toStrictEqual([]);
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
    expect(provider.parseStreamLine(line)).toStrictEqual([
      { type: "error", message: "Invalid API key" },
    ]);
  });

  it("parseStreamLine skips step_finish events", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({
      type: "step_finish",
      sessionID: "ses_abc",
      part: { type: "step-finish", tokens: { total: 100 } },
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([]);
  });

  it("parseStreamLine returns empty array for unrecognized event types", () => {
    const provider = opencode("opencode/big-pickle");
    const line = JSON.stringify({ type: "unknown_event", data: "foo" });
    expect(provider.parseStreamLine(line)).toStrictEqual([]);
  });

  it("parseStreamLine returns empty array for non-JSON lines", () => {
    const provider = opencode("opencode/big-pickle");
    expect(provider.parseStreamLine("not json")).toStrictEqual([]);
    expect(provider.parseStreamLine("")).toStrictEqual([]);
  });

  it("parseStreamLine returns empty array for malformed JSON", () => {
    const provider = opencode("opencode/big-pickle");
    expect(provider.parseStreamLine("{bad json")).toStrictEqual([]);
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
    expect(provider.env).toStrictEqual({ OPENCODE_API_KEY: "sk-test" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = opencode("opencode/big-pickle");
    expect(provider.env).toStrictEqual({});
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

  it("opencode resumes a session with --session <id>", () => {
    const { command } = opencode("opencode/big-pickle").buildPrintCommand({
      ...opts("test"),
      resumeSession: "ses_abc123",
    });
    expect(command).toContain("--session 'ses_abc123'");
    expect(command).not.toContain("--fork");
  });

  it("opencode forks a session with --session <id> --fork", () => {
    const { command } = opencode("opencode/big-pickle").buildPrintCommand({
      ...opts("test"),
      resumeSession: "ses_abc123",
      forkSession: true,
    });
    expect(command).toContain("--session 'ses_abc123' --fork");
  });

  it("opencode omits --session and --fork on a fresh run", () => {
    const { command } = opencode("opencode/big-pickle").buildPrintCommand({
      ...opts("test"),
      forkSession: true,
    });
    expect(command).not.toContain("--session");
    expect(command).not.toContain("--fork");
  });

  it("cursor resumes a session with --resume=<id> before the prompt", () => {
    const provider = cursor("composer-2");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
    });
    expect(command).toContain("--resume='abc-123' 'test'");
  });

  it("cursor omits --resume on a fresh run", () => {
    const { command } = cursor("composer-2").buildPrintCommand(opts("test"));
    expect(command).not.toContain("--resume");
  });

  it("cursor declares that it cannot fork (the CLI has no fork flag)", () => {
    expect(cursor("composer-2").sessionStorage.canFork).toBe(false);
  });

  it("cursor buildPrintCommand throws ForkNotSupportedError naming cursor when asked to fork", () => {
    const fork = (): unknown =>
      cursor("composer-2").buildPrintCommand({
        ...opts("test"),
        resumeSession: "abc-123",
        forkSession: true,
      });
    expect(fork).toThrow(ForkNotSupportedError);
    expect(fork).toThrow(/cursor cannot fork/u);
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

  it("captures sessions by default, and can opt out", () => {
    expect(copilot("claude-sonnet-4.5").captureSessions).toBe(true);
    expect(
      copilot("claude-sonnet-4.5", { captureSessions: false }).captureSessions,
    ).toBe(false);
  });

  it("buildPrintCommand resumes a session with --resume=<id>", () => {
    const provider = copilot("claude-sonnet-4.5");
    const { command } = provider.buildPrintCommand({
      ...opts("test"),
      resumeSession: "abc-123",
    });
    expect(command).toContain("--resume='abc-123'");
  });

  it("buildPrintCommand omits --resume on a fresh run", () => {
    const provider = copilot("claude-sonnet-4.5");
    const { command } = provider.buildPrintCommand(opts("test"));
    expect(command).not.toContain("--resume");
  });

  it("declares that it cannot fork (the CLI has no fork flag)", () => {
    expect(copilot("claude-sonnet-4.5").sessionStorage.canFork).toBe(false);
  });

  it("buildPrintCommand throws ForkNotSupportedError naming copilot when asked to fork", () => {
    const provider = copilot("claude-sonnet-4.5");
    expect(() =>
      provider.buildPrintCommand({
        ...opts("test"),
        resumeSession: "abc-123",
        forkSession: true,
      }),
    ).toThrow(ForkNotSupportedError);
    expect(() =>
      provider.buildPrintCommand({
        ...opts("test"),
        resumeSession: "abc-123",
        forkSession: true,
      }),
    ).toThrow(/copilot/u);
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
    expect(command).toContain(String.raw`'it'\''s a test'`);
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

  it("buildInteractiveArgs includes copilot binary, --model, and prompt", () => {
    const provider = copilot("claude-sonnet-4.5");
    const args = buildInteractiveArgs(provider, opts("hello"));
    expect(args[0]).toBe("copilot");
    expect(args).toContain("--model");
    expect(args).toContain("claude-sonnet-4.5");
    expect(args).toContain("hello");
  });

  it("buildInteractiveArgs seeds the prompt with -i, not -p", () => {
    // `-p`/`--prompt` runs programmatically and exits; interactive sessions
    // must use `-i`/`--interactive` to launch the TUI without exiting.
    const provider = copilot("claude-sonnet-4.5");
    const args = buildInteractiveArgs(provider, opts("hello"));
    expect(args).toContain("-i");
    expect(args).not.toContain("-p");
    // The prompt immediately follows the -i flag.
    expect(args[args.indexOf("-i") + 1]).toBe("hello");
  });

  it("parseStreamLine returns empty array for non-JSON and unrecognised input", () => {
    const provider = copilot("claude-sonnet-4.5");
    expect(provider.parseStreamLine("some output text")).toStrictEqual([]);
    expect(provider.parseStreamLine("")).toStrictEqual([]);
    expect(
      provider.parseStreamLine(JSON.stringify({ type: "text", text: "hi" })),
    ).toStrictEqual([]);
  });

  it("parseStreamLine extracts text from assistant.message_delta event", () => {
    const provider = copilot("claude-sonnet-4.5");
    const line = JSON.stringify({
      type: "assistant.message_delta",
      data: { messageId: "m1", deltaContent: "hello" },
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([
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
    expect(provider.parseStreamLine(line)).toStrictEqual([
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
    expect(provider.parseStreamLine(line)).toStrictEqual([]);
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
    expect(provider.parseStreamLine(line)).toStrictEqual([
      { type: "result", result: "Final answer." },
    ]);
  });

  it("parseStreamLine ignores assistant.message with empty content", () => {
    const provider = copilot("claude-sonnet-4.5");
    const line = JSON.stringify({
      type: "assistant.message",
      data: { messageId: "m1", content: "", toolRequests: [] },
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([]);
  });

  it("parseStreamLine extracts session_id from terminal result event", () => {
    const provider = copilot("claude-sonnet-4.5");
    const line = JSON.stringify({
      type: "result",
      sessionId: "08f6db99-c0af-4d97-a927-a526b205de12",
      exitCode: 0,
      usage: { premiumRequests: 1 },
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([
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
      ).toStrictEqual([]);
    }
  });

  it("parseStreamLine returns empty array for malformed JSON", () => {
    const provider = copilot("claude-sonnet-4.5");
    expect(provider.parseStreamLine("{bad json")).toStrictEqual([]);
  });

  it("parseStreamLine surfaces error events as error events (string error)", () => {
    const provider = copilot("claude-sonnet-4.5");
    const line = JSON.stringify({
      type: "error",
      error: "Connection refused",
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([
      { type: "error", message: "Connection refused" },
    ]);
  });

  it("parseStreamLine surfaces error events as error events (object error)", () => {
    const provider = copilot("claude-sonnet-4.5");
    const line = JSON.stringify({
      type: "agent_error",
      error: { message: "Rate limit exceeded", code: "rate_limit" },
    });
    expect(provider.parseStreamLine(line)).toStrictEqual([
      { type: "error", message: "Rate limit exceeded" },
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
    expect(events).toStrictEqual([
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
    expect(provider.env).toStrictEqual({ GITHUB_TOKEN: "ghp_test" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = copilot("claude-sonnet-4.5");
    expect(provider.env).toStrictEqual({});
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

describe("devin factory", () => {
  const opts = (prompt: string): AgentCommandOptions => ({
    prompt,
    dangerouslySkipPermissions: false,
  });

  it("returns a provider with name 'devin'", () => {
    expect(devin("swe-1-6-fast").name).toBe("devin");
  });

  it("captureSessions is false", () => {
    expect(devin("swe-1-6-fast").captureSessions).toBe(false);
  });

  it("defaults env to empty object", () => {
    expect(devin("swe-1-6-fast").env).toEqual({});
  });

  it("accepts env option and exposes it", () => {
    expect(
      devin("swe-1-6-fast", { env: { DEVIN_API_KEY: "cog_test" } }).env,
    ).toEqual({ DEVIN_API_KEY: "cog_test" });
  });

  it("buildPrintCommand includes -p flag", () => {
    const { command } = devin("swe-1-6-fast").buildPrintCommand(opts("hello"));
    expect(command).toContain("-p");
  });

  it("buildPrintCommand includes the model", () => {
    const { command } = devin("swe-1-6-fast").buildPrintCommand(opts("hello"));
    expect(command).toContain("swe-1-6-fast");
  });

  it("buildPrintCommand shell-escapes the model", () => {
    const { command } = devin("swe-1-6-fast").buildPrintCommand(opts("hello"));
    expect(command).toContain("--model 'swe-1-6-fast'");
  });

  it("buildPrintCommand delivers prompt via stdin and --prompt-file (not inline argv)", () => {
    const result = devin("swe-1-6-fast").buildPrintCommand(
      opts("do something"),
    );
    expect(result.stdin).toBe("do something");
    expect(result.command).toContain("mktemp");
    expect(result.command).toContain("--prompt-file");
    expect(result.command).toContain("trap");
    expect(result.command).not.toContain("do something");
  });

  it("buildPrintCommand includes credentials.toml setup from DEVIN_API_KEY", () => {
    const { command } = devin("swe-1-6-fast").buildPrintCommand(opts("hello"));
    expect(command).toContain("credentials.toml");
    expect(command).toContain("DEVIN_SESSION_TOKEN");
    expect(command).toContain("~/.local/share/devin");
  });

  it("buildPrintCommand includes --permission-mode bypass when dangerouslySkipPermissions", () => {
    const { command } = devin("swe-1-6-fast").buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
    });
    expect(command).toContain("--permission-mode dangerous");
  });

  it("buildPrintCommand omits --permission-mode bypass when not set", () => {
    const { command } = devin("swe-1-6-fast").buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: false,
    });
    expect(command).not.toContain("--permission-mode dangerous");
  });

  it("parseStreamLine returns text event for non-empty line", () => {
    expect(devin("swe-1-6-fast").parseStreamLine("Hello world")).toEqual([
      { type: "text", text: "Hello world" },
    ]);
  });

  it("parseStreamLine returns empty array for blank line", () => {
    expect(devin("swe-1-6-fast").parseStreamLine("")).toEqual([]);
  });

  it("parseStreamLine returns empty array for whitespace-only line", () => {
    expect(devin("swe-1-6-fast").parseStreamLine("   ")).toEqual([]);
  });

  it("buildInteractiveArgs includes binary, model, and prompt", () => {
    expect(
      devin("swe-1-6-fast").buildInteractiveArgs!({
        prompt: "do something",
        dangerouslySkipPermissions: true,
      }),
    ).toEqual(["devin", "--model", "swe-1-6-fast", "--", "do something"]);
  });

  it("buildInteractiveArgs omits -- and prompt when prompt is empty", () => {
    expect(
      devin("swe-1-6-fast").buildInteractiveArgs!({
        prompt: "",
        dangerouslySkipPermissions: false,
      }),
    ).toEqual(["devin", "--model", "swe-1-6-fast"]);
  });

  it("has no sessionStorage", () => {
    expect(devin("swe-1-6-fast").sessionStorage).toBeUndefined();
  });
});

describe("parseSessionUsage (Claude Code)", () => {
  const provider = claudeCode("claude-opus-4-8");

  it("extracts usage from the last assistant message in a JSONL string", () => {
    const content = [
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-8",
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
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: 9294,
            cache_read_input_tokens: 8526,
            output_tokens: 458,
          },
        },
      }),
    ].join("\n");

    expect(parseSessionUsage(provider, content)).toEqual({
      inputTokens: 3,
      cacheCreationInputTokens: 9294,
      cacheReadInputTokens: 8526,
      outputTokens: 458,
    });
  });

  it("returns undefined for empty content", () => {
    expect(parseSessionUsage(provider, "")).toBeUndefined();
  });

  it("returns undefined for content with no assistant messages", () => {
    const content = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "abc" }),
      JSON.stringify({ type: "result", result: "done" }),
    ].join("\n");
    expect(parseSessionUsage(provider, content)).toBeUndefined();
  });

  it("returns undefined when assistant message has no usage block", () => {
    const content = JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "hi" }],
      },
    });
    expect(parseSessionUsage(provider, content)).toBeUndefined();
  });

  it("returns undefined for malformed JSON lines", () => {
    const content = "not json\n{bad json\n";
    expect(parseSessionUsage(provider, content)).toBeUndefined();
  });

  it("skips malformed lines and finds valid assistant message", () => {
    const content = [
      "not json",
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
            output_tokens: 40,
          },
        },
      }),
    ].join("\n");

    expect(parseSessionUsage(provider, content)).toEqual({
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
    expect(claudeCode("claude-opus-4-8").captureSessions).toBe(true);
  });

  it("claudeCode allows opting out of captureSessions", () => {
    expect(
      claudeCode("claude-opus-4-8", { captureSessions: false }).captureSessions,
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

  it("opencode defaults captureSessions to true", () => {
    expect(opencode("opencode-model").captureSessions).toBe(true);
  });

  it("opencode allows opting out of captureSessions", () => {
    expect(
      opencode("opencode-model", { captureSessions: false }).captureSessions,
    ).toBe(false);
  });

  it("cursor defaults captureSessions to true", () => {
    expect(cursor("cursor-model").captureSessions).toBe(true);
  });

  it("cursor allows opting out of captureSessions", () => {
    expect(
      cursor("cursor-model", { captureSessions: false }).captureSessions,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sessionStorage — captureToHost populates hostSessionFilePath
// ---------------------------------------------------------------------------

describe("sessionStorage", () => {
  /** Bind-mount handle backed by the host filesystem (sandbox path == host path). */
  const fsBindMountHandle = (): BindMountSandboxHandle => ({
    worktreePath: "/workspace",
    exec: async (command, options) => {
      const { exec } = await import("node:child_process");
      return new Promise((resolve) => {
        const child = exec(command, (err, stdout, stderr) => {
          resolve({
            stdout: stdout.toString(),
            stderr: stderr.toString(),
            exitCode: err && typeof err.code === "number" ? err.code : 0,
          });
        });
        child.stdin?.end(options?.stdin);
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
      const provider = claudeCode("claude-opus-4-8", {
        sessionStorage: { hostProjectsDir: dir },
      });
      // Path is purely a function of (cwd, id) — available before any capture.
      const path = sessionStorageOf(provider).hostSessionFilePath(
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

      await sessionStorageOf(provider).captureToHost({
        hostCwd,
        sandboxCwd,
        sessionId: id,
        handle: fsBindMountHandle(),
      });

      // File lands in the host-cwd-encoded directory, preserving the filename
      // so pi's `--session <id>` glob (`*_<id>.jsonl`) resolves it.
      const expectedHostPath = join(hostDir, "--host-repo--", filename);
      const content = await readFile(expectedHostPath, "utf8");
      const lines = content.split("\n");
      const [header] = lines;
      assert.isDefined(header);
      expect(JSON.parse(header)).toMatchObject({
        type: "session",
        cwd: hostCwd,
      });
      // Non-header lines are preserved verbatim.
      expect(lines[1]).toBe(
        JSON.stringify({
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
        }),
      );

      // existsOnHost finds the captured session by globbing the dir.
      await expect(
        sessionStorageOf(provider).existsOnHost(hostCwd, id),
      ).resolves.toBe(true);

      // hostSessionFilePath (surfaced as IterationResult.sessionFilePath) is
      // the captured JSONL itself, not its directory.
      expect(provider.sessionStorage.hostSessionFilePath(hostCwd, id)).toBe(
        expectedHostPath,
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

      await sessionStorageOf(provider).resumeIntoSandbox({
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
      const content = await readFile(expectedSandboxPath, "utf8");
      expect(JSON.parse(content)).toMatchObject({
        type: "session",
        cwd: sandboxCwd,
      });
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("pi hostSessionFilePath falls back to the host-cwd-encoded directory before capture", () => {
    const provider = pi("claude-sonnet-4-6", {
      sessionStorage: { hostSessionsDir: "/tmp/sessions" },
    });
    const path = sessionStorageOf(provider).hostSessionFilePath(
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
      await expect(
        sessionStorageOf(provider).existsOnHost("/some/cwd", "missing-id"),
      ).resolves.toBe(false);
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
        sessionStorageOf(provider).hostSessionFilePath("/host/repo", id),
      ).toBeUndefined();

      await sessionStorageOf(provider).captureToHost({
        hostCwd: "/host/repo",
        sandboxCwd: "/sandbox/repo",
        sessionId: id,
        handle: fsBindMountHandle(),
      });

      // After capture, the path resolves to the rewritten rollout under hostDir.
      const captured = sessionStorageOf(provider).hostSessionFilePath(
        "/host/repo",
        id,
      );
      expect(captured).toBe(join(hostDir, relativePath));
      assert.isDefined(captured);
      const content = await readFile(captured, "utf8");
      expect(JSON.parse(content)).toMatchObject({
        payload: { cwd: "/host/repo" },
      });
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("claudeCode captureToHost copies the main session when no subagents dir exists", async () => {
    const hostDir = await mkdtemp(
      join(tmpdir(), "sandcastle-claude-sub-main-"),
    );
    const sandboxDir = await mkdtemp(
      join(tmpdir(), "sandcastle-claude-sub-sbx-"),
    );
    try {
      const id = "session-only";
      const hostCwd = "/host/repo";
      const sandboxCwd = "/sandbox/repo";
      const sandboxProjectDir = join(sandboxDir, "-sandbox-repo");
      await mkdir(sandboxProjectDir, { recursive: true });
      const sandboxMain = join(sandboxProjectDir, `${id}.jsonl`);
      await writeFile(
        sandboxMain,
        JSON.stringify({ type: "system", cwd: sandboxCwd }),
      );

      const provider = claudeCode("claude-opus-4-8", {
        sessionStorage: {
          hostProjectsDir: hostDir,
          sandboxProjectsDir: sandboxDir,
        },
      });

      await sessionStorageOf(provider).captureToHost({
        hostCwd,
        sandboxCwd,
        sessionId: id,
        handle: fsBindMountHandle(),
      });

      const expectedHostPath = join(hostDir, "-host-repo", `${id}.jsonl`);
      const main = await readFile(expectedHostPath, "utf8");
      expect(JSON.parse(main)).toMatchObject({ cwd: hostCwd });
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("claudeCode captureToHost copies subagent/workflow logs alongside the main session with cwd rewritten", async () => {
    const hostDir = await mkdtemp(
      join(tmpdir(), "sandcastle-claude-sub-many-"),
    );
    const sandboxDir = await mkdtemp(
      join(tmpdir(), "sandcastle-claude-sub-many-sbx-"),
    );
    try {
      const id = "session-with-subagents";
      const hostCwd = "/host/repo";
      const sandboxCwd = "/sandbox/repo";
      const sandboxProjectDir = join(sandboxDir, "-sandbox-repo");
      const sandboxSubagentsDir = join(sandboxProjectDir, id, "subagents");
      await mkdir(sandboxSubagentsDir, { recursive: true });

      // Main session
      await writeFile(
        join(sandboxProjectDir, `${id}.jsonl`),
        JSON.stringify({ type: "system", cwd: sandboxCwd }),
      );

      // Two subagent transcripts (each line carries top-level cwd)
      const alphaLines = [
        JSON.stringify({ type: "system", cwd: sandboxCwd, agent: "alpha" }),
        JSON.stringify({ type: "message", cwd: sandboxCwd, text: "a-msg" }),
      ].join("\n");
      const betaLines = [
        JSON.stringify({ type: "system", cwd: sandboxCwd, agent: "beta" }),
        JSON.stringify({ type: "message", cwd: sandboxCwd, text: "b-msg" }),
      ].join("\n");
      await writeFile(
        join(sandboxSubagentsDir, "agent-alpha.jsonl"),
        alphaLines,
      );
      await writeFile(join(sandboxSubagentsDir, "agent-beta.jsonl"), betaLines);

      // A non-matching sibling — must NOT be copied to the host.
      await writeFile(join(sandboxSubagentsDir, "notes.txt"), "ignore me");

      const provider = claudeCode("claude-opus-4-8", {
        sessionStorage: {
          hostProjectsDir: hostDir,
          sandboxProjectsDir: sandboxDir,
        },
      });

      await sessionStorageOf(provider).captureToHost({
        hostCwd,
        sandboxCwd,
        sessionId: id,
        handle: fsBindMountHandle(),
      });

      // Main session captured with cwd rewritten.
      const mainContent = await readFile(
        join(hostDir, "-host-repo", `${id}.jsonl`),
        "utf8",
      );
      expect(JSON.parse(mainContent)).toMatchObject({ cwd: hostCwd });

      // Both subagent transcripts captured with cwd rewritten on every line.
      const hostSubagentsDir = join(hostDir, "-host-repo", id, "subagents");
      const alpha = await readFile(
        join(hostSubagentsDir, "agent-alpha.jsonl"),
        "utf8",
      );
      for (const line of alpha.split("\n")) {
        expect(JSON.parse(line)).toMatchObject({ cwd: hostCwd });
      }
      const beta = await readFile(
        join(hostSubagentsDir, "agent-beta.jsonl"),
        "utf8",
      );
      for (const line of beta.split("\n")) {
        expect(JSON.parse(line)).toMatchObject({ cwd: hostCwd });
      }

      // The non-matching sibling must not have been copied.
      await expect(
        readFile(join(hostSubagentsDir, "notes.txt"), "utf8"),
      ).rejects.toThrow("ENOENT");
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("claudeCode captureToHost: a failing subagent copy logs a warning and lets siblings + main session through", async () => {
    const hostDir = await mkdtemp(
      join(tmpdir(), "sandcastle-claude-sub-fail-"),
    );
    const sandboxDir = await mkdtemp(
      join(tmpdir(), "sandcastle-claude-sub-fail-sbx-"),
    );
    try {
      const id = "session-flaky-sub";
      const hostCwd = "/host/repo";
      const sandboxCwd = "/sandbox/repo";
      const sandboxProjectDir = join(sandboxDir, "-sandbox-repo");
      const sandboxSubagentsDir = join(sandboxProjectDir, id, "subagents");
      await mkdir(sandboxSubagentsDir, { recursive: true });

      // Main session
      await writeFile(
        join(sandboxProjectDir, `${id}.jsonl`),
        JSON.stringify({ type: "system", cwd: sandboxCwd }),
      );
      // Good subagent
      await writeFile(
        join(sandboxSubagentsDir, "agent-good.jsonl"),
        JSON.stringify({ type: "system", cwd: sandboxCwd, agent: "good" }),
      );
      // Bad subagent: enumerated by find but fails on read (copyFileOut).
      await writeFile(
        join(sandboxSubagentsDir, "agent-bad.jsonl"),
        JSON.stringify({ type: "system", cwd: sandboxCwd, agent: "bad" }),
      );

      // Spy: drop console.error so the test output stays clean and we can
      // assert that exactly one warning was emitted.
      const errors: string[] = [];
      const originalError = console.error;
      console.error = (msg: unknown, ...rest: unknown[]) => {
        errors.push([msg, ...rest].map((v) => consoleText(v)).join(" "));
      };

      try {
        // Decorate the fs handle: make copyFileOut fail for the bad subagent.
        const base = fsBindMountHandle();
        const handle = failingCopyFileOut(base, "agent-bad.jsonl");

        // Main capture must succeed; the bad subagent must not abort the run.
        const provider = claudeCode("claude-opus-4-8", {
          sessionStorage: {
            hostProjectsDir: hostDir,
            sandboxProjectsDir: sandboxDir,
          },
        });
        await sessionStorageOf(provider).captureToHost({
          hostCwd,
          sandboxCwd,
          sessionId: id,
          handle,
        });
      } finally {
        console.error = originalError;
      }

      // Main session captured.
      const mainContent = await readFile(
        join(hostDir, "-host-repo", `${id}.jsonl`),
        "utf8",
      );
      expect(JSON.parse(mainContent)).toMatchObject({ cwd: hostCwd });

      // Good sibling captured.
      const hostSubagentsDir = join(hostDir, "-host-repo", id, "subagents");
      const good = await readFile(
        join(hostSubagentsDir, "agent-good.jsonl"),
        "utf8",
      );
      expect(JSON.parse(good)).toMatchObject({ cwd: hostCwd });

      // Bad subagent NOT copied.
      await expect(
        readFile(join(hostSubagentsDir, "agent-bad.jsonl"), "utf8"),
      ).rejects.toThrow("ENOENT");

      // Exactly one warning emitted, naming the bad path — successful
      // siblings and the main session must not produce warnings of their own.
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("agent-bad.jsonl");
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(sandboxDir, { recursive: true, force: true });
    }
  });

  /** The `data.context` of each event in a Copilot `events.jsonl`. */
  const copilotContexts = (jsonl: string): unknown[] =>
    jsonl
      .split("\n")
      .filter((line) => line !== "")
      .map((line): unknown => {
        const event: unknown = JSON.parse(line);
        return typeof event === "object" && event !== null && "data" in event
          ? event.data
          : undefined;
      });

  it("copilot captureToHost copies events.jsonl to the host with the context cwd rewritten", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-copilot-host-"));
    const sandboxDir = await mkdtemp(join(tmpdir(), "sandcastle-copilot-sbx-"));
    try {
      const id = "9f2885bc-f7a6-44ad-8c8e-4e22ca99fa26";
      await mkdir(join(sandboxDir, id), { recursive: true });
      const start = {
        type: "session.start",
        data: {
          sessionId: id,
          context: {
            cwd: "/sandbox/repo",
            gitRoot: "/sandbox/repo",
            branch: "main",
          },
        },
      };
      const message = {
        type: "user.message",
        data: { content: "cwd is /sandbox/repo" },
      };
      await writeFile(
        join(sandboxDir, id, "events.jsonl"),
        `${JSON.stringify(start)}\n${JSON.stringify(message)}\n`,
      );
      const { sessionStorage } = copilot("claude-haiku-4.5", {
        sessionStorage: {
          hostSessionsDir: hostDir,
          sandboxSessionsDir: sandboxDir,
        },
      });
      await expect(sessionStorage.existsOnHost("/host/repo", id)).resolves.toBe(
        false,
      );

      await sessionStorage.captureToHost({
        hostCwd: "/host/repo",
        sandboxCwd: "/sandbox/repo",
        sessionId: id,
        handle: fsBindMountHandle(),
      });

      const hostPath = join(hostDir, id, "events.jsonl");
      expect(sessionStorage.hostSessionFilePath("/host/repo", id)).toBe(
        hostPath,
      );
      // Only the structured context moves; free text is left alone.
      expect(copilotContexts(await readFile(hostPath, "utf8"))).toStrictEqual([
        {
          sessionId: id,
          context: { cwd: "/host/repo", gitRoot: "/host/repo", branch: "main" },
        },
        { content: "cwd is /sandbox/repo" },
      ]);
      await expect(sessionStorage.existsOnHost("/host/repo", id)).resolves.toBe(
        true,
      );
      await expect(sessionStorage.findByIdOnHost(id)).resolves.toStrictEqual({
        path: hostPath,
        searchedRoot: hostDir,
      });
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("copilot resumeIntoSandbox writes events.jsonl into the sandbox session-state with the cwd rewritten", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-copilot-host-"));
    const sandboxDir = await mkdtemp(join(tmpdir(), "sandcastle-copilot-sbx-"));
    try {
      const id = "b8c6a68f-e6fe-4253-8574-e1230d699808";
      await mkdir(join(hostDir, id), { recursive: true });
      const start = {
        type: "session.start",
        data: { context: { cwd: "/host/repo", gitRoot: "/host/repo" } },
      };
      await writeFile(
        join(hostDir, id, "events.jsonl"),
        `${JSON.stringify(start)}\n`,
      );
      const { sessionStorage } = copilot("claude-haiku-4.5", {
        sessionStorage: {
          hostSessionsDir: hostDir,
          sandboxSessionsDir: sandboxDir,
        },
      });

      await sessionStorage.resumeIntoSandbox({
        hostCwd: "/host/repo",
        sandboxCwd: "/sandbox/repo",
        sessionId: id,
        handle: fsBindMountHandle(),
      });

      const content = await readFile(
        join(sandboxDir, id, "events.jsonl"),
        "utf8",
      );
      expect(copilotContexts(content)).toStrictEqual([
        { context: { cwd: "/sandbox/repo", gitRoot: "/sandbox/repo" } },
      ]);
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("copilot findByIdOnHost reports the searched root when the session is missing", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-copilot-host-"));
    try {
      const { sessionStorage } = copilot("claude-haiku-4.5", {
        sessionStorage: { hostSessionsDir: hostDir },
      });
      await expect(
        sessionStorage.findByIdOnHost("missing"),
      ).resolves.toStrictEqual({ path: undefined, searchedRoot: hostDir });
    } finally {
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  /** Cursor's chat dir name for a cwd: the md5 of the path. */
  const cursorChatDir = (cwd: string): string =>
    createHash("md5").update(cwd).digest("hex");

  /** Bytes standing in for Cursor's SQLite `store.db` (binary, with NULs). */
  const storeBytes = Buffer.from([
    0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x00, 0xff,
  ]);

  it("cursor captureToHost copies the chat's store.db, byte for byte, under the host cwd's chat dir", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-cursor-host-"));
    const sandboxDir = await mkdtemp(join(tmpdir(), "sandcastle-cursor-sbx-"));
    try {
      const id = "dd42b549-290c-4635-b058-04801905e8cf";
      const sandboxChat = join(sandboxDir, cursorChatDir("/sandbox/repo"), id);
      await mkdir(sandboxChat, { recursive: true });
      await writeFile(join(sandboxChat, "store.db"), storeBytes);
      const { sessionStorage } = cursor("composer-2", {
        sessionStorage: { hostChatsDir: hostDir, sandboxChatsDir: sandboxDir },
      });
      await expect(sessionStorage.existsOnHost("/host/repo", id)).resolves.toBe(
        false,
      );

      await sessionStorage.captureToHost({
        hostCwd: "/host/repo",
        sandboxCwd: "/sandbox/repo",
        sessionId: id,
        handle: fsBindMountHandle(),
      });

      const hostPath = join(
        hostDir,
        cursorChatDir("/host/repo"),
        id,
        "store.db",
      );
      expect(sessionStorage.hostSessionFilePath("/host/repo", id)).toBe(
        hostPath,
      );
      await expect(readFile(hostPath)).resolves.toStrictEqual(storeBytes);
      await expect(sessionStorage.existsOnHost("/host/repo", id)).resolves.toBe(
        true,
      );
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("cursor resumeIntoSandbox copies store.db, byte for byte, under the sandbox cwd's chat dir", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-cursor-host-"));
    const sandboxDir = await mkdtemp(join(tmpdir(), "sandcastle-cursor-sbx-"));
    try {
      const id = "4f55759a-4a2d-4a14-b7a9-0dd29b8b99f8";
      const hostChat = join(hostDir, cursorChatDir("/host/repo"), id);
      await mkdir(hostChat, { recursive: true });
      await writeFile(join(hostChat, "store.db"), storeBytes);
      const { sessionStorage } = cursor("composer-2", {
        sessionStorage: { hostChatsDir: hostDir, sandboxChatsDir: sandboxDir },
      });

      await sessionStorage.resumeIntoSandbox({
        hostCwd: "/host/repo",
        sandboxCwd: "/sandbox/repo",
        sessionId: id,
        handle: fsBindMountHandle(),
      });

      await expect(
        readFile(
          join(sandboxDir, cursorChatDir("/sandbox/repo"), id, "store.db"),
        ),
      ).resolves.toStrictEqual(storeBytes);
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("cursor findByIdOnHost finds the chat under any cwd's chat dir", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-cursor-host-"));
    try {
      const id = "79e67ff9-0a70-4f70-8adb-ae8db52ae5d4";
      const chat = join(hostDir, cursorChatDir("/some/worktree"), id);
      await mkdir(chat, { recursive: true });
      await writeFile(join(chat, "store.db"), storeBytes);
      const { sessionStorage } = cursor("composer-2", {
        sessionStorage: { hostChatsDir: hostDir },
      });

      await expect(sessionStorage.findByIdOnHost(id)).resolves.toStrictEqual({
        path: join(chat, "store.db"),
        searchedRoot: hostDir,
      });
      await expect(
        sessionStorage.findByIdOnHost("missing"),
      ).resolves.toStrictEqual({ path: undefined, searchedRoot: hostDir });
    } finally {
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  /**
   * A bind-mount handle over local directories that stands in for the
   * opencode CLI: `opencode export <id>` writes `exported` to the redirect
   * target, and `opencode import <file>` records the file's content. Every
   * other command runs for real.
   */
  const opencodeHandle = (
    exported: string,
  ): {
    handle: BindMountSandboxHandle;
    commands: { command: string; cwd?: string }[];
    imported: string[];
  } => {
    const commands: { command: string; cwd?: string }[] = [];
    const imported: string[] = [];
    const base = fsBindMountHandle();
    const handle: BindMountSandboxHandle = {
      ...base,
      exec: async (command, options) => {
        commands.push({ command, cwd: options?.cwd });
        const exportTo = /^opencode export \S+ > '(?<path>[^']+)'$/u.exec(
          command,
        )?.groups?.["path"];
        if (exportTo !== undefined) {
          await writeFile(exportTo, exported);
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        const importFrom = /^opencode import '(?<path>[^']+)'$/u.exec(command)
          ?.groups?.["path"];
        if (importFrom !== undefined) {
          imported.push(await readFile(importFrom, "utf8"));
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return base.exec(command, options);
      },
    };
    return { handle, commands, imported };
  };

  it("opencode captureToHost exports the session in the sandbox and keeps the JSON on the host", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-opencode-host-"));
    const sandboxDir = await mkdtemp(
      join(tmpdir(), "sandcastle-opencode-sbx-"),
    );
    try {
      const id = "ses_e6e178a49ffeZPPT9189e5aA1p";
      const exported = JSON.stringify({ info: { id }, messages: [] });
      const { handle, commands } = opencodeHandle(exported);
      const { sessionStorage } = opencode("opencode/big-pickle", {
        sessionStorage: {
          hostSessionsDir: hostDir,
          sandboxExportDir: sandboxDir,
        },
      });

      await sessionStorage.captureToHost({
        hostCwd: "/host/repo",
        sandboxCwd: "/sandbox/repo",
        sessionId: id,
        handle,
      });

      const hostPath = join(hostDir, `${id}.json`);
      expect(sessionStorage.hostSessionFilePath("/host/repo", id)).toBe(
        hostPath,
      );
      await expect(readFile(hostPath, "utf8")).resolves.toBe(exported);
      expect(commands).toContainEqual({
        command: `opencode export '${id}' > '${join(sandboxDir, `${id}.json`)}'`,
        cwd: "/sandbox/repo",
      });
      await expect(sessionStorage.existsOnHost("/host/repo", id)).resolves.toBe(
        true,
      );
      await expect(
        sessionStorage.readHostSession("/host/repo", id),
      ).resolves.toBe(exported);
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("opencode resumeIntoSandbox copies the JSON in and imports it from the sandbox repo", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-opencode-host-"));
    const sandboxDir = await mkdtemp(
      join(tmpdir(), "sandcastle-opencode-sbx-"),
    );
    try {
      const id = "ses_e6e171324ffeeykW5t5sMlLRV4";
      const exported = JSON.stringify({ info: { id }, messages: [] });
      await writeFile(join(hostDir, `${id}.json`), exported);
      const { handle, commands, imported } = opencodeHandle("");
      const { sessionStorage } = opencode("opencode/big-pickle", {
        sessionStorage: {
          hostSessionsDir: hostDir,
          sandboxExportDir: sandboxDir,
        },
      });

      await sessionStorage.resumeIntoSandbox({
        hostCwd: "/host/repo",
        sandboxCwd: "/sandbox/repo",
        sessionId: id,
        handle,
      });

      expect(imported).toStrictEqual([exported]);
      expect(commands).toContainEqual({
        command: `opencode import '${join(sandboxDir, `${id}.json`)}'`,
        cwd: "/sandbox/repo",
      });
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(sandboxDir, { recursive: true, force: true });
    }
  });

  it("opencode captureToHost fails with the CLI's error when the export fails", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-opencode-host-"));
    try {
      const failing: BindMountSandboxHandle = {
        ...fsBindMountHandle(),
        exec: async () => ({
          stdout: "",
          stderr: "Error: Session not found: ses_missing",
          exitCode: 1,
        }),
      };
      const { sessionStorage } = opencode("opencode/big-pickle", {
        sessionStorage: { hostSessionsDir: hostDir },
      });

      await expect(
        sessionStorage.captureToHost({
          hostCwd: "/host/repo",
          sandboxCwd: "/sandbox/repo",
          sessionId: "ses_missing",
          handle: failing,
        }),
      ).rejects.toThrow(/Session not found: ses_missing/u);
    } finally {
      await rm(hostDir, { recursive: true, force: true });
    }
  });
});

describe("errors the agent reports in its own stream", () => {
  it("pi: agent_end whose last assistant message stopped with an error emits an error event", () => {
    // Shape of pi 0.73.1's agent_end when the API rejects the request (here:
    // claude-haiku-5-5 rejecting pi's default thinking). pi still exits 0.
    const line = JSON.stringify({
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "do it" }] },
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: String.raw`400 {"type":"error","error":{"type":"invalid_request_error","message":"\"thinking.type.enabled\" is not supported for this model."}}`,
        },
      ],
    });
    expect(
      pi("anthropic/claude-haiku-5-5").parseStreamLine(line),
    ).toStrictEqual([
      {
        type: "error",
        message: String.raw`400 {"type":"error","error":{"type":"invalid_request_error","message":"\"thinking.type.enabled\" is not supported for this model."}}`,
      },
    ]);
  });

  it("pi: agent_end with stopReason error but no errorMessage still emits an error event", () => {
    const line = JSON.stringify({
      type: "agent_end",
      messages: [{ role: "assistant", content: [], stopReason: "error" }],
    });
    expect(pi("m").parseStreamLine(line)).toStrictEqual([
      { type: "error", message: 'pi stopped with stopReason "error"' },
    ]);
  });

  it("pi: a normal agent_end still emits only the result", () => {
    const line = JSON.stringify({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
        },
      ],
    });
    expect(pi("m").parseStreamLine(line)).toStrictEqual([
      { type: "result", result: "done" },
    ]);
  });

  it("claudeCode: a result with is_error emits an error event", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "API Error: 400 invalid model",
    });
    expect(claudeCode("m").parseStreamLine(line)).toStrictEqual([
      { type: "error", message: "API Error: 400 invalid model" },
    ]);
  });

  it("claudeCode: a successful result is unchanged", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
    });
    expect(claudeCode("m").parseStreamLine(line)).toStrictEqual([
      { type: "result", result: "done" },
    ]);
  });

  it("cursor: a result with is_error emits an error event", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      result: "Model not available",
    });
    expect(cursor("m").parseStreamLine(line)).toStrictEqual([
      { type: "error", message: "Model not available" },
    ]);
  });

  it("codex: turn.failed emits an error event", () => {
    const line = JSON.stringify({
      type: "turn.failed",
      error: { message: "unexpected status 400 Bad Request" },
    });
    expect(codex("m").parseStreamLine(line)).toStrictEqual([
      { type: "error", message: "unexpected status 400 Bad Request" },
    ]);
  });

  it("opencode: an error event (exit 0 in opencode 1.3.13) emits an error event", () => {
    const line = JSON.stringify({
      type: "error",
      sessionID: "ses_x",
      error: {
        name: "UnknownError",
        data: { message: "Model not found: anthropic/claude-nonexistent-9." },
      },
    });
    expect(opencode("m").parseStreamLine(line)).toStrictEqual([
      {
        type: "error",
        message: "Model not found: anthropic/claude-nonexistent-9.",
      },
    ]);
  });

  it("copilot: an error event emits an error event", () => {
    const line = JSON.stringify({ type: "error", error: "boom" });
    expect(copilot("m").parseStreamLine(line)).toStrictEqual([
      { type: "error", message: "boom" },
    ]);
  });
});
