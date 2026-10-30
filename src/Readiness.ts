import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Data, Effect } from "effect";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { z } from "zod";
import { writePrivateRecord } from "./writePrivateRecord.js";

/** A readiness run stopped without authorizing further planning. */
class ReadinessError extends Data.TaggedError("ReadinessError")<{
  message: string;
  cause?: unknown;
}> {}

const evidenceSchema = z
  .object({
    path: z
      .string()
      .trim()
      .min(1)
      .refine(
        (path) => !/:\d+(?::\d+)?(?:-\d+)?$|#L\d+(?:-L?\d+)?$/.test(path),
        "Evidence path must not include line numbers; put line details in claim and keep path as the plain file path or exact supplied host reference",
      ),
    claim: z.string().trim().min(1),
  })
  .strict();
const gateSchema = z
  .object({
    id: z.string().trim().min(1),
    status: z.enum(["satisfied", "open"]),
    reason: z.string().trim().min(1),
    evidence: z.array(evidenceSchema),
  })
  .strict();
const statusSchema = z.enum([
  "ready-for-agent",
  "ready-for-qualification",
  "blocked",
  "not-implementation",
]);
const decisionSchema = z
  .object({
    number: z.number().int().positive(),
    status: statusSchema,
    reason: z.string().trim().min(1),
    evidence: z.array(evidenceSchema).optional(),
    gates: z.array(gateSchema).optional(),
  })
  .strict();
const assessmentSchema = z
  .object({
    head: z.string(),
    decisions: z.array(decisionSchema),
  })
  .strict();

/** Agent proposal, never sufficient authorization to publish on its own. */
export interface ReadinessAssessment {
  /** Integration commit being assessed. */
  head: string;
  /** Exactly one decision per scoped issue. */
  decisions: {
    /** GitHub issue number. */
    number: number;
    /** Proposed readiness classification. */
    status:
      | "ready-for-agent"
      | "ready-for-qualification"
      | "blocked"
      | "not-implementation";
    /** Evidence references and unresolved requirements. */
    reason: string;
    /** Structured claims, not authorization. Paths identify plain source files or exact supplied host references; line details belong in claim. Legacy callbacks may omit these; strict project verifiers require them. */
    evidence?: { path: string; claim: string }[];
    /** One accounting row per project-declared gate; the host independently verifies satisfaction. */
    gates?: {
      id: string;
      status: "satisfied" | "open";
      reason: string;
      evidence: { path: string; claim: string }[];
    }[];
  }[];
}

/** An explicitly declared dependency, including cross-repository dependencies. */
export interface ReadinessDependency {
  /** Canonical owner/repository. */
  repository: string;
  /** GitHub issue number. */
  number: number;
  /** Tracker state; closure alone does not prove integration. */
  state: string;
  /** GitHub closure reason; only completed is eligible. */
  stateReason: string | null;
}

/** Complete tracker contract provided to both the agent and host verifier. */
export interface ReadinessIssue {
  /** GitHub issue number. */
  number: number;
  /** Full title. */
  title: string;
  /** Full body, including nested/free-form gates without heuristic truncation. */
  body: string;
  /** All labels, in stable order. */
  labels: string[];
  /** Tracker state at assessment time. */
  state: string;
  /** Optimistic freshness evidence. */
  updatedAt: string;
  /** All comment pages, including edit timestamps. */
  comments: { id: number; body: string; updatedAt: string }[];
  /** Native GitHub and dependency-section references. */
  dependencies: ReadinessDependency[];
}

/** Immutable input for a single assessment. */
export interface ReadinessSnapshot {
  /** Explicit GitHub repository; never inferred from the upstream remote. */
  repository: string;
  /** Local integration commit assessed. */
  head: string;
  /** Every open non-PR issue with the configured scope label. */
  issues: ReadinessIssue[];
  /** Read-only parent/context contracts bound to the same freshness checks; no decisions or mutations. */
  context?: ReadinessIssue[];
}

/** Provenance distinguishes initial reconciliation from a completed batch. */
export type ReadinessTrigger =
  | { kind: "startup" }
  | {
      kind: "post-merge";
      base: string;
      branches: string[];
      issues: number[];
      completionSignal: string;
    };

/** Configuration for reusable GitHub workflows, not just generated templates. */
export interface GitHubReadinessOptions {
  /** Host checkout containing the integrated source. */
  cwd: string;
  /** Explicit owner/repository. */
  repository: string;
  /** Stable automation scope label, separate from readiness state. */
  scopeLabel: string;
  /** Default report-only: do not mutate GitHub. */
  mode?: "report-only" | "apply";
  /** Label used by the planner; defaults to ready-for-agent. */
  readyLabel?: string;
  /** Label denoting blocked work; defaults to blocked. */
  blockedLabel?: string;
  /** Any of these labels prevents automated publication; defaults to readiness:hold. */
  holdLabels?: string[];
  /** Label for a separately allowlisted project qualification lane; never admits implementation. */
  qualificationLabel?: string;
  /** Publish a managed readiness summary without changing original acceptance/dependencies. Default false. */
  publishBody?: boolean;
  /** Related parent/spec issue IDs outside execution scope, included in freshness checks but never published. */
  contextIssueNumbers?: number[];
  /**
   * After a merge, assess only issues whose readiness can have changed:
   * dependents of the merged issues, issues whose body or comments mention a
   * file changed by the merge, and issues carrying `reassessLabel`
   * (default `readiness:reassess`). Ignored for startup; falls back to a full
   * assessment when the changed files cannot be computed. Issues outside the
   * set keep their previous readiness record.
   */
  incremental?: boolean | { reassessLabel?: string };
  /** Why this reconciliation is running. */
  trigger: ReadinessTrigger;
  /** Read-only assessment callback. The host distrusts and validates its output. */
  assess: (snapshot: ReadinessSnapshot) => Promise<unknown>;
  /** Trusted project-owned verifier of all gates/holds and dependency integration. Required in apply mode. */
  verify?: (input: ReadinessVerificationInput) => Promise<unknown>;
}

/** Input to a project-owned verifier, not a command chosen by an issue or agent. */
export interface ReadinessVerificationInput {
  /** Full source and tracker contract to verify. */
  snapshot: ReadinessSnapshot;
  /** Agent proposals requiring independent checks. */
  assessment: ReadinessAssessment;
  /** Startup or verified merge provenance. */
  trigger: ReadinessTrigger;
}

/** Result produced by the trusted project verifier; still validated at runtime. */
export interface ReadinessVerification {
  /** Must match the assessed integration commit. */
  head: string;
  /** Approve every non-held decision only after independently checking its full contract. */
  approved: {
    number: number;
    status:
      | "ready-for-agent"
      | "ready-for-qualification"
      | "blocked"
      | "not-implementation";
  }[];
  /** Dependency owner/repo#number mapped to a commit reachable from head. */
  dependencyCommits: Record<string, string>;
  /** Host-approved qualification program IDs by issue; required for qualification promotion, never executes them. */
  qualificationPrograms?: Record<string, string>;
}

const verificationSchema = z
  .object({
    head: z.string(),
    approved: z.array(
      z
        .object({ number: z.number().int().positive(), status: statusSchema })
        .strict(),
    ),
    dependencyCommits: z.record(
      z.string(),
      z.string().regex(/^[a-f0-9]{40,64}$/),
    ),
    qualificationPrograms: z
      .record(z.string(), z.string().trim().min(1))
      .optional(),
  })
  .strict();

/** Persisted outcome; auditPath also records failed/partial publication. */
export interface ReadinessResult {
  /** Effective publication mode. */
  mode: "report-only" | "apply";
  /** Structurally validated agent proposal. */
  assessment: ReadinessAssessment;
  /** Issues whose labels were changed and read back successfully. */
  applied: number[];
  /** Local, private audit record. */
  auditPath: string;
}

function fail(message: string): never {
  throw new ReadinessError({ message });
}
const run = async (cwd: string, file: string, args: string[]) =>
  (
    await new Promise<string>((resolve, reject) =>
      execFile(
        file,
        args,
        {
          cwd,
          encoding: "utf8",
          timeout: 90_000,
          maxBuffer: 32 * 1024 * 1024,
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      ),
    )
  ).trim();
const git = (cwd: string, ...args: string[]) => run(cwd, "git", args);
const api = async (cwd: string, endpoint: string) =>
  JSON.parse(await run(cwd, "gh", ["api", endpoint]));
const pages = async (cwd: string, endpoint: string): Promise<any[]> =>
  JSON.parse(
    await run(cwd, "gh", ["api", endpoint, "--paginate", "--slurp"]),
  ).flat();

function explicitDependencies(body: string, repository: string) {
  const refs = new Map<string, { repository: string; number: number }>();
  let depth: number | undefined;
  for (const line of body.split("\n")) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      if (depth !== undefined && heading[1]!.length <= depth) depth = undefined;
      if (/^(dependencies|blocked by|depends on)\b/i.test(heading[2]!))
        depth = heading[1]!.length;
    }
    if (
      depth === undefined &&
      !/^\s*(?:[-*]\s*)?(?:\*\*)?(?:depends on|blocked by|dependencies)\b/i.test(
        line,
      )
    )
      continue;
    for (const match of line.matchAll(
      /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)|(?:([\w.-]+\/[\w.-]+))?#(\d+)/g,
    )) {
      const ref = {
        repository: match[1] ?? match[3] ?? repository,
        number: Number(match[2] ?? match[4]),
      };
      refs.set(`${ref.repository}#${ref.number}`, ref);
    }
  }
  return [...refs.values()];
}

async function loadIssue(
  cwd: string,
  repository: string,
  number: number,
): Promise<ReadinessIssue> {
  const row = await api(cwd, `repos/${repository}/issues/${number}`);
  const refs = new Map(
    explicitDependencies(row.body ?? "", repository).map((ref) => [
      `${ref.repository}#${ref.number}`,
      ref,
    ]),
  );
  for (const dependency of await pages(
    cwd,
    `repos/${repository}/issues/${number}/dependencies/blocked_by?per_page=100`,
  )) {
    const match =
      /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)$/.exec(
        dependency.html_url,
      );
    if (!match) fail(`Unrecognized dependency URL for #${number}`);
    refs.set(`${match[1]}#${match[2]}`, {
      repository: match[1]!,
      number: Number(match[2]),
    });
  }
  return {
    number: row.number,
    title: row.title,
    body: row.body ?? "",
    state: row.state,
    updatedAt: row.updated_at,
    labels: row.labels.map((label: { name: string }) => label.name).sort(),
    comments: (
      await pages(
        cwd,
        `repos/${repository}/issues/${number}/comments?per_page=100`,
      )
    )
      .map((comment) => ({
        id: comment.id,
        body: comment.body,
        updatedAt: comment.updated_at,
      }))
      .sort((a, b) => a.id - b.id),
    dependencies: (
      await Promise.all(
        [...refs.values()].map(async (ref) => {
          const dependency = await api(
            cwd,
            `repos/${ref.repository}/issues/${ref.number}`,
          );
          return {
            ...ref,
            state: dependency.state,
            stateReason: dependency.state_reason ?? null,
          };
        }),
      )
    ).sort((a, b) =>
      `${a.repository}#${a.number}`.localeCompare(
        `${b.repository}#${b.number}`,
      ),
    ),
  };
}

/** Scope and label policy shared by assessment and planner inventory. */
export type GitHubReadinessInventoryOptions = Pick<
  GitHubReadinessOptions,
  | "cwd"
  | "repository"
  | "scopeLabel"
  | "readyLabel"
  | "blockedLabel"
  | "holdLabels"
  | "contextIssueNumbers"
>;

/** A host diagnosis of one issue; it never authorizes publication or execution. */
export interface ReadinessExclusion {
  /** Explicit task kind; qualification and meta tasks have no implementation admission. */
  kind: "implementation" | "qualification" | "meta";
  /** Full contract retained for project-owned gate/qualification diagnostics. */
  issue: ReadinessIssue;
  /** Every applicable deterministic exclusion, not just the first failure. */
  reasons: {
    /** Machine-readable reason for excluding this issue. */
    code:
      | "not-open"
      | "out-of-scope"
      | "blocked-label"
      | "missing-ready-label"
      | "manual-hold"
      | "unresolved-dependency"
      | "not-implementation"
      | "dependency-cycle";
    /** Tracker facts and the next check required; not a gate satisfaction claim. */
    detail: string;
  }[];
}

/** Full scoped backlog plus the current execution frontier at one clean checkout. */
export interface GitHubReadinessBacklog {
  /** Complete input for project-specific gate/evidence and qualification policy. */
  snapshot: ReadinessSnapshot;
  /** Named integration checkout captured with the source HEAD. */
  branch: string;
  /** Issues passing the host's state, hold, kind and dependency checks. */
  eligible: ReadinessIssue[];
  /** Scoped issues that still remain; an empty eligible list is not completion. */
  excluded: ReadinessExclusion[];
}

/** A selected batch bound to the source and contracts the planner actually saw. */
export interface GitHubReadinessBatch {
  /** Original planning snapshot, not a newly substituted inventory. */
  snapshot: ReadinessSnapshot;
  /** Integration checkout used during planning. */
  branch: string;
  /** Unique, positive issue numbers selected by the planner. */
  issues: number[];
}

/** Fresh execution contracts and immutable source baseline for worktree creation. */
export interface GitHubReadinessAdmission {
  /** Commit from which new issue branches must fork. */
  head: string;
  /** Integration branch that must remain checked out until merge. */
  branch: string;
  /** Selected issues after host refresh and contract equality checks. */
  issues: ReadinessIssue[];
}

function issueKind(issue: ReadinessIssue): ReadinessExclusion["kind"] {
  if (
    issue.labels.some((label) =>
      ["live-validation", "ready-for-qualification"].includes(
        label.toLowerCase(),
      ),
    ) ||
    /\*\*Kind:\*\*\s*live-validation\b/i.test(issue.body)
  )
    return "qualification";
  if (
    issue.labels.some((label) =>
      ["meta", "prd", "epic", "spec", "tracking"].includes(label.toLowerCase()),
    ) ||
    /\*\*Kind:\*\*\s*meta\b/i.test(issue.body)
  )
    return "meta";
  return "implementation";
}

const nonImplementation = (issue: ReadinessIssue) =>
  issueKind(issue) !== "implementation";

function exclusions(
  issue: ReadinessIssue,
  options: GitHubReadinessInventoryOptions,
): ReadinessExclusion["reasons"] {
  const reasons: ReadinessExclusion["reasons"] = [];
  if (issue.state !== "open")
    reasons.push({
      code: "not-open",
      detail: "Refresh the issue state before selection.",
    });
  if (!issue.labels.includes(options.scopeLabel))
    reasons.push({
      code: "out-of-scope",
      detail: "Issue is no longer in the configured automation scope.",
    });
  if (nonImplementation(issue))
    reasons.push({
      code: "not-implementation",
      detail:
        "Use the project-owned specification or qualification stage contract.",
    });
  if (issue.labels.includes(options.blockedLabel ?? "blocked"))
    reasons.push({
      code: "blocked-label",
      detail: "Resolve the blocker through evidence-backed readiness.",
    });
  if (!issue.labels.includes(options.readyLabel ?? "ready-for-agent"))
    reasons.push({
      code: "missing-ready-label",
      detail:
        "Reassess the full issue contract with the project verifier at this HEAD.",
    });
  const holds = issue.labels.filter((label) =>
    (options.holdLabels ?? ["readiness:hold"]).includes(label),
  );
  if (holds.length)
    reasons.push({
      code: "manual-hold",
      detail: `Resolve authoritative holds: ${holds.join(", ")}.`,
    });
  for (const dependency of issue.dependencies) {
    if (dependency.state !== "closed" || dependency.stateReason !== "completed")
      reasons.push({
        code: "unresolved-dependency",
        detail: `${dependency.repository}#${dependency.number} is ${dependency.state}/${dependency.stateReason ?? "unknown"}; require its completed outcome.`,
      });
  }
  return reasons;
}

async function assertCheckout(cwd: string, head: string, branch: string) {
  if (
    (await git(cwd, "rev-parse", "HEAD")) !== head ||
    (await git(cwd, "branch", "--show-current")) !== branch ||
    (await git(cwd, "status", "--porcelain"))
  )
    fail("Source checkout changed; refresh planning before admitting a batch");
}

async function inspectBacklog(
  options: GitHubReadinessInventoryOptions,
): Promise<GitHubReadinessBacklog> {
  const head = await git(options.cwd, "rev-parse", "HEAD");
  const branch = await git(options.cwd, "branch", "--show-current");
  if (!branch) fail("Batch inspection requires a named integration branch");
  await assertCheckout(options.cwd, head, branch);
  const input = await snapshot(options, head);
  await assertCheckout(options.cwd, head, branch);
  const byNumber = new Map(input.issues.map((issue) => [issue.number, issue]));
  const visited = new Set<number>();
  const cycles = new Set<number>();
  const visit = (number: number, stack: number[]) => {
    const offset = stack.indexOf(number);
    if (offset !== -1) {
      stack.slice(offset).forEach((id) => cycles.add(id));
      return;
    }
    if (visited.has(number)) return;
    for (const dependency of byNumber.get(number)!.dependencies)
      if (
        dependency.repository === options.repository &&
        byNumber.has(dependency.number) &&
        (dependency.state !== "closed" ||
          dependency.stateReason !== "completed")
      )
        visit(dependency.number, [...stack, number]);
    visited.add(number);
  };
  for (const issue of input.issues) visit(issue.number, []);
  const excluded: ReadinessExclusion[] = [];
  const eligible: ReadinessIssue[] = [];
  for (const issue of input.issues) {
    const reasons = exclusions(issue, options);
    if (cycles.has(issue.number))
      reasons.push({
        code: "dependency-cycle",
        detail:
          "Resolve the explicit dependency cycle before selecting work; relabeling cannot resolve it.",
      });
    if (reasons.length)
      excluded.push({ kind: issueKind(issue), issue, reasons });
    else eligible.push(issue);
  }
  return { snapshot: input, branch, eligible, excluded };
}

/** Inspect all scoped issues asynchronously without changing GitHub. Product gates stay profile-owned. */
export function inspectGitHubReadinessBacklog(
  options: GitHubReadinessInventoryOptions,
): Promise<GitHubReadinessBacklog> {
  return Effect.runPromise(
    Effect.tryPromise({
      try: () => inspectBacklog(options),
      catch: (cause) =>
        new ReadinessError({
          message: "Cannot inspect readiness backlog",
          cause,
        }),
    }),
  );
}

/** Refresh once before any worktree starts; reject changed source, eligibility or selected contracts. */
export function admitGitHubReadinessBatch(
  options: GitHubReadinessInventoryOptions,
  batch: GitHubReadinessBatch,
): Promise<GitHubReadinessAdmission> {
  return Effect.runPromise(
    Effect.tryPromise({
      try: async () => {
        if (
          batch.snapshot.repository !== options.repository ||
          !batch.branch ||
          new Set(batch.issues).size !== batch.issues.length ||
          batch.issues.some(
            (number) => !Number.isSafeInteger(number) || number <= 0,
          )
        )
          fail("Invalid batch identity or duplicate issue selection");
        await assertCheckout(options.cwd, batch.snapshot.head, batch.branch);
        const fresh = await inspectBacklog(options);
        const issues = batch.issues.map((number) => {
          const before = batch.snapshot.issues.find(
            (issue) => issue.number === number,
          );
          const current = fresh.eligible.find(
            (issue) => issue.number === number,
          );
          if (!before || !current || !same(before, current))
            fail(
              `Issue #${number} changed or is no longer eligible; refresh the plan`,
            );
          return current;
        });
        await assertCheckout(options.cwd, batch.snapshot.head, batch.branch);
        return { head: batch.snapshot.head, branch: batch.branch, issues };
      },
      catch: (cause) =>
        new ReadinessError({
          message: `Batch admission failed: ${String(cause)}`,
          cause,
        }),
    }),
  );
}

async function snapshot(
  options: GitHubReadinessInventoryOptions,
  head: string,
): Promise<ReadinessSnapshot> {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(options.repository) ||
    !options.scopeLabel.trim()
  )
    fail("Explicit repository and scope label required");
  const contextNumbers = [...new Set(options.contextIssueNumbers ?? [])].sort(
    (a, b) => a - b,
  );
  if (contextNumbers.some((n) => !Number.isSafeInteger(n) || n < 1))
    fail("Context issue IDs must be positive integers");
  return {
    repository: options.repository,
    head,
    ...(contextNumbers.length
      ? {
          context: await Promise.all(
            contextNumbers.map((n) =>
              loadIssue(options.cwd, options.repository, n),
            ),
          ),
        }
      : {}),
    issues: (
      await Promise.all(
        (
          await pages(
            options.cwd,
            `repos/${options.repository}/issues?state=open&labels=${encodeURIComponent(options.scopeLabel)}&per_page=100`,
          )
        )
          .filter(
            (row) =>
              !row.pull_request &&
              !contextNumbers.includes(row.number) &&
              row.labels.some(
                (label: { name: string }) => label.name === options.scopeLabel,
              ),
          )
          .map((row) => loadIssue(options.cwd, options.repository, row.number)),
      )
    ).sort((a, b) => a.number - b.number),
  };
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

const SUMMARY_START = "<!-- sandcastle-readiness:start -->";
const SUMMARY_END = "<!-- sandcastle-readiness:end -->";
/** @internal Strip only the host-owned prefix; malformed/ambiguous ownership fails closed. */
export function stripReadinessSummary(body: string): string {
  if (!body.includes(SUMMARY_START) && !body.includes(SUMMARY_END)) return body;
  const end = body.indexOf(SUMMARY_END);
  if (
    !body.startsWith(SUMMARY_START) ||
    end < SUMMARY_START.length ||
    body.indexOf(SUMMARY_START, SUMMARY_START.length) !== -1 ||
    body.indexOf(SUMMARY_END, end + SUMMARY_END.length) !== -1
  )
    fail(
      "Malformed managed readiness body; preserve the contract and reconcile manually",
    );
  return body.slice(end + SUMMARY_END.length).replace(/^\n\n/, "");
}
function readinessBody(
  issue: ReadinessIssue,
  decision: ReadinessAssessment["decisions"][number],
  head: string,
): string {
  const text = (value: string) => value.replaceAll("<!--", "&lt;!--");
  return [
    SUMMARY_START,
    "## Current execution readiness",
    `Status: ${decision.status}.`,
    `Assessed at integrated commit \`${head}\`; this is not deployment/release acceptance.`,
    "This managed execution summary supersedes earlier readiness summaries only; original acceptance and dependencies remain unchanged.",
    text(decision.reason),
    ...(decision.gates ?? []).map(
      (g) => `- Gate ${text(g.id)}: ${g.status} — ${text(g.reason)}`,
    ),
    ...(decision.evidence ?? []).map(
      (e) => `- Evidence: ${text(e.path)} — ${text(e.claim)}`,
    ),
    SUMMARY_END,
    stripReadinessSummary(issue.body),
  ].join("\n\n");
}
function validateAssessment(input: ReadinessSnapshot, value: unknown) {
  const assessment = assessmentSchema.parse(value);
  if (assessment.head !== input.head) fail("Readiness source HEAD mismatch");
  const numbers = assessment.decisions
    .map((decision) => decision.number)
    .sort((a, b) => a - b);
  if (
    !same(
      numbers,
      input.issues.map((issue) => issue.number),
    )
  )
    fail("Readiness must cover every scoped issue exactly once");
  for (const row of assessment.decisions) {
    if (
      row.gates &&
      new Set(row.gates.map((g) => g.id)).size !== row.gates.length
    )
      fail(`Duplicate gate accounting #${row.number}`);
    if (row.gates?.some((g) => g.status === "satisfied" && !g.evidence.length))
      fail(`Satisfied gate without evidence #${row.number}`);
    if (
      row.status === "ready-for-agent" &&
      row.gates?.some((g) => g.status === "open")
    )
      fail(`Ready proposal has an open execution gate #${row.number}`);
  }
  return assessment;
}

/** Assess scoped GitHub issues at a clean source commit; default to a local report. */
export function reassessGitHubReadiness(
  options: GitHubReadinessOptions,
): Promise<ReadinessResult> {
  return Effect.runPromise(
    reassessEffect(options).pipe(Effect.provide(NodeFileSystem.layer)),
  );
}

/** Load fresh, scoped planner candidates without bypassing state labels or manual holds. */
export function loadGitHubReadinessInventory(
  options: GitHubReadinessInventoryOptions,
): Promise<ReadinessIssue[]> {
  return Effect.runPromise(
    Effect.tryPromise({
      try: async () =>
        (
          await snapshot(options, await git(options.cwd, "rev-parse", "HEAD"))
        ).issues.filter((issue) => exclusions(issue, options).length === 0),
      catch: (cause) =>
        new ReadinessError({
          message: "Cannot load readiness-aware planner inventory",
          cause,
        }),
    }),
  );
}

/** Inputs of an incremental readiness selection. */
export interface IncrementalReadinessInput {
  /** Repository of the merged issues. */
  repository: string;
  /** Issues closed by the merge. */
  closedIssues: number[];
  /** Repository-relative files changed by the merge. */
  changedFiles: string[];
  /** Label that always requests reassessment. Default readiness:reassess. */
  reassessLabel?: string;
}

/**
 * Issue numbers whose readiness can have changed after a merge: dependents of
 * a closed issue, issues whose body or comments mention a changed file path,
 * and issues labelled for reassessment. Sorted ascending.
 */
export function selectIncrementalReadiness(
  issues: readonly ReadinessIssue[],
  input: IncrementalReadinessInput,
): number[] {
  const closed = new Set(input.closedIssues);
  const label = input.reassessLabel ?? "readiness:reassess";
  // Very short paths would match unrelated prose; require a path-like name.
  const paths = input.changedFiles.filter(
    (file) => file.length >= 4 && /[./]/.test(file),
  );
  return issues
    .filter(
      (issue) =>
        issue.labels.includes(label) ||
        issue.dependencies.some(
          (dependency) =>
            dependency.repository === input.repository &&
            closed.has(dependency.number),
        ) ||
        [issue.body, ...issue.comments.map((comment) => comment.body)].some(
          (text) => paths.some((path) => text.includes(path)),
        ),
    )
    .map((issue) => issue.number)
    .sort((a, b) => a - b);
}

const reassessEffect = (options: GitHubReadinessOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const attempt = <T>(body: () => T | Promise<T>) =>
      Effect.tryPromise({
        try: async () => body(),
        catch: (cause) => new ReadinessError({ message: String(cause), cause }),
      });
    const gitDir = yield* attempt(async () =>
      resolve(
        options.cwd,
        await git(options.cwd, "rev-parse", "--git-common-dir"),
      ),
    );
    const auditDir = join(gitDir, "sandcastle", "readiness");
    const auditPath = join(auditDir, `${randomUUID()}.json`);
    yield* fs.makeDirectory(auditDir, { recursive: true, mode: 0o700 });
    const mode = options.mode ?? "report-only";
    const audit: Record<string, unknown> = {
      mode,
      trigger: options.trigger,
      status: "assessing",
      applied: [],
    };
    const persist = () =>
      writePrivateRecord(fs, auditPath, JSON.stringify(audit, null, 2));
    let sourceBranch = "";
    // Incremental scope is fixed once from the first snapshot so freshness
    // rechecks compare the same issues even if publication edits bodies.
    let scope: Set<number> | null = null;
    const restrict = (value: ReadinessSnapshot): ReadinessSnapshot =>
      scope
        ? {
            ...value,
            issues: value.issues.filter((issue) => scope!.has(issue.number)),
          }
        : value;
    yield* persist();
    const outcome = yield* Effect.gen(function* () {
      const input = yield* attempt(async () => {
        if (
          !/^[\w.-]+\/[\w.-]+$/.test(options.repository) ||
          !options.scopeLabel.trim()
        )
          fail("Explicit repository and scope label required");
        if (mode === "apply" && !options.verify)
          fail("Apply requires a host verification policy");
        if (await git(options.cwd, "status", "--porcelain"))
          fail("Readiness requires a clean integration checkout");
        const head = await git(options.cwd, "rev-parse", "HEAD");
        sourceBranch = await git(options.cwd, "branch", "--show-current");
        audit.branch = sourceBranch;
        if (options.trigger.kind === "post-merge") {
          const trigger = options.trigger;
          if (
            trigger.completionSignal !== "<promise>COMPLETE</promise>" ||
            !trigger.branches.length ||
            !trigger.issues.length ||
            head === trigger.base
          )
            fail("Readiness requires a completed, nonempty merge");
          for (const ref of [trigger.base, ...trigger.branches])
            await git(options.cwd, "merge-base", "--is-ancestor", ref, head);
          for (const number of trigger.issues) {
            const issue = await api(
              options.cwd,
              `repos/${options.repository}/issues/${number}`,
            );
            if (issue.state !== "closed" || issue.state_reason !== "completed")
              fail(`Merged issue #${number} is not closed as completed`);
          }
        }
        const full = await snapshot(options, head);
        if (options.incremental && options.trigger.kind === "post-merge") {
          const trigger = options.trigger;
          const changedFiles = await git(
            options.cwd,
            "diff",
            "--name-only",
            trigger.base,
            head,
          )
            .then((out) => out.split("\n").filter(Boolean))
            .catch(() => null);
          if (changedFiles) {
            const selected = selectIncrementalReadiness(full.issues, {
              repository: options.repository,
              closedIssues: trigger.issues,
              changedFiles,
              ...(typeof options.incremental === "object" &&
              options.incremental.reassessLabel
                ? { reassessLabel: options.incremental.reassessLabel }
                : {}),
            });
            scope = new Set(selected);
            audit.scope = {
              mode: "incremental",
              selected,
              excluded: full.issues
                .map((issue) => issue.number)
                .filter((number) => !scope!.has(number)),
            };
          } else
            audit.scope = { mode: "full", reason: "changed files unavailable" };
        } else audit.scope = { mode: "full" };
        const input = restrict(full);
        if (
          input.issues.some(
            (issue) =>
              issue.state !== "open" ||
              !issue.labels.includes(options.scopeLabel),
          )
        )
          fail("Tracker scope changed during snapshot");
        return input;
      });
      const head = input.head;
      audit.snapshot = input;
      const proposal = input.issues.length
        ? yield* Effect.tryPromise({
            try: () => options.assess(structuredClone(input)),
            catch: (cause) =>
              new ReadinessError({ message: "Assessment failed", cause }),
          })
        : { head, decisions: [] };
      const assessment = yield* attempt(() =>
        validateAssessment(input, proposal),
      );
      audit.assessment = assessment;
      const assertSource = async () => {
        if (
          (await git(options.cwd, "rev-parse", "HEAD")) !== head ||
          (await git(options.cwd, "branch", "--show-current")) !==
            sourceBranch ||
          (await git(options.cwd, "status", "--porcelain"))
        )
          fail("Source changed during readiness");
      };
      yield* attempt(assertSource);
      const applied: number[] = [];
      audit.applied = applied;
      if (mode === "apply") {
        const published = structuredClone(input);
        const ready = options.readyLabel ?? "ready-for-agent";
        const blocked = options.blockedLabel ?? "blocked";
        const qualification =
          options.qualificationLabel ?? "ready-for-qualification";
        const holds = options.holdLabels ?? ["readiness:hold"];
        yield* attempt(async () => {
          if (
            new Set([ready, blocked, qualification, options.scopeLabel])
              .size !== 4 ||
            [ready, blocked, qualification].some(
              (label) => !label.trim() || holds.includes(label),
            )
          )
            fail("Scope, state and hold labels must be distinct");
        });
        const verified = yield* Effect.tryPromise({
          try: () =>
            options.verify!({
              snapshot: structuredClone(input),
              assessment: structuredClone(assessment),
              trigger: structuredClone(options.trigger),
            }),
          catch: (cause) =>
            new ReadinessError({
              message: "Project verification failed",
              cause,
            }),
        });
        const verification = yield* attempt(() =>
          verificationSchema.parse(verified),
        );
        audit.verification = verification;
        const changes = yield* attempt(async () => {
          if (verification.head !== head) fail("Verifier source HEAD mismatch");
          const approvals = new Map(
            verification.approved.map((row) => [row.number, row.status]),
          );
          if (
            approvals.size !== verification.approved.length ||
            verification.approved.some(
              (row) =>
                !input.issues.some((issue) => issue.number === row.number),
            )
          )
            fail("Invalid verifier coverage");
          const changes = (
            await Promise.all(
              input.issues.map(async (issue) => {
                if (issue.labels.some((label) => holds.includes(label)))
                  return [];
                const decision = assessment.decisions.find(
                  (row) => row.number === issue.number,
                )!;
                if (approvals.get(issue.number) !== decision.status)
                  fail(
                    `Project verifier did not approve decision #${issue.number}`,
                  );
                if (
                  decision.status === "ready-for-agent" ||
                  decision.status === "ready-for-qualification"
                ) {
                  if (
                    decision.status === "ready-for-agent" &&
                    nonImplementation(issue)
                  )
                    fail(
                      `Non-implementation issue #${issue.number} cannot be ready`,
                    );
                  if (
                    decision.status === "ready-for-qualification" &&
                    (issueKind(issue) !== "qualification" ||
                      !verification.qualificationPrograms?.[
                        String(issue.number)
                      ])
                  )
                    fail(
                      `Qualification #${issue.number} requires a host-approved project program`,
                    );
                  for (const dependency of issue.dependencies) {
                    const key = `${dependency.repository}#${dependency.number}`;
                    if (
                      dependency.state !== "closed" ||
                      dependency.stateReason !== "completed"
                    )
                      fail(`Unresolved dependency ${key}`);
                    const commit = verification.dependencyCommits[key];
                    if (!commit) fail(`Missing integrated commit for ${key}`);
                    await git(
                      options.cwd,
                      "merge-base",
                      "--is-ancestor",
                      commit,
                      head,
                    );
                  }
                }
                const desired =
                  decision.status === "ready-for-agent"
                    ? ready
                    : decision.status === "ready-for-qualification"
                      ? qualification
                      : blocked;
                const remove = [ready, blocked, qualification].filter(
                  (label) => label !== desired && issue.labels.includes(label),
                );
                const add = issue.labels.includes(desired) ? [] : [desired];
                const body = options.publishBody
                  ? readinessBody(issue, decision, head)
                  : issue.body;
                return add.length || remove.length || body !== issue.body
                  ? [{ issue, add, remove, body }]
                  : [];
              }),
            )
          ).flat();
          await assertSource();
          if (!same(input, restrict(await snapshot(options, head))))
            fail("Tracker changed during readiness assessment");
          return changes;
        });
        for (const change of changes) {
          yield* attempt(async () => {
            await assertSource();
            if (
              !same(
                change.issue,
                await loadIssue(
                  options.cwd,
                  options.repository,
                  change.issue.number,
                ),
              )
            )
              fail(`Issue #${change.issue.number} changed before publication`);
          });
          audit.status = "applying";
          audit.pending = change.issue.number;
          yield* persist();
          const bodyPath = auditPath + ".body.json";
          if (change.body !== change.issue.body)
            yield* writePrivateRecord(
              fs,
              bodyPath,
              JSON.stringify({ body: change.body }),
            );
          yield* attempt(async () => {
            const endpoint = `repos/${options.repository}/issues/${change.issue.number}/labels`;
            if (change.body !== change.issue.body) {
              await run(options.cwd, "gh", [
                "api",
                `repos/${options.repository}/issues/${change.issue.number}`,
                "--method",
                "PATCH",
                "--input",
                bodyPath,
              ]);
            }
            // Remove readiness first when blocking, add readiness last when promoting.
            for (const label of change.remove)
              await run(options.cwd, "gh", [
                "api",
                `${endpoint}/${encodeURIComponent(label)}`,
                "--method",
                "DELETE",
              ]);
            if (change.add.length)
              await run(options.cwd, "gh", [
                "api",
                endpoint,
                "--method",
                "POST",
                ...change.add.flatMap((label) => ["-f", `labels[]=${label}`]),
              ]);
            const after = await loadIssue(
              options.cwd,
              options.repository,
              change.issue.number,
            );
            const expected = {
              ...change.issue,
              body: change.body,
              updatedAt: after.updatedAt,
              labels: [
                ...change.issue.labels.filter(
                  (label) => !change.remove.includes(label),
                ),
                ...change.add,
              ].sort(),
            };
            if (!same(after, expected))
              fail(
                `Readback mismatch for #${change.issue.number}; publication may be partial`,
              );
            published.issues[
              published.issues.findIndex(
                (issue) => issue.number === after.number,
              )
            ] = after;
          });
          applied.push(change.issue.number);
          delete audit.pending;
          yield* persist();
        }
        yield* attempt(assertSource);
        yield* attempt(async () => {
          if (!same(published, restrict(await snapshot(options, head))))
            fail(
              "Tracker changed during publication; reconcile the journal against a fresh snapshot",
            );
          await assertSource();
        });
      }
      audit.status = mode === "apply" ? "verified" : "reported";
      return { mode, assessment, applied, auditPath };
    }).pipe(Effect.either);
    if (outcome._tag === "Left") {
      audit.status = "failed";
      audit.error = String(outcome.left);
      yield* persist();
      return yield* Effect.fail(
        new ReadinessError({
          message: `Readiness failed: ${outcome.left.message}. Audit: ${auditPath}`,
          cause: outcome.left,
        }),
      );
    }
    yield* persist();
    return outcome.right;
  });
