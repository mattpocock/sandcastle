import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowRunNotFoundError } from "./errors.js";
import type {
  WorkflowAgentJournalEntry,
  WorkflowEvent,
  WorkflowMeta,
  WorkflowRunState,
} from "./types.js";
import { WorkflowRunStore } from "./WorkflowRunStore.js";

const meta: WorkflowMeta = {
  name: "Ship Workflow!",
  description: "Test workflow",
};

const makeStore = (cwd: string): WorkflowRunStore =>
  new WorkflowRunStore({
    cwd,
    now: () => new Date("2026-07-04T10:11:12.000Z"),
    random: () => "ABC12345",
  });

const journalEntry = (
  overrides: Partial<WorkflowAgentJournalEntry> = {},
): WorkflowAgentJournalEntry => ({
  callId: "call-1",
  callIndex: 0,
  callHash: "call-hash",
  label: "Implement",
  promptHash: "prompt-hash",
  status: "running",
  startedAt: "2026-07-04T10:11:12.000Z",
  branch: "sandcastle/workflows/call-1",
  commits: [],
  ...overrides,
});

describe("WorkflowRunStore", () => {
  it("creates a sortable run id and run directory under the default root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-run-store-"));
    try {
      const store = makeStore(dir);

      const state = await store.createRun({ meta });

      expect(state.id).toBe("20260704-101112-ship-workflow-abc12345");
      expect(store.runsRoot).toBe(join(dir, ".sandcastle", "runs"));
      await expect(access(store.getRunDir(state.id))).resolves.toBeUndefined();
      expect(
        JSON.parse(
          await readFile(join(store.getRunDir(state.id), "meta.json"), "utf8"),
        ),
      ).toEqual(meta);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes and reads state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-run-store-"));
    try {
      const store = makeStore(dir);
      const state = await store.createRun({
        meta,
        maxAgents: 4,
        concurrency: 2,
      });
      const nextState: WorkflowRunState = {
        ...state,
        status: "running",
        currentPhase: "Plan",
        agentCount: 1,
      };

      await store.writeState(nextState);

      expect(await store.readState(state.id)).toEqual(nextState);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("appends events in order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-run-store-"));
    try {
      const store = makeStore(dir);
      const state = await store.createRun({ meta });
      const first: WorkflowEvent = {
        timestamp: "2026-07-04T10:11:12.000Z",
        type: "started",
      };
      const second: WorkflowEvent = {
        timestamp: "2026-07-04T10:11:13.000Z",
        type: "phase",
        message: "Planning",
      };

      await store.appendEvent(state.id, first);
      await store.appendEvent(state.id, second);

      expect(await store.readEvents(state.id)).toEqual([first, second]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("appends journal entries in order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-run-store-"));
    try {
      const store = makeStore(dir);
      const state = await store.createRun({ meta });
      const first = journalEntry();
      const second = journalEntry({
        callId: "call-2",
        callIndex: 1,
        status: "succeeded",
        finishedAt: "2026-07-04T10:12:00.000Z",
        commits: [{ sha: "abc123" }],
      });

      await store.appendJournal(state.id, first);
      await store.appendJournal(state.id, second);

      expect(await store.readJournal(state.id)).toEqual([first, second]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes per-agent artifact paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-run-store-"));
    try {
      const store = makeStore(dir);
      const state = await store.createRun({ meta });

      const promptPath = await store.writeAgentArtifact(
        state.id,
        "call-1",
        "prompt",
        "# Prompt\n",
      );
      const resultPath = await store.writeAgentArtifact(
        state.id,
        "call-1",
        "result",
        { ok: true },
      );

      expect(promptPath).toBe(
        join(store.getRunDir(state.id), "agents", "call-1", "prompt.md"),
      );
      expect(resultPath).toBe(
        join(store.getRunDir(state.id), "agents", "call-1", "result.json"),
      );
      expect(await readFile(promptPath, "utf8")).toBe("# Prompt\n");
      expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({
        ok: true,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("atomic state writes leave valid JSON after repeated writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-run-store-"));
    try {
      const store = makeStore(dir);
      const state = await store.createRun({ meta });

      for (let index = 0; index < 25; index++) {
        await store.writeState({
          ...state,
          status: index === 24 ? "succeeded" : "running",
          agentCount: index,
        });
      }

      const statePath = join(store.getRunDir(state.id), "state.json");
      const written = JSON.parse(await readFile(statePath, "utf8"));
      expect(written).toMatchObject({
        id: state.id,
        status: "succeeded",
        agentCount: 24,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws WorkflowRunNotFoundError for missing runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-run-store-"));
    try {
      const store = makeStore(dir);

      await expect(store.readState("missing-run")).rejects.toBeInstanceOf(
        WorkflowRunNotFoundError,
      );
      await expect(
        store.appendEvent("missing-run", {
          timestamp: "2026-07-04T10:11:12.000Z",
          type: "started",
        }),
      ).rejects.toBeInstanceOf(WorkflowRunNotFoundError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stores a workflow source copy at run start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-run-store-"));
    try {
      const sourceFile = join(dir, "workflow.ts");
      await writeFile(sourceFile, "export default {}\n");
      const store = makeStore(dir);

      const state = await store.createRun({ meta, sourceFile });

      expect(
        await readFile(join(store.getRunDir(state.id), "workflow.ts"), "utf8"),
      ).toBe("export default {}\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes and reads result and error files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-run-store-"));
    try {
      const store = makeStore(dir);
      const state = await store.createRun({ meta });

      await store.writeResult(state.id, { complete: true });
      await store.writeError(state.id, new Error("boom"));

      expect(await store.readResult(state.id)).toEqual({ complete: true });
      expect(await store.readError(state.id)).toContain("boom");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
