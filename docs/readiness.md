# GitHub readiness reconciliation

Readiness answers whether an issue can be implemented now. It does not select a
parallel batch (planner), implement work, or certify a merge. The generated
reviewed workflow runs it at startup and after each completed merge, before the
next planner. An empty scope produces an audit without starting a model.

## Configuration

New `parallel-planner-with-review` and `codex-afk` projects receive
`.sandcastle/readiness.json` and `readiness-prompt.md`. Existing projects are not
rewritten. Non-GitHub tracker scaffolds set `mode: "disabled"`.

```json
{
  "mode": "report-only",
  "repository": "your-account/your-project",
  "scopeLabel": "Sandcastle",
  "readyLabel": "ready-for-agent",
  "blockedLabel": "blocked",
  "holdLabels": ["readiness:hold"],
  "verifyCommand": null
}
```

The generated repository is initially `null`: no readiness calls run until an
owner explicitly selects the repository. Use your fork, not upstream. Keep the
stable scope label on both ready and blocked implementation tickets. Scope,
ready and blocked labels must be distinct. Add all project hold labels to
`holdLabels`; held issues are never mutated or offered to the planner, even if
they also carry the ready label.

Once configured, the planner loads a fresh scoped inventory and requires the
ready label, no blocked/hold labels, an open issue, and completed dependencies.
In report-only mode, a proposal does not unlock work: review the local report
and update labels manually, or configure apply mode below. Repositories using
only the scope label need explicit ready labels before implementation starts.

The host needs an authenticated `gh` with REST pagination and access to native
issue dependencies. API/authentication failures stop the workflow; a failed
dependency lookup is not interpreted as an empty dependency list.

## Opt into automatic publication

Set `mode` to `apply` and `verifyCommand` to a project-owned argv array, for
example `["node", ".sandcastle/verify-readiness.mjs"]`. This command runs on the
host, in the integration checkout, with a five-minute timeout. It receives JSON
on stdin and must write exactly one JSON result to stdout; diagnostics go to
stderr. Never derive the command from issue text or agent output.

Input has `{snapshot, assessment, trigger}`. The snapshot includes the repository,
HEAD, full bodies, all comment pages/edit timestamps, labels, and native plus
explicit dependency-section references (including nested and cross-repo refs).
Trigger is `startup` or `post-merge`, with the latter's baseline, branch refs,
merged issue IDs and completion signal. Assessment proposes one status/reason
per scoped issue, with optional structured `evidence: [{path, claim}]` and
`gates: [{id, status: "satisfied" | "open", reason, evidence}]`. New assessor
prompts require these rows; legacy SDK callbacks can keep their earlier shape.
Satisfied gates need evidence, duplicate IDs are rejected, and an implementation-ready proposal
cannot contain an open gate. Qualification proposals may retain open live
acceptance gates: their trusted verifier must distinguish proven preflight from
the observations the allowlisted protocol still needs to collect. Gate evidence is a claim until the host
independently verifies its applicability and actual execution.

Evidence `path` identifies a plain repository-relative file at the supplied HEAD
or an exact host-supplied execution reference such as `host:integration`. Put
optional line details in `claim`, for example
`{"path":"src/AgentProvider.ts","claim":"Line 752: declares effort options"}`.
Source paths with `:line`, line/column or `#L` annotations are rejected during
assessment validation, before a verifier or GitHub publication is invoked.
These rules apply to both decision and gate evidence. File existence and an
agent's claim still do not prove execution; the trusted verifier owns that check.

Expected verifier output:

```json
{
  "head": "the exact snapshot HEAD",
  "approved": [{ "number": 20, "status": "ready-for-agent" }],
  "dependencyCommits": {
    "your-account/your-project#22": "full prerequisite commit SHA"
  }
}
```

The verifier must independently evaluate every non-held issue's full contract:
issue kind, manual decisions in comments, environment/live gates, tests, and
dependency integration. It must approve the proposed status of each non-held
issue; a missing/mismatched approval stops the run. Return nonzero on failures.
Do **not** implement it by copying agent decisions into `approved`. A generic
test-suite success or an evidence file's existence is not proof that every
product/live gate passed. Sandcastle deliberately supplies no always-green
verifier. A verifier for one project is not automatically valid for another.

For each dependency of a proposed ready issue, the host additionally requires
GitHub `closed` with reason `completed`, and the verifier's full commit SHA to
be an ancestor of the assessed HEAD. The verifier is responsible for proving
that SHA actually implements the prerequisite, including cross-repo provenance.
If that cannot be demonstrated in the local commit graph, keep it blocked.

The public `reassessGitHubReadiness()` accepts an equivalent trusted `verify`
callback, plus a read-only `assess` callback. `ReadinessVerificationInput` and
`ReadinessVerification` describe their contract. `loadGitHubReadinessInventory()`
provides the same fresh scope/hold/state filter to custom planners. A custom
workflow owns isolation of its assessor and its verifier configuration.

### Pinned project-policy verifier

`readinessContractHash(issue)` pins title, original body, complete comment/edit
history and dependency identities; host-owned summary text/state labels do not
invalidate it. Explicitly approve these contracts before saving a policy. Never
regenerate hashes automatically to accept agent/human edits. Unknown or edited
contracts can only stay blocked until the owner reviews the change.

`verifyReadinessPolicy({cwd, input, policy, verifyGate})` checks full/unique
decision coverage, complete declared gate accounting, holds, task lanes and
completed dependency refs reachable from HEAD. The policy maps dependency IDs
to owner-approved Git refs (prefer immutable SHAs when appropriate); the owner
must ensure those refs identify the actual verified producer implementation,
not an arbitrary ancestor. The trusted `verifyGate(id, input)` adapter executes
or independently validates the exact project gate. It returns
`{head, passed, reference}`, bound to the assessed HEAD. Do not implement it by
checking only that an agent-written receipt file exists. Host references such
as `host:integration` must correspond to actual passing checks; additional file
references must be regular tracked files, not secret/cache paths or symlinks.

Product/live authority checks belong in the adapter. A generic SDK test-suite
success cannot substitute for Shopify/cloud/billing qualification. The self-host
operator backlog declares only its offline integration gate; its driver runs
the Linux package/build/browser checks before the read-only assessor, then
verifies the proposal before publication. No npm publication or live operation
is authorized by this policy.

### Managed summaries and qualification

Opt into `publishBody: true` to replace only a host-owned prefix between
`<!-- sandcastle-readiness:start -->` and `<!-- sandcastle-readiness:end -->`.
Original AC/dependency text and unrelated labels remain intact. Malformed
ownership markers stop publication; repeated identical summaries are no-ops.
Body/label writes are checked by readback and the full-scope snapshot. GitHub
writes are not one atomic transaction: partial failures stop planning and retain
the journal for reconciliation, not blind retry or rollback over human edits.

`contextIssueNumbers: [<parent IDs>]` includes full read-only parent/spec contracts
in snapshot.context and every freshness check, but excludes them from decision
targets/publication, even if they carry the scope label.

`ready-for-qualification` additionally requires a qualification-kind issue and
a host-approved `qualificationPrograms` entry. The policy must explicitly name
the program and its execution/preflight gates. This status never admits the
implementation planner and does not pass outstanding live acceptance. Program
authorization, current account/environment checks and actual execution remain
owned by the project's qualification lane.

## Batch admission and empty-frontier diagnostics

`inspectGitHubReadinessBacklog(options)` returns the full scoped `snapshot`,
named source `branch`, `eligible` issues and `excluded` issues with all applicable
reason codes. It checks a clean, unchanged checkout around the asynchronous
tracker read. Exclusions retain full issue contracts so the project can explain
its gates. Explicit cycles, manual holds, cancelled dependencies, blocked+ready
conflicts and explicitly marked meta/qualification tasks are excluded.

`admitGitHubReadinessBatch(options, {snapshot, branch, issues})` refreshes once
before parallel worktrees start. Its input is the original planning snapshot.
It rejects changed HEAD/branch, dirty source, duplicate selections, changed
selected bodies/comments/labels/dependencies and lost eligibility. It returns
the immutable `head`, `branch` and refreshed selected contracts. Use `head` as
`createSandbox({baseBranch: head})` for new branches. Existing branches retain
their history and still require completed implementation plus a fresh review.

These checks establish tracker/source integrity; project policy still owns
product gates, meaningful acceptance evidence and stage allocations. A topology
diagnosis cannot promote labels or authorize qualification.

Reviewed/Codex AFK templates use admission before execution. They stop when no
verified branch can progress, rather than repeating an unchanged batch. An empty
plan prints the full scoped exclusion/decision report. Pending implementation
keeps the run failed; a qualification-only exit explicitly reports external
acceptance pending and leaves the issues open. Iteration-budget exhaustion with
unresolved scope is not reported as completed delivery.

## Safety, failures and observability

- The assessment agent runs in a fresh worktree without bootstrap hooks. The
  generated sandbox blanks GitHub token variables and uses a separate gh config
  directory; it retains the model authentication needed to run. Never mount
  additional tracker credentials or bake them into its image. This is a trusted
  developer workflow, not a security boundary for malicious repository code.
- Assessment commits, untracked/modified files, missing completion, invalid
  coverage, or a changed integration checkout stop the run.
- Post-merge assessment requires COMPLETE, a clean changed integration HEAD,
  ancestry of all integrated branch refs, and completed closure of merged issues.
  The project verifier must also establish the applicable cumulative/live gates;
  ancestry plus an agent signal alone is not a test certificate.
- Before publication, the host re-fetches the full inventory and each target.
  It changes only ready/blocked label deltas, not bodies, comments, issue state,
  unrelated labels or dependency edges. Unchanged decisions make no API writes.
- After all per-issue readbacks, the host re-fetches the whole scope and checks
  it against the expected published snapshot, then checks HEAD/branch/source
  again. Concurrent changes to already-published or previously untouched issues
  fail the stage; the journal preserves applied/pending outcomes for reconciliation.
- Publication is optimistic, not a multi-issue GitHub transaction. Concurrent
  edits/API failure can leave a partial update; readback failure stops the next
  planner. Inspect the audit and rerun fresh assessment—do not blindly replay an
  old proposal. Run one publishing orchestrator per repository scope.
- Audits live under the Git common directory's `sandcastle/readiness/` folder
  (normally `.git/sandcastle/readiness/`), with private permissions. They include
  full issue contracts; do not publish them. `auditPath` is printed in the log.
  Startup reports never claim that a fresh merge gate ran.
  Updates use private temporary files, fsync and atomic rename, preserving the
  last durable audit if a later write is interrupted. Directory fsync is used on
  supported POSIX local filesystems; this is not a distributed-storage guarantee.
- The dashboard shows startup and post-merge readiness nodes, failure state and
  decision summaries. It remains local/read-only and needs no Docker itself.

## Why not copy kit-demo verbatim?

The comparison used kit-demo commit `bb08816` and Sandcastle baseline `badc6406`.

| Concern          | kit-demo                                           | Generalized workflow                                     |
| ---------------- | -------------------------------------------------- | -------------------------------------------------------- |
| Publication      | Applies every assessment                           | Report-only; explicit apply + trusted verifier           |
| Scope            | Hardcoded repository, every open issue             | Explicit repository + stable label                       |
| Gates            | Heading/ID heuristics and committed-file existence | Full contract, project-specific independent verification |
| Holds            | No authoritative hold-label guard                  | Host-enforced holds, excluded from planner               |
| Startup          | Separate manual mode                               | Before first planner as well as after merge              |
| Repeated outcome | Rewrites issue text/labels                         | Label deltas only; no-op produces no GitHub writes       |
| Provenance       | Always says after verified integration             | Explicit startup/post-merge audit                        |

Standards review also found nested headings could erase kit-demo gate discovery.
The generalized code does not truncate gate sections or claim that a universal
regex can prove arbitrary project requirements.

## Verification of this change

- Build (including Effect-free public declarations), typecheck, changed-file
  formatting and `git diff --check` passed.
- The six relevant suites contain 262 passing tests: readiness API, generated
  workflow, init, Agent Map, CLI, and GitHub planner inventory.
- Generated-workflow tests use real orchestration and Git worktrees with an
  explicitly configured no-sandbox provider, and external fake model/GitHub
  executables. They cover #22 merge → #20 unlock → next batch, failed verifier
  stopping the next planner, assessor edits being rejected, and fork routing.
  They do not claim a live Docker/provider/GitHub E2E run.
- Full suite on macOS: 1,467 passed, 49 failed, 2 skipped. The same 49 failures
  reproduce in the affected suites archived from baseline `badc6406`; they
  concern existing path/worktree tests and unavailable Podman Machine. This
  change does not repair those unrelated failures.
- Independent standards and specification reviews found no remaining blockers
  after the signal, clean-checkout, freshness, Effect, and repository-routing
  fixes. No live GitHub labels were changed during verification.
