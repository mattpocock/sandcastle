import { describe, expect, it } from "vitest";
import { SqliteStore } from "../src/telemetry/SqliteStore.js";
import { makeRepo } from "./helpers.js";
import type { Run, RunEvent } from "@sandcastle/protocol";

const runFixture = (id = "run_123"): Run => ({
  id,
  planetId: "planet-local",
  operativeId: "pi-default",
  provider: "codex",
  sandboxProvider: "no-sandbox",
  status: "starting",
  directive: "do it",
  branch: "main",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: null,
  phaseIds: [],
  currentPhaseId: null,
  verification: { allGreen: false, failedChecks: [] },
  totals: { toolCalls: 0, filesEdited: 0, commandsRun: 0 },
});

const eventFixture: RunEvent = {
  type: "run.started",
  runId: "run_123",
  directive: "do it",
  branch: "main",
  iteration: 0,
  timestamp: new Date("2026-01-01T00:00:00.000Z"),
};

describe("SqliteStore", () => {
  it("creates schema and upserts runs", () => {
    const store = new SqliteStore(makeRepo());
    try {
      const run = runFixture();
      store.upsertRun(run);
      expect(store.getRun(run.id)).toEqual(run);

      const updated = {
        ...run,
        status: "victory" as const,
        endedAt: "2026-01-01T00:01:00.000Z",
      };
      store.upsertRun(updated);
      expect(store.getRun(run.id)).toEqual(updated);
    } finally {
      store.close();
    }
  });

  it("appends events with sequence numbers", () => {
    const store = new SqliteStore(makeRepo());
    try {
      store.upsertRun(runFixture());
      expect(store.appendEvent("run_123", eventFixture)).toBe(1);
      expect(
        store.appendEvent("run_123", {
          ...eventFixture,
          type: "text",
          message: "hello",
        }),
      ).toBe(2);
      expect(store.listEvents("run_123").map((entry) => entry.seq)).toEqual([
        1, 2,
      ]);
    } finally {
      store.close();
    }
  });

  it("replays persisted runs and events on load", () => {
    const repo = makeRepo();
    const first = new SqliteStore(repo);
    first.upsertRun(runFixture());
    first.appendEvent("run_123", eventFixture);
    first.close();

    const second = new SqliteStore(repo);
    try {
      expect(second.listRuns()).toEqual([runFixture()]);
      expect(second.listEvents("run_123")[0]?.event).toEqual(eventFixture);
      expect(second.appendEvent("run_123", eventFixture)).toBe(2);
    } finally {
      second.close();
    }
  });
});
