import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, describe, expect, it } from "vitest";
import {
  claudeCode,
  codex,
  copilot,
  cursor,
  opencode,
  pi,
} from "./AgentProvider.js";
import type { AgentProvider } from "./AgentProvider.js";
import {
  buildContextWindowLines,
  formatContextWindow,
} from "./ContextWindow.js";
import type { ContextWindow } from "./ContextWindow.js";

/**
 * The fixtures are real stdout lines (and one real codex rollout) kept from
 * the 2026-10-31 verify runs against sandcastle@4518681 (one iteration each,
 * two for opencode), with only very long prose lines dropped. The "last call" and "total"
 * figures in each test are read off those same lines.
 */
const fixture = (name: string): string =>
  readFileSync(
    join(import.meta.dirname, "__fixtures__", "context-window", name),
    "utf8",
  );

/** Every context_window event the provider's stream parser emits, in order. */
const streamContextWindows = (
  provider: AgentProvider,
  name: string,
): ContextWindow[] =>
  fixture(name)
    .split("\n")
    .flatMap((line) => provider.parseStreamLine(line))
    .flatMap((e) => (e.type === "context_window" ? [e.contextWindow] : []));

describe("context window from real agent output", () => {
  it("claudeCode: last assistant message usage, not the cumulative result usage", () => {
    const events = streamContextWindows(
      claudeCode("claude-haiku-5-5"),
      "claude-code.stream.jsonl",
    );
    // Call 1: 1977 + 5670 + 23816. Call 2 (last): 2 + 17145 + 29486.
    expect(events.at(0)).toStrictEqual({ tokens: 31_463 });
    expect(events.at(-1)).toStrictEqual({ tokens: 46_633 });
    // result.usage sums every call of the turn: 1979 + 22815 + 53302.
    expect(events.map((e) => e.tokens)).not.toContain(78_096);
  });

  it("codex: the stream's turn.completed total is never used", () => {
    const events = streamContextWindows(
      codex("gpt-6-luna"),
      "codex.stream.jsonl",
    );
    // turn.completed.usage.input_tokens is 174409, the sum of 7 requests.
    expect(events).toStrictEqual([]);
  });

  it("codex: the session's last token_count gives the last request and the model limit", () => {
    const provider = codex("gpt-6-luna");
    assert(provider.parseSessionContextWindow !== undefined);
    expect(
      provider.parseSessionContextWindow(fixture("codex.session.jsonl")),
    ).toStrictEqual({ tokens: 31_899, limit: 258_400 });
  });

  it("pi: last assistant message_end usage, not agent_end summed", () => {
    const events = streamContextWindows(
      pi("anthropic/claude-haiku-5-5"),
      "pi.stream.jsonl",
    );
    // Call 1: 4 + 0 + 2190. Call 2 (last): 2 + 2190 + 17694.
    expect(events.at(0)).toStrictEqual({ tokens: 2194 });
    expect(events.at(-1)).toStrictEqual({ tokens: 19_886 });
    // Summing agent_end.messages[] usage gives 2194 + 19886.
    expect(events.map((e) => e.tokens)).not.toContain(22_080);
  });

  it("opencode: last step_finish input + cache.read + cache.write", () => {
    const events = streamContextWindows(
      opencode("opencode/big-pickle"),
      "opencode.stream.jsonl",
    );
    // Two iterations of two calls: 6727 + 1814, then 12492 + 8511 + 0 (last
    // of iteration 1); 8541, then 12460 + 8511 (last of iteration 2).
    expect(events).toStrictEqual([
      { tokens: 8541 },
      { tokens: 21_003 },
      { tokens: 8541 },
      { tokens: 20_971 },
    ]);
  });

  it("copilot: lastCallInputTokens, not modelMetrics inputTokens", () => {
    const events = streamContextWindows(
      copilot("claude-haiku-4.5"),
      "copilot.stream.jsonl",
    );
    expect(events).toStrictEqual([{ tokens: 18_190 }]);
    // modelMetrics[...].usage.inputTokens is 35908, summed over both calls.
  });

  it("cursor: only a whole-turn total exists, so no context window is reported", () => {
    const events = streamContextWindows(
      cursor("composer-2"),
      "cursor.stream.jsonl",
    );
    // result.usage is summed over the turn's calls (20491 input, 16768 cache read).
    expect(events).toStrictEqual([]);
    expect(cursor("composer-2").parseSessionContextWindow).toBeUndefined();
  });
});

describe("formatContextWindow", () => {
  it("rounds tokens up to the next 1k", () => {
    expect(formatContextWindow({ tokens: 46_633 })).toBe("47k");
  });

  it("shows the limit, rounded down, when known", () => {
    expect(formatContextWindow({ tokens: 31_899, limit: 258_400 })).toBe(
      "32k / 258k",
    );
  });
});

describe("buildContextWindowLines", () => {
  it("returns one line per iteration with a context window", () => {
    expect(
      buildContextWindowLines([
        { contextWindow: { tokens: 46_633 } },
        {},
        { contextWindow: { tokens: 33_989, limit: 258_400 } },
      ]),
    ).toStrictEqual(["Context window: 47k", "Context window: 34k / 258k"]);
  });

  it("returns no lines when no iteration has one", () => {
    expect(buildContextWindowLines([{}, {}])).toStrictEqual([]);
  });
});
