import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import * as sdk from "./index.js";
const roots: string[] = [];
afterEach(async () => {
  for (const cwd of roots.splice(0))
    await rm(cwd, { recursive: true, force: true });
});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-settings-"));
  roots.push(cwd);
  await mkdir(join(cwd, ".sandcastle"));
  await writeFile(
    join(cwd, ".sandcastle/CODING_STANDARDS.md"),
    "project standards",
  );
  await writeFile(
    join(cwd, ".sandcastle/readiness.json"),
    JSON.stringify({
      mode: "report-only",
      repository: null,
      scopeLabel: "Sandcastle",
      readyLabel: "ready-for-agent",
      blockedLabel: "blocked",
      holdLabels: ["readiness:hold"],
      verifyCommand: null,
      qualificationLabel: "project-qualification",
      publishBody: true,
    }),
  );
  return cwd;
}
test("workflow settings persist without changing project standards or qualification adapters", async () => {
  const cwd = await fixture();
  const before = await readFile(
    join(cwd, ".sandcastle/readiness.json"),
    "utf8",
  );
  const initial = await sdk.loadWorkflowConfig({ cwd });
  expect(initial.readiness.mode).toBe("report-only");
  expect(initial.repository).toBeNull();
  const saved = await sdk.saveWorkflowConfig({
    cwd,
    config: {
      ...initial,
      repository: "owner/project",
      limits: { ...initial.limits, concurrency: 2, cycles: 1 },
    },
  });
  expect(await sdk.loadWorkflowConfig({ cwd })).toEqual(saved);
  expect(saved.revision).not.toBe(initial.revision);
  expect(await readFile(join(cwd, ".sandcastle/readiness.json"), "utf8")).toBe(
    before,
  );
  expect(
    await readFile(join(cwd, ".sandcastle/CODING_STANDARDS.md"), "utf8"),
  ).toBe("project standards");
  expect(
    (await sdk.loadWorkflowConfig({ cwd: await fixture() })).repository,
  ).toBeNull();
});

test("invalid workflow settings are atomic through the project-scoped HTTP interface", async () => {
  const cwd = await fixture();
  const server = await sdk.startOperator({
    cwd,
    port: 0,
    adapter: {
      promptFiles: {
        planner: null,
        implementer: null,
        reviewer: null,
        merger: null,
        readiness: null,
      },
      sandboxIdentity: async () => "fake-image",
      run: async () => {},
    },
  });
  try {
    const cookie = (await fetch(server.url)).headers
      .get("set-cookie")!
      .split(";")[0]!;
    const headers = {
      cookie,
      origin: server.url,
      "content-type": "application/json",
    };
    const response = await fetch(server.url + "/api/workflow");
    expect(response.status).toBe(200);
    const initial = await sdk.loadWorkflowConfig({ cwd });
    for (const change of [
      { repository: "https://github.com/owner/project" },
      { repository: "bad_owner/project" },
      { repository: "owner-/project" },
      { repository: "bad--owner/project" },
      { repository: "a".repeat(40) + "/project" },
      { repository: "owner/" + "a".repeat(101) },
      { repository: "owner/.." },
      { scopeLabel: "bad\nlabel" },
      { readyLabel: initial.blockedLabel },
      { holdLabels: [initial.readyLabel] },
      { readyLabel: "readiness:hold" },
      { blockedLabel: "readiness:hold" },
      { scopeLabel: "readiness:hold" },
      { readyLabel: "project-qualification" },
      { blockedLabel: "project-qualification" },
      { scopeLabel: "project-qualification" },
      { holdLabels: ["project-qualification"] },
      { limits: { ...initial.limits, cycles: 0 } },
      { limits: { ...initial.limits, concurrency: 1.5 } },
      { limits: { ...initial.limits, plannerAttempts: 11 } },
      { readiness: { mode: "apply", verifier: null, gates: [] } },
      { readiness: { mode: "report-only", verifier: "invented", gates: [] } },
      {
        readiness: { mode: "report-only", verifier: null, gates: ["invented"] },
      },
      { command: "echo secret-value" },
      { credentials: "secret-value" },
    ]) {
      const invalid = await fetch(server.url + "/api/workflow", {
        method: "PUT",
        headers,
        body: JSON.stringify({ ...initial, ...change }),
      });
      expect(invalid.status, JSON.stringify(change)).toBe(400);
      const error = await invalid.text();
      expect(error).toContain("workflow");
      expect(error).not.toContain("secret-value");
      expect(await sdk.loadWorkflowConfig({ cwd })).toEqual(initial);
    }
    const next = {
      ...initial,
      repository: "owner/.github",
      limits: { ...initial.limits, cycles: 2 },
    };
    expect(
      (
        await fetch(server.url + "/api/workflow", {
          method: "PUT",
          headers,
          body: JSON.stringify(next),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        (await (await fetch(server.url + "/api/workflow")).json()) as {
          config: sdk.WorkflowConfig;
        }
      ).config,
    ).toEqual(await sdk.loadWorkflowConfig({ cwd }));
    expect(
      (await fetch(server.url + "/api/workflow?cwd=/tmp/other")).status,
    ).toBe(400);
    expect(
      (
        await fetch(server.url + "/api/workflow", {
          method: "PUT",
          headers: { ...headers, origin: "http://evil.invalid" },
          body: JSON.stringify(next),
        })
      ).status,
    ).toBe(403);
  } finally {
    await server.close();
  }
});

const promptFiles = {
  planner: null,
  implementer: null,
  reviewer: null,
  merger: null,
  readiness: null,
};
test("frozen workflow schedules at its configured concurrency and later saves affect only later runs", async () => {
  const cwd = await fixture();
  const config = await sdk.loadWorkflowConfig({ cwd });
  await sdk.saveWorkflowConfig({
    cwd,
    config: {
      ...config,
      limits: {
        ...config.limits,
        concurrency: 2,
        cycles: 1,
        plannerAttempts: 2,
      },
    },
  });
  const active = await sdk.createProjectRuntime({
    cwd,
    promptFiles,
    sandboxIdentity: "fake",
  });
  await sdk.saveWorkflowConfig({
    cwd,
    config: {
      ...config,
      limits: { ...config.limits, concurrency: 1, cycles: 2 },
    },
  });
  const reopened = await sdk.openProjectRuntime({ cwd, id: active.record.id });
  const next = await sdk.createProjectRuntime({
    cwd,
    promptFiles,
    sandboxIdentity: "fake",
  });
  expect(reopened.workflow.config.limits).toEqual({
    concurrency: 2,
    cycles: 1,
    plannerAttempts: 2,
  });
  async function observe(runtime: sdk.ProjectRuntime) {
    let running = 0,
      maximum = 0;
    const results = await runtime.settleIssues([1, 2, 3, 4], async (value) => {
      running++;
      maximum = Math.max(maximum, running);
      await new Promise((resolve) => setTimeout(resolve, 15));
      running--;
      if (value === 2) throw new Error("fixture issue failed");
      return value * 10;
    });
    expect(results).toEqual([
      { status: "fulfilled", value: 10 },
      { status: "rejected", reason: expect.any(Error) },
      { status: "fulfilled", value: 30 },
      { status: "fulfilled", value: 40 },
    ]);
    return maximum;
  }
  expect(await observe(reopened)).toBe(2);
  expect(await observe(next)).toBe(1);
  expect(Object.isFrozen(active.workflow.config.limits)).toBe(true);
});

test("trusted feedback gates and verifier execute only frozen declarations and retain project holds", async () => {
  const cwd = await fixture();
  const gate = join(cwd, "gate.mjs"),
    verifier = join(cwd, "verify.mjs");
  await writeFile(gate, "process.exit(0)");
  await writeFile(
    verifier,
    `let text='';for await(const chunk of process.stdin)text+=chunk;const {snapshot}=JSON.parse(text);console.log(JSON.stringify({head:snapshot.head,approved:[7],dependencyCommits:{}}));`,
  );
  await writeFile(
    join(cwd, ".sandcastle/feedback-gates.json"),
    JSON.stringify({
      verifiers: { project: [process.execPath, verifier] },
      gates: { tests: [process.execPath, gate] },
      requiredGates: ["tests"],
    }),
  );
  const initial = await sdk.loadWorkflowConfig({ cwd });
  await sdk.saveWorkflowConfig({
    cwd,
    config: {
      ...initial,
      repository: "owner/project",
      holdLabels: [],
      readiness: { mode: "apply", verifier: "project", gates: [] },
    },
  });
  const active = await sdk.createProjectRuntime({
    cwd,
    promptFiles,
    sandboxIdentity: "fake",
  });
  expect(active.readiness.holdLabels).toContain("readiness:hold");
  expect(active.readiness.qualificationLabel).toBe("project-qualification");
  const input = {
    snapshot: {
      head: "a".repeat(40),
      repository: "owner/project",
      scopeLabel: "Sandcastle",
      issues: [],
    },
    assessment: { head: "a".repeat(40), decisions: [] },
    trigger: { kind: "startup" as const },
  };
  expect(await active.verifyReadiness(input)).toEqual({
    head: input.snapshot.head,
    approved: [7],
    dependencyCommits: {},
  });
  // No issue/model command is interpreted, and a later declaration cannot replace this run's argv.
  await writeFile(
    join(cwd, ".sandcastle/feedback-gates.json"),
    JSON.stringify({
      verifiers: { project: [process.execPath, "-e", "process.exit(1)"] },
      gates: { tests: [process.execPath, gate] },
      requiredGates: ["tests"],
    }),
  );
  expect(
    await (
      await sdk.openProjectRuntime({ cwd, id: active.record.id })
    ).verifyReadiness(input),
  ).toEqual({
    head: input.snapshot.head,
    approved: [7],
    dependencyCommits: {},
  });
  await writeFile(gate, "console.error('credential-value');process.exit(1)");
  await expect(active.verifyReadiness(input)).rejects.toThrow(
    "Project feedback gate tests failed",
  );
  await expect(active.verifyReadiness(input)).rejects.not.toThrow(
    "credential-value",
  );
  const inspected = await sdk.inspectWorkflow({ cwd });
  expect(JSON.stringify(inspected)).not.toContain(process.execPath);
  expect(JSON.stringify(inspected)).not.toContain("credential-value");
});

test("HTTP observes frozen workflow outcomes without exposing declarations or credential output", async () => {
  const cwd = await fixture();
  let active: sdk.ProjectRuntime | undefined;
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const server = await sdk.startOperator({
    cwd,
    port: 0,
    adapter: {
      promptFiles,
      sandboxIdentity: async () => "fake",
      run: async (runtime) => {
        active = runtime;
        await runtime.reportOutcome({
          code: "qualification-pending",
          issues: [7],
        });
        await wait;
      },
    },
  });
  try {
    const cookie = (await fetch(server.url)).headers
      .get("set-cookie")!
      .split(";")[0]!;
    const headers = {
      cookie,
      origin: server.url,
      "content-type": "application/json",
    };
    expect(
      (
        await fetch(server.url + "/api/run", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
    ).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const read = async () =>
      (await (await fetch(server.url + "/api/run")).json()) as {
        run: {
          workflow: sdk.WorkflowConfig;
          diagnostics: { code: string; issues: number[] }[];
        };
      };
    expect((await read()).run.diagnostics).toEqual([
      { code: "qualification-pending", issues: [7] },
    ]);
    const config = await sdk.loadWorkflowConfig({ cwd });
    await sdk.saveWorkflowConfig({
      cwd,
      config: { ...config, repository: "next/project" },
    });
    expect((await read()).run.workflow.repository).toBeNull();
    await active!.reportOutcome({ code: "no-progress", issues: [7] });
    expect((await read()).run.diagnostics).toEqual([
      { code: "no-progress", issues: [7] },
    ]);
    expect(JSON.stringify(await read())).not.toContain("declarations");
  } finally {
    finish();
    await server.close();
  }
});

test("workflow files and configuration directories cannot route settings into another project via symlinks", async () => {
  const cwd = await fixture(),
    other = await fixture();
  const initial = await sdk.loadWorkflowConfig({ cwd: other });
  await sdk.saveWorkflowConfig({ cwd: other, config: initial });
  await symlink(
    join(other, ".sandcastle/workflow.json"),
    join(cwd, ".sandcastle/workflow.json"),
  );
  await expect(sdk.loadWorkflowConfig({ cwd })).rejects.toThrow(/symlink/);
  await expect(
    sdk.saveWorkflowConfig({ cwd, config: initial }),
  ).rejects.toThrow(/symlink/);
  await rm(join(cwd, ".sandcastle"), { recursive: true });
  await symlink(join(other, ".sandcastle"), join(cwd, ".sandcastle"), "dir");
  await expect(
    sdk.saveWorkflowConfig({
      cwd,
      config: { ...initial, repository: "wrong/project" },
    }),
  ).rejects.toThrow(/symlink/);
  expect(await sdk.loadWorkflowConfig({ cwd: other })).toEqual(initial);
});

test("reopening a runtime rejects tampered trusted feedback policy and effective holds are immutable", async () => {
  const cwd = await fixture();
  const runtime = await sdk.createProjectRuntime({
    cwd,
    promptFiles,
    sandboxIdentity: "fake",
  });
  expect(Object.isFrozen(runtime.readiness.holdLabels)).toBe(true);
  const path = join(
    cwd,
    ".sandcastle/runtime",
    runtime.record.id,
    "record.json",
  );
  const record = JSON.parse(await readFile(path, "utf8"));
  record.workflow.policy.holdLabels = [];
  await writeFile(path, JSON.stringify(record));
  await expect(
    sdk.openProjectRuntime({ cwd, id: runtime.record.id }),
  ).rejects.toThrow(/revision/);
});

test("legacy frozen role records reopen without inventing workflow policy", async () => {
  const cwd = await fixture();
  const runtime = await sdk.createProjectRuntime({
    cwd,
    promptFiles,
    sandboxIdentity: "fake",
  });
  const path = join(
    cwd,
    ".sandcastle/runtime",
    runtime.record.id,
    "record.json",
  );
  const record = JSON.parse(await readFile(path, "utf8"));
  delete record.workflow;
  delete record.workflowRevision;
  await writeFile(path, JSON.stringify(record));
  const reopened = await sdk.openProjectRuntime({ cwd, id: runtime.record.id });
  expect(reopened.record.config).toEqual(runtime.record.config);
  expect(reopened.record.id).toBe(runtime.record.id);
  expect(() => reopened.readiness).toThrow("workflow snapshot");
});
