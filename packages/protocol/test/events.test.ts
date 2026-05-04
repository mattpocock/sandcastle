import { describe, expect, it } from "vitest";
import { zRunEvent, type RunEvent } from "../src/index.js";

const timestamp = new Date("2026-01-01T00:00:00.000Z");

const events: RunEvent[] = [
  { type: "text", message: "hello", iteration: 1, timestamp },
  {
    type: "toolCall",
    name: "Bash",
    formattedArgs: "npm test",
    iteration: 1,
    timestamp,
  },
  {
    type: "run.started",
    runId: "run_123",
    directive: "do it",
    branch: "main",
    worktreePath: "/tmp/wt",
    iteration: 0,
    timestamp,
  },
  {
    type: "run.statusChanged",
    runId: "run_123",
    from: "starting",
    to: "casting",
    iteration: 1,
    timestamp,
  },
  {
    type: "tool.started",
    name: "Bash",
    formattedArgs: "npm test",
    toolCallId: "tool_1",
    iteration: 1,
    timestamp,
  },
  {
    type: "tool.finished",
    name: "Bash",
    toolCallId: "tool_1",
    durationMs: 12,
    ok: true,
    output: "ok",
    iteration: 1,
    timestamp,
  },
  {
    type: "verification.started",
    checks: ["npm test"],
    iteration: 1,
    timestamp,
  },
  {
    type: "verification.finished",
    allGreen: false,
    failedChecks: ["npm test"],
    failedPhaseId: "phase_1",
    iteration: 1,
    timestamp,
  },
  {
    type: "phase.started",
    runId: "run_123",
    phaseId: "phase_1",
    phase: {
      id: "phase_1",
      runId: "run_123",
      ordinal: 1,
      title: "Test",
      directiveSlice: "Test it",
      objective: "Test it",
      xpEstimate: 75,
      verifyRules: [{ kind: "tests", pattern: "all" }],
      status: "active",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: null,
    },
    iteration: 1,
    timestamp,
  },
  {
    type: "phase.verifying",
    runId: "run_123",
    phaseId: "phase_1",
    rules: [{ kind: "tests", pattern: "all" }],
    iteration: 1,
    timestamp,
  },
  {
    type: "phase.verified",
    runId: "run_123",
    phaseId: "phase_1",
    results: [
      {
        rule: { kind: "tests", pattern: "all" },
        ok: true,
        output: "ok",
        durationMs: 10,
      },
    ],
    iteration: 1,
    timestamp,
  },
  {
    type: "phase.failed",
    runId: "run_123",
    phaseId: "phase_1",
    results: [
      {
        rule: { kind: "tests", pattern: "all" },
        ok: false,
        output: "fail",
        durationMs: 10,
      },
    ],
    iteration: 1,
    timestamp,
  },
  { type: "decision.required", kind: "merge", iteration: 1, timestamp },
  {
    type: "run.resolved",
    runId: "run_123",
    result: "victory",
    xpDelta: 0,
    iteration: 1,
    timestamp,
  },
  { type: "intervention.used", action: "abort", iteration: 1, timestamp },
];

describe("RunEvent schema", () => {
  it.each(events)("parses $type", (event) => {
    expect(zRunEvent.parse(event)).toEqual(event);
  });

  it("coerces ISO timestamp strings", () => {
    const parsed = zRunEvent.parse({
      type: "text",
      message: "hello",
      iteration: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    expect(parsed.timestamp).toEqual(timestamp);
  });

  it("rejects unknown event types", () => {
    expect(() =>
      zRunEvent.parse({ type: "unknown", iteration: 1, timestamp }),
    ).toThrow();
  });

  it("rejects malformed payloads", () => {
    expect(() =>
      zRunEvent.parse({
        type: "run.statusChanged",
        runId: "run_123",
        from: "starting",
        to: "bogus",
        iteration: 1,
        timestamp,
      }),
    ).toThrow();
  });
});
