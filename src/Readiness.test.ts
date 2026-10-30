import * as childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  reassessGitHubReadiness,
  loadGitHubReadinessInventory,
  inspectGitHubReadinessBacklog,
  admitGitHubReadinessBatch,
} from "./Readiness.js";
import type {
  GitHubReadinessOptions,
  ReadinessVerificationInput,
} from "./Readiness.js";

const approve = async ({
  snapshot,
  assessment,
}: ReadinessVerificationInput) => ({
  head: snapshot.head,
  approved: assessment.decisions.map(({ number, status }) => ({
    number,
    status,
  })),
  dependencyCommits: {} as Record<string, string>,
});

const readyOptions = (options: {
  cwd: string;
  repository: string;
  scopeLabel: string;
}): GitHubReadinessOptions => ({
  ...options,
  mode: "apply",
  trigger: { kind: "startup" },
  verify: approve,
  assess: async (s) => ({
    head: s.head,
    decisions: [
      {
        number: 20,
        status: "ready-for-agent",
        reason: "Full contract checked by project verifier",
      },
    ],
  }),
});

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof childProcess>();
  return {
    ...original,
    execFileSync: vi.fn(original.execFileSync),
    execFile: vi.fn(original.execFile),
  };
});

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it("retains structured evidence and open gate accounting in the read-only readiness report", async () => {
  const f = await fixture();
  const result = await reassessGitHubReadiness({
    ...readyOptions(f.options),
    mode: "report-only",
    assess: async (s) => ({
      head: s.head,
      decisions: [
        {
          number: 20,
          status: "blocked",
          reason: "Missing gate",
          evidence: [{ path: "proof.txt", claim: "Existing contract only" }],
          gates: [
            {
              id: "integration",
              status: "open",
              reason: "No passing execution",
              evidence: [],
            },
          ],
        },
      ],
    }),
  });
  expect(result.assessment.decisions[0]).toMatchObject({
    gates: [{ id: "integration", status: "open" }],
    evidence: [{ path: "proof.txt" }],
  });
  expect(f.writes).toEqual([]);
});

it.each([
  "src/AgentProvider.ts:752",
  "src/AgentProvider.ts:752-760",
  "src/AgentProvider.ts:752:4",
  "src/AgentProvider.ts#L752",
  "src/AgentProvider.ts#L752-L760",
])(
  "rejects line-annotated evidence %s before verification or publication",
  async (path) => {
    const f = await fixture();
    let verified = false;
    await expect(
      reassessGitHubReadiness({
        ...readyOptions(f.options),
        verify: async (input) => {
          verified = true;
          return approve(input);
        },
        assess: async (s) => ({
          head: s.head,
          decisions: [
            {
              number: 20,
              status: "ready-for-agent",
              reason: "Source inspected",
              evidence: [{ path, claim: "Declared effort options" }],
            },
          ],
        }),
      }),
    ).rejects.toThrow(/line numbers.*claim/);
    expect(verified).toBe(false);
    expect(f.writes).toEqual([]);
  },
);

it("rejects line-annotated gate evidence before publication even for blocked proposals", async () => {
  const f = await fixture();
  await expect(
    reassessGitHubReadiness({
      ...readyOptions(f.options),
      mode: "report-only",
      assess: async (s) => ({
        head: s.head,
        decisions: [
          {
            number: 20,
            status: "blocked",
            reason: "Missing dependency",
            evidence: [],
            gates: [
              {
                id: "integration",
                status: "satisfied",
                reason: "Claimed gate",
                evidence: [
                  {
                    path: "src/AgentProvider.ts:752",
                    claim: "Source inspected",
                  },
                ],
              },
            ],
          },
        ],
      }),
    }),
  ).rejects.toThrow(/line numbers.*claim/);
  expect(f.writes).toEqual([]);
});

it("preserves plain file paths and exact host references with line details only in claims", async () => {
  const f = await fixture();
  const evidence = [
    { path: "proof.txt", claim: "Line 1: Gate passed" },
    { path: "host:integration", claim: "Trusted host execution" },
  ];
  const result = await reassessGitHubReadiness({
    ...readyOptions(f.options),
    mode: "report-only",
    assess: async (s) => ({
      head: s.head,
      decisions: [
        {
          number: 20,
          status: "ready-for-agent",
          reason: "Contract inspected",
          evidence,
          gates: [
            {
              id: "integration",
              status: "satisfied",
              reason: "Host check",
              evidence: [evidence[1]!],
            },
          ],
        },
      ],
    }),
  });
  expect(result.assessment.decisions[0]?.evidence).toEqual(evidence);
  expect(f.writes).toEqual([]);
});

it("publishes approved qualification readiness without admitting it to implementation", async () => {
  const f = await fixture();
  f.issue.body =
    "**Kind:** live-validation\n## Acceptance\n- Observe real service";
  await reassessGitHubReadiness({
    ...readyOptions(f.options),
    assess: async (s) => ({
      head: s.head,
      decisions: [
        {
          number: 20,
          status: "ready-for-qualification",
          reason: "Host-approved lane",
          evidence: [
            {
              path: "proof.txt",
              claim: "Project verifier approved preflight, not live acceptance",
            },
          ],
          gates: [
            {
              id: "live-acceptance",
              status: "open",
              reason: "Qualification program must test this",
              evidence: [],
            },
          ],
        },
      ],
    }),
    verify: async (input) => ({
      ...(await approve(input)),
      qualificationPrograms: { "20": "project-preflight" },
    }),
  });
  expect(f.issue.labels.map((l) => l.name)).toContain(
    "ready-for-qualification",
  );
  expect(await loadGitHubReadinessInventory(f.options)).toEqual([]);
});

it("publishes and reads back a managed readiness body without changing task acceptance, and repeats as a no-op", async () => {
  const f = await fixture();
  const original = f.issue.body;
  const options = { ...readyOptions(f.options), publishBody: true };
  await reassessGitHubReadiness(options);
  expect(f.issue.body).toContain("<!-- sandcastle-readiness:start -->");
  expect(f.issue.body).toContain(original);
  const writes = f.writes.length;
  await reassessGitHubReadiness(options);
  expect(f.writes).toHaveLength(writes);
});

it("rejects a parent contract edited during assessment even when it is outside the execution scope", async () => {
  const f = await fixture();
  f.transport.contextIssue = {
    ...f.issue,
    number: 99,
    body: "Parent contract",
    labels: [{ name: "meta" }],
  };
  await expect(
    reassessGitHubReadiness({
      ...readyOptions(f.options),
      contextIssueNumbers: [99],
      assess: async (s) => {
        expect(s.context?.[0]?.body).toBe("Parent contract");
        f.transport.contextIssue!.body = "Changed parent AC";
        return {
          head: s.head,
          decisions: [
            { number: 20, status: "ready-for-agent", reason: "Checked" },
          ],
        };
      },
    }),
  ).rejects.toThrow(/Tracker changed/);
  expect(f.writes).toEqual([]);
});

it("keeps the host event loop responsive while GitHub inventory is loading", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "readiness-responsive-"));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const real = await vi.importActual<typeof childProcess>("node:child_process");
  const git = (...args: string[]) => real.execFileSync("git", args, { cwd });
  git("init", "-qb", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("commit", "--allow-empty", "-qm", "initial");
  const bin = join(cwd, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "gh"),
    '#!/usr/bin/env node\nsetTimeout(()=>console.log("[[]]"),250);\n',
  );
  await chmod(join(bin, "gh"), 0o755);
  vi.stubEnv("PATH", bin + ":" + process.env.PATH);
  let beats = 0;
  const timer = setInterval(() => {
    beats++;
  }, 10);
  try {
    expect(
      await loadGitHubReadinessInventory({
        cwd,
        repository: "owner/project",
        scopeLabel: "Sandcastle",
      }),
    ).toEqual([]);
  } finally {
    clearInterval(timer);
  }
  expect(beats).toBeGreaterThan(3);
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "readiness-test-"));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const real = await vi.importActual<typeof childProcess>("node:child_process");
  const exec = real.execFileSync;
  const git = (...args: string[]) =>
    exec("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Readiness Test");
  git("config", "user.email", "test@example.com");
  await writeFile(join(cwd, "proof.txt"), "Gate passed\n");
  await writeFile(join(cwd, ".gitignore"), ".sandcastle/runs/\n");
  git("add", ".");
  git("commit", "-qm", "baseline");
  const issue = {
    number: 20,
    title: "Implement next slice",
    body: "## Acceptance criteria\n- Observe public behavior",
    state: "open",
    state_reason: null as string | null,
    updated_at: "2026-01-01",
    labels: [{ name: "Sandcastle" }, { name: "blocked" }],
  };
  const dependencies = new Map<
    number,
    { state: string; state_reason: string }
  >();
  const transport = {
    onWrite: () => {},
    onList: () => {},
    comments: [] as { id: number; body: string; updated_at: string }[],
    native: [] as { html_url: string }[],
    contextIssue: undefined as typeof issue | undefined,
  };
  const writes: string[][] = [];
  const additionalIssues: (typeof issue)[] = [];
  const fakeGh = (args: readonly string[] = []): string => {
    const argv = [...(args ?? [])].map(String);
    if (argv[0] !== "api") throw new Error(`Unexpected gh call: ${argv}`);
    const endpoint = argv[1]!;
    if (
      argv.includes("POST") ||
      argv.includes("DELETE") ||
      argv.includes("PATCH")
    ) {
      const target = [issue, ...additionalIssues].find(
        (row) =>
          row.number === Number(endpoint.split("/issues/")[1]?.split("/")[0]),
      )!;
      writes.push(argv);
      transport.onWrite();
      if (argv.includes("PATCH")) {
        const path = argv[argv.indexOf("--input") + 1]!;
        target.body = JSON.parse(readFileSync(path, "utf8")).body;
      } else if (argv.includes("POST")) {
        for (const arg of argv.filter((a) => a.startsWith("labels[]=")))
          target.labels.push({ name: arg.slice(9) });
      } else
        target.labels = target.labels.filter(
          (l) => !endpoint.endsWith(`/${encodeURIComponent(l.name)}`),
        );
      return "";
    }
    if (endpoint.endsWith("/comments?per_page=100"))
      return JSON.stringify([transport.comments]);
    if (endpoint.endsWith("/dependencies/blocked_by?per_page=100"))
      return JSON.stringify([transport.native]);
    if (endpoint.includes("/issues?")) {
      const value = JSON.stringify([[issue, ...additionalIssues]]);
      transport.onList();
      return value;
    }
    if (endpoint.endsWith("/issues/20")) return JSON.stringify(issue);
    if (
      transport.contextIssue &&
      endpoint.endsWith(`/issues/${transport.contextIssue.number}`)
    )
      return JSON.stringify(transport.contextIssue);
    const extra = additionalIssues.find((row) =>
      endpoint.endsWith(`/issues/${row.number}`),
    );
    if (extra) return JSON.stringify(extra);
    const dependency = dependencies.get(Number(endpoint.split("/").at(-1)));
    if (dependency) return JSON.stringify(dependency);
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
  vi.spyOn(childProcess, "execFile").mockImplementation(
    (file, args, options, callback) => {
      if (file !== "gh") return real.execFile(file, args, options, callback);
      const proc = new childProcess.ChildProcess();
      setImmediate(() => {
        try {
          callback!(null, fakeGh(args ?? []), "");
        } catch (cause) {
          callback!(cause as childProcess.ExecFileException, "", "");
        }
      });
      return proc;
    },
  );
  return {
    cwd,
    git,
    issue,
    writes,
    additionalIssues,
    dependencies,
    transport,
    options: { cwd, repository: "owner/project", scopeLabel: "Sandcastle" },
  };
}

it("defaults to report-only, assesses the full scoped contract and records an audit without GitHub writes", async () => {
  const f = await fixture();
  const result = await reassessGitHubReadiness({
    ...f.options,
    trigger: { kind: "startup" },
    assess: async (snapshot) => {
      expect(snapshot.issues[0]?.body).toContain("Acceptance criteria");
      expect(snapshot.issues[0]?.labels).toContain("blocked");
      return {
        head: snapshot.head,
        decisions: [
          {
            number: 20,
            status: "ready-for-agent",
            reason:
              "Dependencies satisfied; requires host verification before apply.",
          },
        ],
      };
    },
  });
  expect(result.mode).toBe("report-only");
  expect(result.applied).toEqual([]);
  expect(f.writes).toEqual([]);
  expect(JSON.parse(await readFile(result.auditPath, "utf8"))).toMatchObject({
    trigger: { kind: "startup" },
    status: "reported",
  });
});

it("does not dirty a clean consumer checkout that has no generated ignore rule", async () => {
  const f = await fixture();
  await rm(join(f.cwd, ".gitignore"));
  f.git("add", ".");
  f.git("commit", "-qm", "no generated config");
  await reassessGitHubReadiness({
    ...f.options,
    trigger: { kind: "startup" },
    assess: async (s) => ({
      head: s.head,
      decisions: [
        { number: 20, status: "blocked", reason: "Missing environment" },
      ],
    }),
  });
  expect(f.git("status", "--porcelain")).toBe("");
});

it.each(["closed", "removed-from-scope"])(
  "excludes an issue %s between list and detail requests",
  async (change) => {
    const f = await fixture();
    f.issue.labels = [{ name: "Sandcastle" }, { name: "ready-for-agent" }];
    f.transport.onList = () => {
      if (change === "closed") f.issue.state = "closed";
      else f.issue.labels = [{ name: "ready-for-agent" }];
    };
    expect(await loadGitHubReadinessInventory(f.options)).toEqual([]);
  },
);

it("applies verified readiness using label deltas, then repeats without duplicate writes", async () => {
  const f = await fixture();
  const options = {
    ...f.options,
    mode: "apply" as const,
    trigger: { kind: "startup" as const },
    verify: async ({
      snapshot,
      assessment,
    }: import("./Readiness.js").ReadinessVerificationInput) => ({
      head: snapshot.head,
      approved: assessment.decisions.map((d) => ({
        number: d.number,
        status: d.status,
      })),
      dependencyCommits: {},
    }),
    assess: async (snapshot: import("./Readiness.js").ReadinessSnapshot) => ({
      head: snapshot.head,
      decisions: [
        {
          number: 20,
          status: "ready-for-agent",
          reason:
            "The configured project verifier approved the complete contract.",
        },
      ],
    }),
  };
  expect((await reassessGitHubReadiness(options)).applied).toEqual([20]);
  expect(f.issue.labels.map((l) => l.name).sort()).toEqual([
    "Sandcastle",
    "ready-for-agent",
  ]);
  const count = f.writes.length;
  expect((await reassessGitHubReadiness(options)).applied).toEqual([]);
  expect(f.writes).toHaveLength(count);
  expect(f.issue.body).toBe(
    "## Acceptance criteria\n- Observe public behavior",
  );
});

it("preserves manual holds and excludes held or blocked issues from planning", async () => {
  const f = await fixture();
  f.issue.labels = [
    { name: "Sandcastle" },
    { name: "ready-for-agent" },
    { name: "readiness:hold" },
  ];
  const result = await reassessGitHubReadiness({
    ...f.options,
    mode: "apply",
    trigger: { kind: "startup" },
    assess: async (s) => ({
      head: s.head,
      decisions: [
        {
          number: 20,
          status: "ready-for-agent",
          reason: "Agent thinks it is ready",
        },
      ],
    }),
    verify: async ({ snapshot, assessment }) => ({
      head: snapshot.head,
      approved: assessment.decisions.map(({ number, status }) => ({
        number,
        status,
      })),
      dependencyCommits: {},
    }),
  });
  expect(result.applied).toEqual([]);
  expect(f.writes).toEqual([]);
  expect(await loadGitHubReadinessInventory(f.options)).toEqual([]);
  f.issue.labels = [{ name: "Sandcastle" }, { name: "ready-for-agent" }];
  expect(
    (await loadGitHubReadinessInventory(f.options)).map((i) => i.number),
  ).toEqual([20]);
});

it.each([
  "missing verifier",
  "wrong head",
  "missing decision",
  "duplicate decision",
  "unapproved",
  "dirty checkout",
  "changed comments",
  "changed body",
  "changed labels",
  "changed branch",
])("fails closed for %s without publishing", async (failure) => {
  const f = await fixture();
  const options = readyOptions(f.options);
  if (failure === "missing verifier") options.verify = undefined;
  if (failure === "unapproved")
    options.verify = async ({ snapshot }) => ({
      head: snapshot.head,
      approved: [],
      dependencyCommits: {},
    });
  options.assess = async (input) => {
    const proposal = {
      head: input.head,
      decisions: [
        { number: 20, status: "ready-for-agent", reason: "Proposed" },
      ],
    };
    if (failure === "wrong head") proposal.head = "wrong";
    if (failure === "missing decision") proposal.decisions = [];
    if (failure === "duplicate decision")
      proposal.decisions.push(proposal.decisions[0]!);
    if (failure === "dirty checkout")
      await writeFile(join(f.cwd, "unexpected.txt"), "dirty");
    if (failure === "changed comments")
      f.transport.comments.push({
        id: 1,
        body: "Hold: needs human decision",
        updated_at: "later",
      });
    if (failure === "changed body") f.issue.body += "\nAdditional gate";
    if (failure === "changed labels")
      f.issue.labels.push({ name: "readiness:hold" });
    if (failure === "changed branch") f.git("switch", "-qc", "other-checkout");
    return proposal;
  };
  await expect(reassessGitHubReadiness(options)).rejects.toThrow();
  expect(f.writes).toEqual([]);
  const auditDir = join(f.cwd, ".git/sandcastle/readiness");
  const files = await readdir(auditDir);
  expect(
    JSON.parse(await readFile(join(auditDir, files[0]!), "utf8")),
  ).toMatchObject({ status: "failed", applied: [] });
});

it.each([
  "open",
  "not_planned",
  "missing integration",
  "not ancestor",
  "integrated",
])(
  "requires completed and integrated nested/cross-repo dependencies: %s",
  async (state) => {
    const f = await fixture();
    f.issue.body +=
      "\n## Dependencies\n### Database\n- other/project#10\n## Acceptance criteria\n- Deliver behavior";
    f.dependencies.set(10, {
      state: state === "open" ? "open" : "closed",
      state_reason: state === "not_planned" ? "not_planned" : "completed",
    });
    const options = readyOptions(f.options);
    options.verify = async (input) => {
      const result = await approve(input);
      if (state !== "missing integration")
        result.dependencyCommits["other/project#10"] =
          state === "not ancestor" ? "a".repeat(40) : input.snapshot.head;
      return result;
    };
    if (state === "integrated")
      expect((await reassessGitHubReadiness(options)).applied).toEqual([20]);
    else {
      await expect(reassessGitHubReadiness(options)).rejects.toThrow();
      expect(f.writes).toEqual([]);
    }
  },
);

it("passes complete nested/free-form gates and edited comments to the independent verifier", async () => {
  const f = await fixture();
  f.issue.body +=
    "\n## Implementation gates\n### Authentication\nG-AUTH: live approval required";
  f.transport.comments.push({
    id: 7,
    body: "Do not substitute synthetic tests for live approval",
    updated_at: "later",
  });
  const options = readyOptions(f.options);
  options.verify = async (input) => {
    expect(input.snapshot.issues[0]?.body).toContain(
      "### Authentication\nG-AUTH: live approval required",
    );
    expect(input.snapshot.issues[0]?.comments[0]?.body).toContain(
      "live approval",
    );
    return { head: input.snapshot.head, approved: [], dependencyCommits: {} };
  };
  await expect(reassessGitHubReadiness(options)).rejects.toThrow(
    "did not approve",
  );
  expect(f.writes).toEqual([]);
});

it("records partial publication and rejects instead of claiming the batch is ready", async () => {
  const f = await fixture();
  f.transport.onWrite = () => {
    if (f.writes.length === 2) throw new Error("simulated GitHub unavailable");
  };
  await expect(
    reassessGitHubReadiness(readyOptions(f.options)),
  ).rejects.toThrow("simulated GitHub unavailable");
  expect(f.issue.labels.some((label) => label.name === "ready-for-agent")).toBe(
    false,
  );
  const auditDir = join(f.cwd, ".git/sandcastle/readiness");
  const [file] = await readdir(auditDir);
  expect(
    JSON.parse(await readFile(join(auditDir, file!), "utf8")),
  ).toMatchObject({ status: "failed", pending: 20, applied: [] });
});

it("reports every excluded scoped issue without treating an empty frontier as completed work", async () => {
  const f = await fixture();
  f.issue.labels = [
    { name: "Sandcastle" },
    { name: "ready-for-agent" },
    { name: "blocked" },
    { name: "readiness:hold" },
  ];
  f.issue.body += "\n## Dependencies\n- #10";
  f.dependencies.set(10, { state: "closed", state_reason: "not_planned" });
  const report = await inspectGitHubReadinessBacklog(f.options);
  expect(report.eligible).toEqual([]);
  expect(report.snapshot.issues.map((i) => i.number)).toEqual([20]);
  expect(report.excluded[0]?.reasons.map((r) => r.code)).toEqual(
    expect.arrayContaining([
      "blocked-label",
      "manual-hold",
      "unresolved-dependency",
    ]),
  );
  expect(f.writes).toEqual([]);
});

it("admits a fresh batch at its named source branch without tracker mutations", async () => {
  const f = await fixture();
  f.issue.labels = [{ name: "Sandcastle" }, { name: "ready-for-agent" }];
  const planned = await inspectGitHubReadinessBacklog(f.options);
  const admission = await admitGitHubReadinessBatch(f.options, {
    snapshot: planned.snapshot,
    branch: planned.branch,
    issues: [20],
  });
  expect(admission).toMatchObject({
    head: planned.snapshot.head,
    branch: planned.branch,
    issues: [{ number: 20 }],
  });
  expect(f.writes).toEqual([]);
});

it.each(["body", "hold", "closed", "source", "branch", "duplicate"])(
  "rejects a stale batch before execution when %s changes",
  async (change) => {
    const f = await fixture();
    f.issue.labels = [{ name: "Sandcastle" }, { name: "ready-for-agent" }];
    const planned = await inspectGitHubReadinessBacklog(f.options);
    if (change === "body") f.issue.body += "\nApproval required";
    if (change === "hold") f.issue.labels.push({ name: "readiness:hold" });
    if (change === "closed") f.issue.state = "closed";
    if (change === "source")
      f.git("commit", "--allow-empty", "-qm", "changed source");
    if (change === "branch") f.git("switch", "-qc", "different-checkout");
    await expect(
      admitGitHubReadinessBatch(f.options, {
        snapshot: planned.snapshot,
        branch: planned.branch,
        issues: change === "duplicate" ? [20, 20] : [20],
      }),
    ).rejects.toThrow();
    expect(f.writes).toEqual([]);
  },
);

it("identifies dependency cycles instead of treating their labels as execution authority", async () => {
  const f = await fixture();
  f.issue.labels = [{ name: "Sandcastle" }, { name: "ready-for-agent" }];
  f.issue.body = "## Dependencies\n- #21";
  f.additionalIssues.push({
    ...structuredClone(f.issue),
    number: 21,
    body: "## Dependencies\n- #20",
  });
  const report = await inspectGitHubReadinessBacklog(f.options);
  expect(report.eligible).toEqual([]);
  expect(
    report.excluded
      .filter((row) =>
        row.reasons.some((reason) => reason.code === "dependency-cycle"),
      )
      .map((row) => row.issue.number),
  ).toEqual([20, 21]);
});

it("rejects a change to an already published issue while another issue is being published", async () => {
  const f = await fixture();
  f.additionalIssues.push({ ...structuredClone(f.issue), number: 21 });
  f.transport.onWrite = () => {
    if (f.writes.length === 4) f.issue.body += "\nNew acceptance requirement";
  };
  const options = readyOptions(f.options);
  options.assess = async (input) => ({
    head: input.head,
    decisions: input.issues.map((issue) => ({
      number: issue.number,
      status: "ready-for-agent",
      reason: "Verified fixture",
    })),
  });
  await expect(reassessGitHubReadiness(options)).rejects.toThrow(
    "Tracker changed during publication",
  );
  expect(f.additionalIssues[0]?.labels).toContainEqual({
    name: "ready-for-agent",
  });
});

it("does not admit a manually ready meta task", async () => {
  const f = await fixture();
  f.issue.labels = [
    { name: "Sandcastle" },
    { name: "ready-for-agent" },
    { name: "epic" },
  ];
  const report = await inspectGitHubReadinessBacklog(f.options);
  expect(report.excluded[0]?.reasons).toContainEqual(
    expect.objectContaining({ code: "not-implementation" }),
  );
  expect(await loadGitHubReadinessInventory(f.options)).toEqual([]);
});

it("rejects a tracker edit during final publication readback and retains the journal", async () => {
  const f = await fixture();
  f.transport.onList = () => {
    if (f.writes.length) f.issue.body += "\nNew external acceptance gate";
  };
  await expect(
    reassessGitHubReadiness(readyOptions(f.options)),
  ).rejects.toThrow("Tracker changed during publication");
  const [file] = await readdir(join(f.cwd, ".git/sandcastle/readiness"));
  expect(
    JSON.parse(
      await readFile(join(f.cwd, ".git/sandcastle/readiness", file!), "utf8"),
    ),
  ).toMatchObject({ status: "failed", applied: [20] });
});

it("checks verified merge provenance before reassessing the next frontier", async () => {
  const f = await fixture();
  const base = f.git("rev-parse", "HEAD");
  f.git("switch", "-qc", "feature");
  await writeFile(join(f.cwd, "integrated.txt"), "new source");
  f.git("add", ".");
  f.git("commit", "-qm", "integrated");
  f.dependencies.set(22, { state: "closed", state_reason: "completed" });
  const options = readyOptions(f.options);
  options.trigger = {
    kind: "post-merge",
    base,
    branches: ["feature"],
    issues: [22],
    completionSignal: "<promise>BLOCKED</promise>",
  };
  await expect(reassessGitHubReadiness(options)).rejects.toThrow(
    "completed, nonempty merge",
  );
  expect(f.writes).toEqual([]);
  options.trigger.completionSignal = "<promise>COMPLETE</promise>";
  const result = await reassessGitHubReadiness(options);
  expect(result.applied).toEqual([20]);
  expect(JSON.parse(await readFile(result.auditPath, "utf8"))).toMatchObject({
    status: "verified",
    trigger: { kind: "post-merge", issues: [22] },
  });
});

it("incremental post-merge readiness assesses only affected issues and leaves the rest untouched", async () => {
  const { selectIncrementalReadiness } = await import("./Readiness.js");
  const f = await fixture();
  const base = f.git("rev-parse", "HEAD");
  f.git("switch", "-qc", "feature");
  await mkdir(join(f.cwd, "src"));
  await writeFile(join(f.cwd, "src/changed.ts"), "export const x = 1;\n");
  f.git("add", ".");
  f.git("commit", "-qm", "integrated");
  f.dependencies.set(22, { state: "closed", state_reason: "completed" });
  f.issue.body += "\n\n## Blocked by\n- #22";
  const extra = (number: number, body: string, labels: string[] = []) => ({
    ...f.issue,
    number,
    body,
    labels: [
      { name: "Sandcastle" },
      { name: "blocked" },
      ...labels.map((name) => ({ name })),
    ],
  });
  f.additionalIssues.push(
    extra(21, "Evidence: `src/changed.ts` must export x."),
    extra(23, "Unrelated documentation task."),
    extra(24, "Needs another look.", ["readiness:reassess"]),
  );
  const seen: number[][] = [];
  const options: GitHubReadinessOptions = {
    ...f.options,
    mode: "report-only",
    incremental: true,
    trigger: {
      kind: "post-merge",
      base,
      branches: ["feature"],
      issues: [22],
      completionSignal: "<promise>COMPLETE</promise>",
    },
    assess: async (snapshot) => {
      seen.push(snapshot.issues.map((issue) => issue.number));
      return {
        head: snapshot.head,
        decisions: snapshot.issues.map((issue) => ({
          number: issue.number,
          status: "blocked",
          reason: "Still blocked",
        })),
      };
    },
  };
  const result = await reassessGitHubReadiness(options);
  expect(seen).toEqual([[20, 21, 24]]);
  expect(JSON.parse(await readFile(result.auditPath, "utf8"))).toMatchObject({
    scope: { mode: "incremental", selected: [20, 21, 24], excluded: [23] },
  });
  await reassessGitHubReadiness({ ...options, incremental: false });
  expect(seen[1]).toEqual([20, 21, 23, 24]);
  const startup = await reassessGitHubReadiness({
    ...options,
    trigger: { kind: "startup" },
  });
  expect(seen[2]).toEqual([20, 21, 23, 24]);
  expect(JSON.parse(await readFile(startup.auditPath, "utf8")).scope).toEqual({
    mode: "full",
  });
  expect(f.writes).toEqual([]);

  // Pure selection rules.
  const issue = (
    number: number,
    body: string,
    extraFields: Record<string, unknown> = {},
  ) => ({
    number,
    title: "t",
    body,
    labels: [],
    state: "open",
    updatedAt: "now",
    comments: [],
    dependencies: [],
    ...extraFields,
  });
  expect(
    selectIncrementalReadiness(
      [
        issue(1, "x marks the spot"),
        issue(2, "mentions src/x.ts in a comment", {
          comments: [{ id: 1, body: "see src/lib/x.ts", updatedAt: "now" }],
        }),
        issue(3, "depends", {
          dependencies: [
            {
              repository: "other/repo",
              number: 9,
              state: "closed",
              stateReason: "completed",
            },
          ],
        }),
        issue(4, "depends", {
          dependencies: [
            {
              repository: "owner/project",
              number: 9,
              state: "closed",
              stateReason: "completed",
            },
          ],
        }),
      ],
      {
        repository: "owner/project",
        closedIssues: [9],
        changedFiles: ["x", "src/lib/x.ts"],
      },
    ),
  ).toEqual([2, 4]);
});
