import * as childProcess from "node:child_process";
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
  };
  const writes: string[][] = [];
  const fakeGh = (args: readonly string[] = []): string => {
    const argv = [...(args ?? [])].map(String);
    if (argv[0] !== "api") throw new Error(`Unexpected gh call: ${argv}`);
    const endpoint = argv[1]!;
    if (argv.includes("POST") || argv.includes("DELETE")) {
      writes.push(argv);
      transport.onWrite();
      if (argv.includes("POST")) {
        for (const arg of argv.filter((a) => a.startsWith("labels[]=")))
          issue.labels.push({ name: arg.slice(9) });
      } else
        issue.labels = issue.labels.filter(
          (l) => !endpoint.endsWith(`/${encodeURIComponent(l.name)}`),
        );
      return "";
    }
    if (endpoint.endsWith("/comments?per_page=100"))
      return JSON.stringify([transport.comments]);
    if (endpoint.endsWith("/dependencies/blocked_by?per_page=100"))
      return JSON.stringify([transport.native]);
    if (endpoint.includes("/issues?")) {
      const value = JSON.stringify([[issue]]);
      transport.onList();
      return value;
    }
    if (endpoint.endsWith("/issues/20")) return JSON.stringify(issue);
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
