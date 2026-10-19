import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import * as sdk from "./index.js";
import type { ReadinessIssue, ReadinessVerificationInput } from "./index.js";

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0))
    await rm(r, { recursive: true, force: true });
});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "readiness-policy-"));
  roots.push(cwd);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-qb", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("commit", "--allow-empty", "-qm", "baseline");
  const head = git("rev-parse", "HEAD");
  const issue: ReadinessIssue = {
    number: 3,
    title: "Next slice",
    body: "## AC\n- Public behavior",
    comments: [],
    dependencies: [],
    labels: ["scope"],
    state: "open",
    updatedAt: "now",
  };
  const input: ReadinessVerificationInput = {
    snapshot: { repository: "owner/project", head, issues: [issue] },
    trigger: { kind: "startup" },
    assessment: {
      head,
      decisions: [
        {
          number: 3,
          status: "ready-for-agent",
          reason: "Agent says passing",
          evidence: [{ path: "host:integration", claim: "Test execution" }],
          gates: [
            {
              id: "integration",
              status: "satisfied",
              reason: "Executed",
              evidence: [{ path: "host:integration", claim: "Test execution" }],
            },
          ],
        },
      ],
    },
  };
  return { cwd, git, head, issue, input };
}
it("refuses an agent's satisfied gate when the independently executed host gate failed", async () => {
  const f = await fixture();
  const policy = {
    repository: "owner/project",
    issues: {
      "3": {
        contractHash: sdk.readinessContractHash(f.issue),
        kind: "implementation" as const,
        dependencies: {},
        gates: ["integration"],
      },
    },
  };
  await expect(
    sdk.verifyReadinessPolicy({
      cwd: f.cwd,
      input: f.input,
      policy,
      verifyGate: async () => ({
        head: f.head,
        passed: false,
        reference: "host:integration",
      }),
    }),
  ).rejects.toThrow(/Host gate integration did not pass/);
});

it("approves the next slice only after its completed producer commit and fresh host gate are verified", async () => {
  const f = await fixture();
  f.git("branch", "producer");
  f.issue.dependencies = [
    {
      repository: "owner/project",
      number: 2,
      state: "closed",
      stateReason: "completed",
    },
  ];
  const policy = {
    repository: "owner/project",
    issues: {
      "3": {
        contractHash: sdk.readinessContractHash(f.issue),
        kind: "implementation" as const,
        dependencies: { "owner/project#2": "producer" },
        gates: ["integration"],
      },
    },
  };
  const result = await sdk.verifyReadinessPolicy({
    cwd: f.cwd,
    input: f.input,
    policy,
    verifyGate: async () => ({
      head: f.head,
      passed: true,
      reference: "host:integration",
    }),
  });
  expect(result.approved).toEqual([{ number: 3, status: "ready-for-agent" }]);
  expect(result.dependencyCommits["owner/project#2"]).toBe(f.head);
});

it("requires complete declared gate accounting even for a blocked known contract", async () => {
  const f = await fixture();
  f.input.assessment.decisions[0]!.status = "blocked";
  f.input.assessment.decisions[0]!.gates = [];
  const policy = {
    repository: "owner/project",
    issues: {
      "3": {
        contractHash: sdk.readinessContractHash(f.issue),
        kind: "implementation" as const,
        dependencies: {},
        gates: ["integration"],
      },
    },
  };
  await expect(
    sdk.verifyReadinessPolicy({
      cwd: f.cwd,
      input: f.input,
      policy,
      verifyGate: async () => ({
        head: f.head,
        passed: true,
        reference: "host:integration",
      }),
    }),
  ).rejects.toThrow(/Incomplete policy gate accounting/);
});

it.each(["proof.txt:752", "../proof.txt", ".env", "missing.txt"])(
  "refuses %s as source evidence even with a passing host gate",
  async (path) => {
    const f = await fixture();
    await writeFile(join(f.cwd, "proof.txt"), "Observed behavior\n");
    await writeFile(join(f.cwd, ".env"), "fixture-only\n");
    f.git("add", "proof.txt", ".env");
    f.git("commit", "-qm", "fixture evidence");
    const head = f.git("rev-parse", "HEAD");
    f.input.snapshot.head = head;
    f.input.assessment.head = head;
    f.input.assessment.decisions[0]!.evidence!.push({
      path,
      claim: "Claimed source",
    });
    await expect(
      sdk.verifyReadinessPolicy({
        cwd: f.cwd,
        input: f.input,
        policy: {
          repository: "owner/project",
          issues: {
            "3": {
              contractHash: sdk.readinessContractHash(f.issue),
              kind: "implementation",
              dependencies: {},
              gates: ["integration"],
            },
          },
        },
        verifyGate: async () => ({
          head,
          passed: true,
          reference: "host:integration",
        }),
      }),
    ).rejects.toThrow(
      path === "missing.txt"
        ? /not a regular committed file/
        : /Invalid evidence reference/,
    );
  },
);

it("accepts a committed plain source path with line details in its claim alongside independent host proof", async () => {
  const f = await fixture();
  await writeFile(join(f.cwd, "proof.txt"), "Observed behavior\n");
  f.git("add", "proof.txt");
  f.git("commit", "-qm", "fixture evidence");
  const head = f.git("rev-parse", "HEAD");
  f.input.snapshot.head = head;
  f.input.assessment.head = head;
  f.input.assessment.decisions[0]!.evidence!.push({
    path: "proof.txt",
    claim: "Line 1: Observed behavior",
  });
  const result = await sdk.verifyReadinessPolicy({
    cwd: f.cwd,
    input: f.input,
    policy: {
      repository: "owner/project",
      issues: {
        "3": {
          contractHash: sdk.readinessContractHash(f.issue),
          kind: "implementation",
          dependencies: {},
          gates: ["integration"],
        },
      },
    },
    verifyGate: async () => ({
      head,
      passed: true,
      reference: "host:integration",
    }),
  });
  expect(result.approved).toEqual([{ number: 3, status: "ready-for-agent" }]);
});

it.each([
  "stale-head",
  "edited-contract",
  "open-dependency",
  "unintegrated-producer",
])("rejects %s instead of trusting a ready proposal", async (scenario) => {
  const f = await fixture();
  f.git("branch", "producer");
  f.issue.dependencies = [
    {
      repository: "owner/project",
      number: 2,
      state: "closed",
      stateReason: "completed",
    },
  ];
  const policy = {
    repository: "owner/project",
    issues: {
      "3": {
        contractHash: sdk.readinessContractHash(f.issue),
        kind: "implementation" as const,
        dependencies: { "owner/project#2": "producer" },
        gates: ["integration"],
      },
    },
  };
  if (scenario === "edited-contract")
    f.issue.comments.push({
      id: 1,
      body: "New required gate",
      updatedAt: "later",
    });
  if (scenario === "open-dependency") f.issue.dependencies[0]!.state = "open";
  if (scenario === "unintegrated-producer") {
    f.git("checkout", "-q", "producer");
    f.git("commit", "--allow-empty", "-qm", "not integrated");
    f.git("checkout", "-q", "main");
  }
  await expect(
    sdk.verifyReadinessPolicy({
      cwd: f.cwd,
      input: f.input,
      policy,
      verifyGate: async () => ({
        head: scenario === "stale-head" ? "0".repeat(40) : f.head,
        passed: true,
        reference: "host:integration",
      }),
    }),
  ).rejects.toThrow();
});
