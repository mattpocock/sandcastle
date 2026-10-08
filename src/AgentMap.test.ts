import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentMap, startDashboard } from "./AgentMap.js";
import { run, type LoggingOption } from "./run.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";
import type { AgentProvider } from "./AgentProvider.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.reverse()) await dispose();
  cleanup.length = 0;
  vi.useRealTimers();
});

it("persists a distinct readiness phase and serves a dashboard that renders it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "readiness-map-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const map = await createAgentMap({ cwd, name: "Readiness" });
  cleanup.push(() => map.finish("completed"));
  await map.track(
    {
      batch: 1,
      role: "readiness",
      title: "Readiness / startup / report-only",
      branch: "main",
    },
    async (logging) => {
      if (logging.type === "file")
        logging.onAgentStreamEvent?.({
          type: "text",
          message: "#20 blocked: live gate pending",
          iteration: 1,
          timestamp: new Date(),
        });
      return { completionSignal: "<promise>COMPLETE</promise>", commits: [] };
    },
  );
  await map.finish("completed");
  const server = await startDashboard({ cwd, port: 0 });
  cleanup.push(server.close);
  const snapshot = await fetch(`${server.url}/api/runs/${map.id}`).then((r) =>
    r.json(),
  );
  expect(snapshot).toMatchObject({
    nodes: [
      expect.objectContaining({
        role: "readiness",
        status: "completed",
        activity: expect.arrayContaining([
          expect.objectContaining({ text: "#20 blocked: live gate pending" }),
        ]),
      }),
    ],
  });
  const script = await fetch(`${server.url}/app.js`).then((r) => r.text());
  expect(script).toContain("Readiness");
  expect(script).toContain("n.role==='readiness'");
});

it("observes parallel agents, their activity and outcomes without confusing BLOCKED with success", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-map-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const map = await createAgentMap({ cwd, name: "Parallel" });
  cleanup.push(() => map.finish("completed"));
  const server = await startDashboard({ cwd, port: 0 });
  cleanup.push(server.close);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  cleanup.push(async () => {
    release();
  });
  let started = 0;
  let bothStarted!: () => void;
  const ready = new Promise<void>((resolve) => {
    bothStarted = resolve;
  });
  const execute = async (logging: LoggingOption) => {
    if (logging.type === "file") {
      logging.onAgentStreamEvent?.({
        type: "toolCall",
        name: "Bash",
        formattedArgs: "npm test",
        iteration: 1,
        timestamp: new Date(),
      });
      logging.onAgentStreamEvent?.({
        type: "text",
        message: "Authorization: Bearer example-secret",
        iteration: 1,
        timestamp: new Date(),
      });
    }
    if (++started === 2) bothStarted();
    await pending;
    return {
      completionSignal: "<promise>BLOCKED</promise>",
      commits: [],
      iterations: [],
    };
  };
  const work = ["38", "40"].map((issueId) =>
    map.track(
      {
        batch: 1,
        role: "implementer",
        issueId,
        title: `Issue ${issueId}`,
        branch: `sandcastle/issue-${issueId}`,
      },
      execute,
    ),
  );
  await ready;
  const running = await fetch(`${server.url}/api/runs/${map.id}`).then((r) =>
    r.json(),
  );
  expect(running).toMatchObject({
    nodes: [{ status: "running" }, { status: "running" }],
  });
  release();
  const results = await Promise.all(work);
  expect(results[0]?.completionSignal).toBe("<promise>BLOCKED</promise>");
  const done = await fetch(`${server.url}/api/runs/${map.id}`).then((r) =>
    r.json(),
  );
  expect(done).toMatchObject({
    nodes: [
      {
        status: "blocked",
        activity: expect.arrayContaining([
          expect.objectContaining({ type: "toolCall", text: "Bash: npm test" }),
        ]),
      },
      { status: "blocked" },
    ],
  });
  expect(JSON.stringify(done)).not.toContain("example-secret");
  expect(JSON.stringify(done)).not.toContain('"usage"');
});

it("shows a recorded batch and its deferred issues through the dashboard after reopening", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-map-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const map = await createAgentMap({ cwd, name: "SEO" });
  cleanup.push(() => map.finish("completed"));
  await map.recordPlan(1, {
    issues: [{ id: "38", title: "Benchmark", branch: "sandcastle/issue-38" }],
    decisions: [
      {
        id: "38",
        disposition: "selected",
        reason: "Independent benchmark",
        likelyAreas: ["benchmarks"],
      },
      {
        id: "39",
        disposition: "blocked",
        reason: "Depends on #38",
        likelyAreas: ["connectors"],
      },
    ],
  });
  await map.finish("completed");
  const server = await startDashboard({ cwd, port: 0 });
  cleanup.push(server.close);
  const snapshot = await fetch(`${server.url}/api/runs/${map.id}`).then((r) =>
    r.json(),
  );
  expect(snapshot).toMatchObject({
    name: "SEO",
    batches: [
      {
        decisions: expect.arrayContaining([
          expect.objectContaining({ id: "39", reason: "Depends on #38" }),
        ]),
      },
    ],
    nodes: expect.arrayContaining([
      expect.objectContaining({
        role: "implementer",
        issueId: "38",
        branch: "sandcastle/issue-38",
      }),
      expect.objectContaining({ role: "reviewer", issueId: "38" }),
      expect.objectContaining({ role: "merger", batch: 1 }),
    ]),
  });
  const listing = await fetch(`${server.url}/api/runs`).then((r) => r.json());
  expect(listing).toMatchObject({
    runs: expect.arrayContaining([
      expect.objectContaining({ id: map.id, status: "completed" }),
    ]),
  });
});

it("serves a read-only browser map and rejects remote origins and file-path requests", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-map-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const server = await startDashboard({ cwd, port: 0 });
  cleanup.push(server.close);
  const page = await fetch(server.url);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Agent map");
  expect(page.headers.get("content-security-policy")).toContain(
    "default-src 'self'",
  );
  expect(
    (await fetch(`${server.url}/api/runs`, { method: "POST" })).status,
  ).toBe(405);
  expect(
    (
      await fetch(`${server.url}/api/runs`, {
        headers: { Origin: "https://attacker.example" },
      })
    ).status,
  ).toBe(403);
  const hostileHostStatus = await new Promise<number | undefined>(
    (resolve, reject) => {
      get(
        `${server.url}/api/runs`,
        { headers: { Host: "attacker.example" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      ).on("error", reject);
    },
  );
  expect(hostileHostStatus).toBe(403);
  expect((await fetch(`${server.url}/api/runs/%2e%2e%2f.env`)).status).toBe(
    404,
  );
});

it("reports stale heartbeat as unknown, not proof that an orchestrator died", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-map-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const map = await createAgentMap({ cwd, name: "Interrupted" });
  cleanup.push(() => map.finish("failed"));
  const server = await startDashboard({ cwd, port: 0 });
  cleanup.push(server.close);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 60_000);
  const snapshot = await fetch(`${server.url}/api/runs/${map.id}`).then((r) =>
    r.json(),
  );
  expect(snapshot).toMatchObject({ status: "unknown", heartbeat: "stale" });
  vi.useRealTimers();
  const live = await fetch(`${server.url}/api/runs/${map.id}`).then((r) =>
    r.json(),
  );
  expect(live).toMatchObject({ status: "running", heartbeat: "fresh" });
});

it("records real run() streaming and the provider's final usage without needing Docker", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-map-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "-b", "main"], { cwd });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    { cwd },
  );
  const map = await createAgentMap({ cwd, name: "Runtime boundary" });
  cleanup.push(() => map.finish("completed"));
  const server = await startDashboard({ cwd, port: 0 });
  cleanup.push(server.close);
  const agent: AgentProvider = {
    name: "scripted-agent",
    env: {},
    captureSessions: false,
    buildPrintCommand: () => ({
      command: `node -e 'console.log("<promise>COMPLETE</promise>")'`,
    }),
    parseStreamLine: (text) => [
      { type: "text", text },
      {
        type: "usage",
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          cacheReadInputTokens: 60,
          cacheCreationInputTokens: 0,
        },
      },
    ],
  };
  await map.track(
    {
      batch: 1,
      role: "implementer",
      title: "Scripted agent",
      branch: "main",
      provider: agent.name,
    },
    (logging) =>
      run({
        cwd,
        agent,
        sandbox: noSandbox(),
        prompt: "Return completion",
        logging,
      }),
  );
  const snapshot = await fetch(`${server.url}/api/runs/${map.id}`).then((r) =>
    r.json(),
  );
  expect(snapshot).toMatchObject({
    nodes: [
      {
        status: "completed",
        provider: "scripted-agent",
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          cacheReadInputTokens: 60,
          cacheCreationInputTokens: 0,
        },
        activity: expect.arrayContaining([
          expect.objectContaining({ text: "<promise>COMPLETE</promise>" }),
        ]),
      },
    ],
  });
});

it("preserves the original agent error and reports failure, while no completion signal means stopped", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-map-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const map = await createAgentMap({ cwd, name: "Failures" });
  cleanup.push(() => map.finish("failed"));
  const server = await startDashboard({ cwd, port: 0 });
  cleanup.push(server.close);
  const failure = new Error("Sandbox unavailable");
  await expect(
    map.track(
      { batch: 1, role: "implementer", title: "Failed", branch: "main" },
      async () => {
        throw failure;
      },
    ),
  ).rejects.toBe(failure);
  await map.track(
    { batch: 1, role: "reviewer", title: "Iteration limit", branch: "main" },
    async () => ({ commits: [] }),
  );
  const snapshot = await fetch(`${server.url}/api/runs/${map.id}`).then((r) =>
    r.json(),
  );
  expect(snapshot).toMatchObject({
    nodes: [
      { status: "failed", error: "Error: Sandbox unavailable" },
      { status: "stopped" },
    ],
  });
});

it("uses the reported branch and last available usage when the final iteration omits usage", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-map-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const map = await createAgentMap({ cwd, name: "Metadata" });
  cleanup.push(() => map.finish("completed"));
  const server = await startDashboard({ cwd, port: 0 });
  cleanup.push(server.close);
  const usage = {
    inputTokens: 12,
    outputTokens: 3,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  await map.track(
    { batch: 1, role: "planner", title: "Plan", branch: "main" },
    async () => ({
      branch: "integration",
      iterations: [{ usage, sessionId: "first" }, { sessionId: "last" }],
    }),
  );
  const snapshot = await fetch(`${server.url}/api/runs/${map.id}`).then((r) =>
    r.json(),
  );
  expect(snapshot).toMatchObject({
    nodes: [{ branch: "integration", usage, sessionId: "last" }],
  });
});

it("continues executing without file logging when recording storage is unavailable", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-map-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, ".sandcastle"), "not a directory");
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  cleanup.push(async () => warning.mockRestore());
  const map = await createAgentMap({ cwd, name: "Unavailable storage" });
  cleanup.push(() => map.finish("completed"));
  const expected = { completionSignal: "<promise>COMPLETE</promise>" };
  const result = await map.track(
    { batch: 1, role: "implementer", title: "Still executes", branch: "main" },
    async (logging) => {
      expect(logging.type).toBe("stdout");
      return expected;
    },
  );
  expect(result).toBe(expected);
  expect(warning).toHaveBeenCalledTimes(1);
});
