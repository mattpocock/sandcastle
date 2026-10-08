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
per scoped issue.

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
- Publication is optimistic, not a multi-issue GitHub transaction. Concurrent
  edits/API failure can leave a partial update; readback failure stops the next
  planner. Inspect the audit and rerun fresh assessment—do not blindly replay an
  old proposal. Run one publishing orchestrator per repository scope.
- Audits live under the Git common directory's `sandcastle/readiness/` folder
  (normally `.git/sandcastle/readiness/`), with private permissions. They include
  full issue contracts; do not publish them. `auditPath` is printed in the log.
  Startup reports never claim that a fresh merge gate ran.
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
