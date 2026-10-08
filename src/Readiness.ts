import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Data, Effect } from "effect";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { z } from "zod";

/** A readiness run stopped without authorizing further planning. */
class ReadinessError extends Data.TaggedError("ReadinessError")<{
  message: string;
  cause?: unknown;
}> {}

const decisionSchema = z
  .object({
    number: z.number().int().positive(),
    status: z.enum(["ready-for-agent", "blocked", "not-implementation"]),
    reason: z.string().trim().min(1),
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
    status: "ready-for-agent" | "blocked" | "not-implementation";
    /** Evidence references and unresolved requirements. */
    reason: string;
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
    status: "ready-for-agent" | "blocked" | "not-implementation";
  }[];
  /** Dependency owner/repo#number mapped to a commit reachable from head. */
  dependencyCommits: Record<string, string>;
}

const verificationSchema = z
  .object({
    head: z.string(),
    approved: z.array(decisionSchema.omit({ reason: true })),
    dependencyCommits: z.record(
      z.string(),
      z.string().regex(/^[a-f0-9]{40,64}$/),
    ),
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
>;

async function snapshot(
  options: GitHubReadinessInventoryOptions,
  head: string,
): Promise<ReadinessSnapshot> {
  return {
    repository: options.repository,
    head,
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
        ).issues.filter(
          (issue) =>
            issue.state === "open" &&
            issue.labels.includes(options.scopeLabel) &&
            issue.labels.includes(options.readyLabel ?? "ready-for-agent") &&
            !issue.labels.includes(options.blockedLabel ?? "blocked") &&
            !issue.labels.some((label) =>
              (options.holdLabels ?? ["readiness:hold"]).includes(label),
            ) &&
            issue.dependencies.every(
              (dependency) =>
                dependency.state === "closed" &&
                dependency.stateReason === "completed",
            ),
        ),
      catch: (cause) =>
        new ReadinessError({
          message: "Cannot load readiness-aware planner inventory",
          cause,
        }),
    }),
  );
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
      fs.writeFileString(auditPath, JSON.stringify(audit, null, 2), {
        mode: 0o600,
      });
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
        const input = await snapshot(options, head);
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
          (await git(options.cwd, "status", "--porcelain"))
        )
          fail("Source changed during readiness");
      };
      yield* attempt(assertSource);
      const applied: number[] = [];
      audit.applied = applied;
      if (mode === "apply") {
        const ready = options.readyLabel ?? "ready-for-agent";
        const blocked = options.blockedLabel ?? "blocked";
        const holds = options.holdLabels ?? ["readiness:hold"];
        yield* attempt(async () => {
          if (
            new Set([ready, blocked, options.scopeLabel]).size !== 3 ||
            [ready, blocked].some(
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
                if (decision.status === "ready-for-agent") {
                  if (
                    issue.labels.some((label) =>
                      ["meta", "prd", "epic", "live-validation"].includes(
                        label.toLowerCase(),
                      ),
                    ) ||
                    /\*\*Kind:\*\*\s*(?:meta|live-validation)\b/i.test(
                      issue.body,
                    )
                  )
                    fail(
                      `Non-implementation issue #${issue.number} cannot be ready`,
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
                  decision.status === "ready-for-agent" ? ready : blocked;
                const remove = [ready, blocked].filter(
                  (label) => label !== desired && issue.labels.includes(label),
                );
                const add = issue.labels.includes(desired) ? [] : [desired];
                return add.length || remove.length
                  ? [{ issue, add, remove }]
                  : [];
              }),
            )
          ).flat();
          await assertSource();
          if (!same(input, await snapshot(options, head)))
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
          yield* attempt(async () => {
            const endpoint = `repos/${options.repository}/issues/${change.issue.number}/labels`;
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
          });
          applied.push(change.issue.number);
          delete audit.pending;
          yield* persist();
        }
        yield* attempt(assertSource);
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
