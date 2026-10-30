import { Data, Effect } from "effect";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { stripReadinessSummary } from "./Readiness.js";
import type {
  ReadinessIssue,
  ReadinessVerificationInput,
  ReadinessVerification,
} from "./Readiness.js";

class PolicyError extends Data.TaggedError("ReadinessPolicyError")<{
  message: string;
  cause?: unknown;
}> {}
function fail(message: string): never {
  throw new PolicyError({ message });
}

/** Explicit, maintainer-approved contracts; never infer execution authority from agent prose. */
export interface ReadinessPolicy {
  /** Exact tracker repository. */
  repository: string;
  /** Contracts keyed by issue number. Unknown/edited contracts cannot be promoted. */
  issues: Record<
    string,
    {
      /** Hash from readinessContractHash after human contract approval. */
      contractHash: string;
      /** Execution lane; qualification is not implementation. */
      kind: "implementation" | "qualification" | "meta";
      /** Dependency repository#number -> approved local Git ref. */
      dependencies: Record<string, string>;
      /** All required gate IDs, checked by the trusted host adapter. */
      gates: string[];
      /** Exact allowlisted project program; labeling does not authorize live execution. */
      qualificationProgram?: string;
    }
  >;
  /** Manual hold labels; default readiness:hold. */
  holdLabels?: string[];
}
/** Evidence produced by a trusted host check, not loaded from an agent-authored receipt. */
export interface ReadinessGateProof {
  /** Exact tested integration commit. */
  head: string;
  /** Actual independently checked outcome. */
  passed: boolean;
  /** Stable reference supplied to the assessor, e.g. host:integration. */
  reference: string;
}

/** Pin title, original body, complete comments and dependency identities, excluding only host-managed summaries/state labels. */
export function readinessContractHash(
  issue: Pick<ReadinessIssue, "title" | "body" | "comments" | "dependencies">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: issue.title,
        body: stripReadinessSummary(issue.body),
        comments: [...issue.comments].sort((a, b) => a.id - b.id),
        dependencies: issue.dependencies
          .map((d) => `${d.repository}#${d.number}`)
          .sort(),
      }),
    )
    .digest("hex");
}

/** Independently verify an agent proposal against pinned project contracts, integrated dependencies and trusted host gate execution. No tracker writes. */
export function verifyReadinessPolicy(options: {
  /** Clean host integration checkout. */
  cwd: string;
  /** Full snapshot/proposal/provenance supplied by reassessGitHubReadiness. */
  input: ReadinessVerificationInput;
  /** Maintainer-owned policy, captured before agent execution. */
  policy: ReadinessPolicy;
  /** Trusted adapter that executes/checks the named gate and its exact source binding; never accepts an agent-chosen command. */
  verifyGate: (
    id: string,
    input: ReadinessVerificationInput,
  ) => Promise<ReadinessGateProof>;
}): Promise<ReadinessVerification> {
  return Effect.runPromise(
    Effect.tryPromise({
      try: async () => {
        const { cwd, input, policy } = options;
        const { snapshot, assessment } = input;
        const git = (...args: string[]) =>
          new Promise<string>((resolve, reject) => {
            execFile(
              "git",
              args,
              {
                cwd,
                encoding: "utf8",
                timeout: 90_000,
                maxBuffer: 1024 * 1024,
              },
              (error, out) => (error ? reject(error) : resolve(out.trim())),
            );
          });
        const branch = await git("branch", "--show-current");
        const assertSource = async () => {
          if (
            !branch ||
            (await git("rev-parse", "HEAD")) !== snapshot.head ||
            (await git("branch", "--show-current")) !== branch ||
            (await git("status", "--porcelain"))
          )
            fail(
              "Policy source changed or is not a clean named integration checkout",
            );
        };
        await assertSource();
        if (
          snapshot.repository !== policy.repository ||
          assessment.head !== snapshot.head
        )
          fail("Policy repository/source mismatch");
        if (
          assessment.decisions.length !== snapshot.issues.length ||
          new Set(assessment.decisions.map((d) => d.number)).size !==
            snapshot.issues.length ||
          assessment.decisions.some(
            (d) => !snapshot.issues.some((i) => i.number === d.number),
          )
        )
          fail("Policy requires complete unique issue coverage");
        const proofs = new Map<string, ReadinessGateProof>();
        const result: ReadinessVerification = {
          head: snapshot.head,
          approved: [],
          dependencyCommits: {},
          qualificationPrograms: {},
        };
        for (const issue of snapshot.issues) {
          const decision = assessment.decisions.find(
            (d) => d.number === issue.number,
          )!;
          if (
            issue.labels.some((l) =>
              (policy.holdLabels ?? ["readiness:hold"]).includes(l),
            )
          )
            continue;
          const rule = policy.issues[String(issue.number)];
          if (!rule || readinessContractHash(issue) !== rule.contractHash) {
            if (decision.status !== "blocked")
              fail(
                `Unknown or edited contract #${issue.number}; requires maintainer approval`,
              );
            result.approved.push({ number: issue.number, status: "blocked" });
            continue;
          }
          if (
            !decision.gates ||
            new Set(decision.gates.map((g) => g.id)).size !==
              decision.gates.length ||
            JSON.stringify(decision.gates.map((g) => g.id).sort()) !==
              JSON.stringify([...rule.gates].sort())
          )
            fail(`Incomplete policy gate accounting #${issue.number}`);
          if (decision.status === "blocked") {
            result.approved.push({ number: issue.number, status: "blocked" });
            continue;
          }
          if (decision.status === "not-implementation") {
            if (rule.kind === "implementation")
              fail(
                `Implementation #${issue.number} cannot be reclassified by the agent`,
              );
            result.approved.push({
              number: issue.number,
              status: decision.status,
            });
            continue;
          }
          if (
            issue.state !== "open" ||
            rule.kind !==
              (decision.status === "ready-for-agent"
                ? "implementation"
                : "qualification")
          )
            fail(`Policy lane mismatch #${issue.number}`);
          const declared = issue.dependencies
            .map((d) => `${d.repository}#${d.number}`)
            .sort();
          if (
            JSON.stringify(declared) !==
            JSON.stringify(Object.keys(rule.dependencies).sort())
          )
            fail(`Policy dependency mismatch #${issue.number}`);
          for (const dep of issue.dependencies) {
            const key = `${dep.repository}#${dep.number}`;
            if (dep.state !== "closed" || dep.stateReason !== "completed")
              fail(`Dependency ${key} is not completed`);
            const commit = await git(
              "rev-parse",
              `${rule.dependencies[key]}^{commit}`,
            );
            await git("merge-base", "--is-ancestor", commit, snapshot.head);
            result.dependencyCommits[key] = commit;
          }
          const gates = decision.gates;
          if (
            !decision.evidence?.length ||
            !gates ||
            new Set(gates.map((g) => g.id)).size !== gates.length ||
            JSON.stringify(gates.map((g) => g.id).sort()) !==
              JSON.stringify([...rule.gates].sort())
          )
            fail(`Incomplete policy evidence/gates #${issue.number}`);
          for (const gate of gates) {
            let proof = proofs.get(gate.id);
            if (!proof) {
              proof = await options.verifyGate(gate.id, input);
              proofs.set(gate.id, proof);
            }
            if (!proof.passed || proof.head !== snapshot.head)
              fail(`Host gate ${gate.id} did not pass at the assessed HEAD`);
            if (
              gate.status !== "satisfied" ||
              !gate.evidence.some(
                (e) => e.path === proof.reference && e.claim.trim(),
              )
            )
              fail(
                `Gate ${gate.id} lacks applicable host evidence #${issue.number}`,
              );
          }
          for (const e of [
            ...decision.evidence!,
            ...gates.flatMap((g) => g.evidence),
          ]) {
            if (
              [...proofs.values()].some(
                (p) =>
                  p.reference === e.path &&
                  p.head === snapshot.head &&
                  p.passed,
              )
            )
              continue;
            if (
              !/^[A-Za-z0-9_./-]+$/.test(e.path) ||
              e.path.startsWith("/") ||
              e.path.split("/").includes("..") ||
              /(^|\/)(\.env|\.git|\.codex|codex-home|node_modules|runs|cache)(\/|$|\.)/.test(
                e.path,
              )
            )
              fail(
                `Invalid evidence reference #${issue.number}: use a plain repository-relative file path with line details in claim, or an exact verified host reference`,
              );
            if (
              !/^100(644|755) /.test(
                await git("ls-tree", snapshot.head, "--", e.path),
              )
            )
              fail(`Evidence is not a regular committed file #${issue.number}`);
          }
          if (decision.status === "ready-for-qualification") {
            if (!rule.qualificationProgram)
              fail(`No allowlisted qualification program #${issue.number}`);
            result.qualificationPrograms![String(issue.number)] =
              rule.qualificationProgram;
          }
          result.approved.push({
            number: issue.number,
            status: decision.status,
          });
        }
        await assertSource();
        return result;
      },
      catch: (cause) =>
        cause instanceof PolicyError
          ? cause
          : new PolicyError({
              message: `Project policy verification failed: ${String(cause)}`,
              cause,
            }),
    }),
  );
}
