import { describe, expect, it } from "vitest";
import { RunSupervisor } from "../src/runs/RunSupervisor.js";
import { SqliteStore } from "../src/telemetry/SqliteStore.js";
import { fakeAgent, makeRepo, waitFor } from "./helpers.js";

describe("RunSupervisor", () => {
  it("starts a real host-bind-mount run and forwards events", async () => {
    const repo = makeRepo();
    const store = new SqliteStore(repo);
    try {
      const supervisor = new RunSupervisor({
        repoRoot: repo,
        store,
        agentFactory: () => fakeAgent(),
      });
      const seen: string[] = [];
      supervisor.subscribe((_runId, event) => seen.push(event.type));

      const { runId } = await supervisor.startRun({ directive: "do it" });
      await waitFor(() => seen.includes("run.resolved"));

      expect(seen).toContain("text");
      expect(seen).toContain("tool.started");
      expect(seen).toContain("tool.finished");
      expect(supervisor.getRun(runId)?.status).toBe("victory");
      expect(store.listEvents(runId).length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  }, 10000);

  it("cancels an in-flight run", async () => {
    const repo = makeRepo();
    const store = new SqliteStore(repo);
    try {
      const supervisor = new RunSupervisor({
        repoRoot: repo,
        store,
        agentFactory: () => fakeAgent({ delayMs: 1000 }),
      });
      const seen: string[] = [];
      supervisor.subscribe((_runId, event) => seen.push(event.type));

      const { runId } = await supervisor.startRun({ directive: "do it" });
      expect(supervisor.cancelRun(runId)).toBe(true);
      await waitFor(() => supervisor.getRun(runId)?.status === "aborted");

      expect(seen).toContain("intervention.used");
      expect(seen).toContain("run.resolved");
    } finally {
      store.close();
    }
  }, 10000);
});
