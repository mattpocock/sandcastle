import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeWorkflowName } from "./sanitizeWorkflowName.js";
import { WorkflowEventLog } from "./WorkflowEventLog.js";
import type { WorkflowEvent } from "./types.js";

describe("sanitizeWorkflowName", () => {
  it("lowercases names and collapses whitespace", () => {
    expect(sanitizeWorkflowName("My Useful Workflow")).toBe(
      "my-useful-workflow",
    );
  });

  it("collapses punctuation and trims separators", () => {
    expect(sanitizeWorkflowName(" -- Ship: Plan / Review!! -- ")).toBe(
      "ship-plan-review",
    );
  });

  it("falls back for empty names", () => {
    expect(sanitizeWorkflowName("")).toBe("workflow");
    expect(sanitizeWorkflowName("!!!")).toBe("workflow");
  });
});

describe("WorkflowEventLog", () => {
  it("appends events in order as JSONL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-event-log-"));
    try {
      const log = new WorkflowEventLog<WorkflowEvent>(
        join(dir, "events.jsonl"),
      );
      const first: WorkflowEvent = {
        timestamp: "2026-07-04T10:00:00.000Z",
        type: "started",
        message: "Started",
      };
      const second: WorkflowEvent = {
        timestamp: "2026-07-04T10:00:01.000Z",
        type: "phase",
        details: { phase: "review" },
      };

      await log.append(first);
      await log.append(second);

      expect(await log.readAll()).toEqual([first, second]);
      expect(await readFile(join(dir, "events.jsonl"), "utf8")).toBe(
        `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty list when the log file does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-event-log-"));
    try {
      const log = new WorkflowEventLog<WorkflowEvent>(
        join(dir, "missing.jsonl"),
      );

      expect(await log.readAll()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
