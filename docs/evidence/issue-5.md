# Task 5 requirement ledger

Task #5 was loaded successfully in full with
`gh issue view 5 --json number,title,body,labels,comments` at the start on
2026-10-12. Parent `hanhnghh/sandcastle#1` supplies the configuration ownership,
frozen inputs, loopback security, compatibility and browser acceptance contracts.
Baseline: `256f63bf6ddf13f2301224e3571fd1d14ecd8bf8`. Branch:
`sandcastle/issue-5`, initially clean. The task remains open for verified integration.

Environment: Linux, Node v24.21.0, npm 11.19.0, package-lock.json, installed
Vitest 3.2.4, TypeScript native preview and Playwright 1.63.0/Chromium.
Dependencies were already installed; bootstrap was unnecessary. Evidence is new
execution for this task, including retained regression tests. No old branch or
full-gate receipt is reused. The already-passing **N** and unaffected **W0** runs retain their
original timestamps below; the later F command excludes only N's four tests to
avoid replaying applicable evidence. Their interpreting harness and product
source have not changed. The workflow browser harness subsequently gained an
explicit two-project repository test; W reran that affected file only. All ten
F/N product and TypeScript harness hashes remain unchanged from the earlier
manifest (archived as issue-5-source-before-browser.sha256). Source/harness manifest:
`.sandcastle/logs/issue-5-source.sha256`, SHA-256
`4ee59fbf4a45362b2fb941578a9ad60b3d76e8478ab63c39006d78f5e0cccdb5`.
This is provenance for focused evidence, not trusted integration proof.

CodeGraph explore/query/node/impact/affected identified operator, runtime,
CLI and init callers. Graph misses for new workflow symbols and exact template
wire contracts were resolved by direct reads. Required host coding standards,
feedback loops and evidence policy were read completely before editing.

## Executable commands

- **F**: `npm test -- src/OperatorWorkflow.test.ts src/Operator.test.ts src/OperatorEnvironment.test.ts src/OperatorPrompts.test.ts src/OperatorCli.test.ts src/OperatorGenerated.test.ts src/Readiness.test.ts src/ReadinessPolicy.test.ts src/ReadinessWorkflow.test.ts src/InitService.test.ts src/InitService.agents.test.ts src/InitService.packageManager.test.ts src/InitService.sandboxProviders.test.ts src/run.test.ts -t '^(?!configured Codex workflow)' --run`
- **N**: `npm test -- src/ReadinessWorkflow.test.ts -t 'configured Codex workflow' --run`
- **W**: `node --test scripts/operator-workflow.browser.test.mjs`
- **W0**: `node --test scripts/operator-workflow.browser.test.mjs scripts/operator.browser.test.mjs scripts/operator-environment.browser.test.mjs` (original 16:29 run; the nine unchanged operator/environment tests remain applicable, and W replaced its workflow-file receipt)
- **T**: `npm run typecheck`
- **B**: `npm run build` (including public Effect-free declaration validation)
- **D**: `git diff --check` and `npx prettier --check README.md docs/operator.md .changeset/operator-workflow-settings.md src/OperatorWorkflow.ts src/OperatorWorkflow.test.ts src/OperatorRuntime.ts src/OperatorServer.ts src/OperatorCli.test.ts src/OperatorGenerated.test.ts src/ReadinessWorkflow.test.ts src/InitService.ts src/index.ts src/operatorAssets.ts scripts/operator-workflow.browser.test.mjs docs/evidence/issue-5.md`
- **A**: `node --input-type=module` documentation example validator below.
- **I**: `bash .sandcastle/scripts/verify-affected.sh <batch-base-sha>` on the exact integrated committed source. The integration owner supplies its immutable batch baseline. This owns the authoritative typecheck/full npm test/build/Agent Map browser gate, not a branch pass or waiver.

## Exact test names

- **E1**: workflow settings persist without changing project standards or qualification adapters
- **E2**: invalid workflow settings are atomic through the project-scoped HTTP interface
- **E3**: frozen workflow schedules at its configured concurrency and later saves affect only later runs
- **E4**: trusted feedback gates and verifier execute only frozen declarations and retain project holds
- **E5**: HTTP observes frozen workflow outcomes without exposing declarations or credential output
- **E6**: workflow files and configuration directories cannot route settings into another project via symlinks
- **E7**: reopening a runtime rejects tampered trusted feedback policy and effective holds are immutable
- **E8**: legacy frozen role records reopen without inventing workflow policy
- **C1**: operator CLI serves only its explicit project and hands its frozen runtime to the fixed workflow
- **G1**: generated 'parallel-planner-with-review'/'node', 'codex-afk'/'node', and 'codex-afk'/'android' uses the selected immutable image at Docker's boundary (now also missing-repository rejection before launch)
- **G2**: generated parallel-planner-with-review / codex-afk stops at the saved cycle limit without starting a later task
- **G3**: shared Codex runtime preserves 'fresh admission', 'blocked completion', 'blocked review', 'merger completion', 'readiness checkout integrity', and 'post-merge verification' guards
- **G4**: configured Codex workflow records 'no-progress' / 'qualification-pending' without closing unfinished issues
- **G5**: configured Codex workflow cannot implement held or meta tasks: READINESS_FIXTURE_HOLD / READINESS_FIXTURE_META
- **R1**: requires completed and integrated nested/cross-repo dependencies: open / not_planned / missing integration / not ancestor / integrated
- **R2**: rejects stale-head / edited-contract / open-dependency / unintegrated-producer instead of trusting a ready proposal
- **R3**: defaults to report-only, assesses the full scoped contract and records an audit without GitHub writes
- **R4**: fails closed for changed comments / changed body / changed labels / changed branch / dirty checkout / missing verifier (and retained parameterized publication cases); rejects a tracker edit during final publication readback and retains the journal; rejects a change to an already published issue while another issue is being published
- **R5**: does not admit a manually ready meta task; preserves manual holds and excludes held or blocked issues from planning; rejects a stale batch before execution when body / hold / closed / source / branch / duplicate changes
- **R6**: stops a no-progress batch after one implementation attempt; reports pending external qualification without implementing or closing its issue; reviews retained branch commits before integration when the resumed implementer adds none
- **W1**: workflow browser configuration and diagnostics: persistence, keyboard, limits, invalid settings, verifier, gate failure and qualification
- **W2**: existing operator/environment browser regression names retained in W0 (nine unchanged tests)
- **W3**: workflow browser repository settings and frozen runs isolate selected projects

W and retained W0 cover eleven distinct passing browser tests.

## Implementation requirement matrix (historical)

Receipt/applicability **S** means the source/harness manifest above and Linux
fake provider/tracker/Docker process boundaries, with real runtime/orchestration,
Git fixtures, HTTP and Playwright where named. **P** means the unchanged public
readiness/policy validators plus the configured generated consumer in S.
**L** means English-only root README/operator guide, new uniquely named minor
changeset and the documented public SDK example validator; no translated
operator document exists. Each row is independently mapped; no future branch
work is hidden in the integration row.

| ID  | source                    | requirement                                                                            | public seam                              | exact test                                                                         | command | evidence (new/reused) | receipt/applicability                                     | owner             | status              |
| --- | ------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------- | ------- | --------------------- | --------------------------------------------------------- | ----------------- | ------------------- |
| 01  | #5 AC1,6                  | Web/CLI shared save/reload                                                             | HTTP, SDK, CLI                           | E1, E2, C1, W1                                                                     | F, W    | new                   | S                                                         | implementer       | verifying           |
| 02  | #5 AC1                    | Invalid labels reject atomically                                                       | HTTP                                     | E2: control/shell syntax, state/hold collision                                     | F       | new                   | S                                                         | implementer       | verifying           |
| 03  | #5 AC1                    | Invalid repository rejects atomically                                                  | HTTP                                     | E2: URL instead of owner/repository                                                | F       | new                   | S                                                         | implementer       | verifying           |
| 04  | #5 AC1                    | Invalid limits reject atomically                                                       | HTTP                                     | E2: zero cycles, fractional concurrency, excess planner attempts                   | F       | new                   | S                                                         | implementer       | verifying           |
| 05  | #5 AC1                    | Invalid gate/verifier references reject atomically                                     | HTTP                                     | E2: unknown references, missing apply verifier                                     | F       | new                   | S                                                         | implementer       | verifying           |
| 06  | #5 AC1                    | Preserve unrelated standards and qualification adapters                                | SDK, frozen policy                       | E1, E4                                                                             | F       | new                   | S                                                         | implementer       | verifying           |
| 07  | #5 AC2                    | Concurrency changes actual fake-run scheduling, settles failures                       | Runtime API, browser fake provider       | E3, W1                                                                             | F, W    | new                   | S                                                         | implementer       | verifying           |
| 08  | #5 AC2                    | Iteration settings stop actual generated workflows                                     | Generated workflow/provider/tracker      | G2 both templates                                                                  | F       | new                   | S                                                         | implementer       | verifying           |
| 09  | #5 AC2,5; #1 freeze       | Active configuration immutable; saves only affect later runs                           | Runtime API, HTTP, CLI                   | E3, E5, E7, C1                                                                     | F       | new                   | S                                                         | implementer       | verifying           |
| 10  | #5 AC3,6                  | Explicit repository; project/repository isolation                                      | HTTP, CLI, generated tracker/process     | E1, E2, C1, G1, G3                                                                 | F       | new                   | S: fake gh rejects wrong GH_REPO; upstream remote differs | implementer       | verifying           |
| 11  | #5 AC3                    | Dependencies completed and integrated                                                  | Readiness/policy API, generated tracker  | R1 all five states, R2 open/unintegrated, generated two-batch workflow             | F       | new                   | P                                                         | implementer       | verifying           |
| 12  | #5 AC3                    | Holds cannot be bypassed by settings/proposals                                         | Runtime policy, generated workflow       | E4, E7, R5 hold, G5 HOLD                                                           | F, N    | new                   | P: configured limits; trusted holds retained              | implementer       | verifying           |
| 13  | #5 AC3                    | Meta tasks cannot be bypassed                                                          | Readiness API, generated workflow        | R5 meta, G5 META                                                                   | F, N    | new                   | P                                                         | implementer       | verifying           |
| 14  | #5 AC3                    | Stale source/contracts cannot be bypassed                                              | Admission, policy, generated workflow    | R2 stale/edited, R4, R5 stale batch, G3 fresh admission/checkout                   | F       | new                   | P                                                         | implementer       | verifying           |
| 15  | #5 AC3                    | Incomplete reviews cannot be bypassed                                                  | Generated workflow                       | G3 blocked review/completion/merger, R6 retained commits                           | F       | new                   | P                                                         | implementer       | verifying           |
| 16  | #5 AC4                    | Report-only default; apply requires trusted verifier                                   | SDK, HTTP, browser, readiness API        | E1, E2, E4, R3, R4 missing verifier, W1                                            | F, W    | new                   | S, P                                                      | implementer       | verifying           |
| 17  | #5 AC4                    | Full-contract/publication integrity retained                                           | Readiness/policy API, generated workflow | R2, R4 publication cases, G3 post-merge                                            | F       | new                   | P                                                         | implementer       | verifying           |
| 18  | #5 AC4,6                  | Web shows missing verifier, gate failures, pending qualification                       | HTTP, browser                            | E5, W1                                                                             | F, W    | new                   | S                                                         | implementer       | verifying           |
| 19  | #5 AC5                    | Execute only frozen project-declared commands/references; required gates retained      | Runtime verification API                 | E2 rejects executable fields, E4 required gate and changed declarations, E7 tamper | F       | new                   | S                                                         | implementer       | verifying           |
| 20  | #5 AC5                    | Config/diagnostics exclude credential values                                           | HTTP, browser, runtime API               | E2 rejects credential fields, E4 safe error and hidden argv, E5, W1                | F, W    | new                   | S                                                         | implementer       | verifying           |
| 21  | #5 AC6                    | No-progress and qualification-only outcomes with fake boundaries                       | Generated workflow, HTTP/browser         | G4 both outcomes, R6, E5, W1                                                       | F, N, W | new                   | S                                                         | implementer       | verifying           |
| 22  | #1 security/compatibility | Loopback/session/project boundaries; symlink isolation; old frozen roles remain usable | HTTP, SDK, browser                       | E2 origin/query, E6, E8; retained Operator tests, W2                               | F, W    | new                   | S                                                         | implementer       | verifying           |
| 23  | #5 AC6                    | Document; unique minor changeset                                                       | User-visible artifacts, public SDK       | A documented JSON examples; D inspection                                           | A, D    | new                   | L                                                         | implementer       | verifying           |
| 24  | feedback loops            | Affected SDK/CLI/template type/build checks                                            | Package/compiler/declarations            | F affected callers, T, B                                                           | F, T, B | new                   | S                                                         | implementer       | verifying           |
| 25  | feedback loops            | Exact integrated-source authoritative gate                                             | Integration script                       | Cumulative package/browser qualification                                           | I       | future                | Exact integrated source and immutable batch base          | integration owner | pending-integration |

## Tracer-bullet and diagnosis record

- Persistence RED 16:10 UTC: public load API absent. GREEN 16:11: save/reload
  and preservation test passes, followed by typecheck.
- HTTP validation RED 16:12: route returned 404. GREEN: protected GET/PUT,
  atomic rejection and safe errors pass. An overly specific error-prefix
  expectation was resolved with a consistent workflow field prefix; unknown
  JSON response type fixed before typecheck passed.
- Frozen scheduling RED 16:12: workflow evidence absent. GREEN 16:13: reopened
  runtime retains limits, real fake callbacks reach concurrency 2 versus 1,
  failures settle and later saves do not affect active evidence.
- Feedback RED 16:14: required-gate declaration unsupported. GREEN: frozen
  trusted argv, mandatory gates/holds, JSON verifier input and safe failure
  diagnostics pass; no issue/model executable text is interpreted.
- Generated cycles RED 16:15: both templates completed the later task despite
  saved cycles=1. GREEN 16:17: both stop after the first integrated batch.
- HTTP outcomes RED 16:17: diagnostics absent. GREEN 16:18: public runtime
  outcome reporting is observed through HTTP and survives the CLI child seam.
- Browser RED 16:19: workflow form absent. GREEN 16:21: save/reload, errors,
  keyboard, changed fake concurrency, gate failure and qualification pass.
  Browser selector initially matched both Readiness model and Readiness mode;
  exact label matching repaired this harness ambiguity without product changes.
- Symlink RED 16:21: redirected config was readable. GREEN: reads/saves reject
  file/directory links and preserve the other project.
- Integrity RED 16:22: effective holds were mutable. GREEN 16:23: deep freeze
  and frozen policy/declaration digest verification, including tampered reopen.
- Explicit repository RED 16:24: missing repository reached Docker agent launch.
  GREEN 16:29: all three generated Node/Android consumers stop before launch.
  Enabling real readiness exposed untracked fixture bin/dependency/log files;
  ignoring owned runtime artifacts and committing fixture source restored the
  independent clean-checkout invariant. This was a proven harness issue, not a
  product waiver. Selected immutable image/auth/cache mount regressions still pass.
- Legacy records RED 16:27: role-only record rejected on reopen. GREEN 16:29:
  original operations remain compatible; new workflow operations fail explicitly
  rather than reading live policy.
- N passed 2026-10-12 16:31:07 UTC: four new configured workflow cases, 32.88s.
  Source/harness unchanged afterward. W passed 16:29:47 UTC: ten operator
  browser tests, 10.95s. B passed 16:29 UTC including public type validation;
  only the ReadinessWorkflow test harness changed afterward, not build inputs.
- Final F passed: 2026-10-12 16:32:30 UTC start, 237.07s, 483 passed and
  exactly N's four previously verified tests excluded. F + N cover all 487
  focused tests. Receipt: ignored `.sandcastle/logs/issue-5-focused.log` plus
  the tool execution's exit code 0. No source or TypeScript harness changed
  during/after F. Final T passed at 16:32 UTC. D formatting/diff checks passed.
- W passed at 16:37 UTC: two current workflow browser tests, 4.74s, including
  explicit two-project repository isolation and separately frozen run views.
  Together with the nine unchanged W0 tests, eleven distinct browser tests pass.
- Documentation example validator A passed; every existing changeset was
  inspected before adding the uniquely named minor changeset. English operator
  documentation has no localized counterpart requiring an update. Final scoped
  inspection excludes generated builds, credentials and ignored receipts/logs.
  No unknown environment failure is classified as pre-existing or waived.
- All branch-required rows pass. I remains pending-integration and the issue
  remains open. Completion denotes a signed-off task-scoped commit ready for
  review, not integration verification or issue closure.

## Documentation example validator (A)

Executed 2026-10-12 with `node --input-type=module`; passed. The executable
checks the documented workflow and host declaration examples through the built
public save/read/inspect APIs, and the changeset package/minor contract:

````js
import assert from "node:assert/strict";
import {
  readFile,
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  saveWorkflowConfig,
  loadWorkflowConfig,
  inspectWorkflow,
} from "./dist/index.js";
const guide = await readFile("docs/operator.md", "utf8");
const examples = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
  JSON.parse(match[1]),
);
const workflow = examples.find((example) =>
  Object.hasOwn(example, "repository"),
);
const declarations = examples.find((example) =>
  Object.hasOwn(example, "verifiers"),
);
assert.ok(workflow);
assert.ok(declarations);
const cwd = await mkdtemp(join(tmpdir(), "workflow-docs-"));
try {
  await mkdir(join(cwd, ".sandcastle"));
  await writeFile(
    join(cwd, ".sandcastle/feedback-gates.json"),
    JSON.stringify(declarations),
  );
  const saved = await saveWorkflowConfig({ cwd, config: workflow });
  assert.deepEqual(await loadWorkflowConfig({ cwd }), saved);
  const view = await inspectWorkflow({ cwd });
  assert.deepEqual(view.requiredGates, ["tests"]);
  assert.deepEqual(view.references.verifiers, ["project"]);
  const changeset = await readFile(
    ".changeset/operator-workflow-settings.md",
    "utf8",
  );
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  assert.ok(changeset.includes(`"${pkg.name}": minor`));
  await access("docs/operator.md");
} finally {
  await rm(cwd, { recursive: true, force: true });
}
````

## Independent review (2026-10-12)

Reviewer source starts at `be3a824` against immutable baseline
`256f63bf6ddf13f2301224e3571fd1d14ecd8bf8`. Task body/labels/comments read
successfully with the required gh command. Parent product decisions and delivery
acceptance inform ownership, freezing, security and public/browser coverage.
All three host policies were read completely before feedback selection.

Before checks, all rows 01–24 were marked needing **new reviewer evidence**.
Implementer receipts remain historical records; none supplies reviewer proof. Reviewer
commands cover the workflow/HTTP SDK, operator CLI, generated Codex consumers,
readiness/policy guards, init callers and retained operator contracts. Browser
checks cover workflow plus existing operator/environment forms. Typecheck/build
are reviewer-owned; the exact integrated full gate remains integration-owned.

Findings repaired:

- R1: Settings accept collisions with trusted project hold/qualification labels,
  although apply later rejects them. Require atomic HTTP save rejection.
- R2: Repository identity accepts impossible owner syntax and rejects the valid
  `.github` repository. Require independent valid/invalid HTTP examples.

Completed review coverage and command receipts are recorded below.

- R2 red at 16:44:15 UTC: HTTP accepted `bad_owner/project` (200, expected 400).
  Tightened owner/name validation and accepted dot-prefixed repository names.
- R1 red at 16:44:43 UTC after R2 repair: HTTP accepted `readiness:hold` as a
  state label (200, expected 400). Save/load now validate the frozen project
  qualification label and the union of required/editable holds.
- R1/R2 green at 16:45:04 UTC: all eight workflow SDK/HTTP tests pass (3.00s).
- R3 coverage gap: saved planner retry bounds lacked real generated workflow
  evidence. Added fake-model invalid-plan/retry cases for limits 1 and 2, and
  asserted iteration-limit diagnostics in both generated templates. This is an
  evidence repair; no production change or artificial red state is needed.

### Reviewer commands and applicability

- **RF**: `npm test -- src/OperatorWorkflow.test.ts src/Operator.test.ts src/OperatorEnvironment.test.ts src/OperatorPrompts.test.ts src/OperatorCli.test.ts src/OperatorGenerated.test.ts src/Readiness.test.ts src/ReadinessPolicy.test.ts src/ReadinessWorkflow.test.ts src/InitService.test.ts src/InitService.agents.test.ts src/InitService.packageManager.test.ts src/InitService.sandboxProviders.test.ts src/run.test.ts -t '^(?!configured Codex workflow enforces)' --run`
- **RP**: `npm test -- src/ReadinessWorkflow.test.ts -t 'enforces .* planner attempts' --run`
- **RW**: `node --test scripts/operator-workflow.browser.test.mjs scripts/operator.browser.test.mjs scripts/operator-environment.browser.test.mjs`
- **RT**: `npm run typecheck`
- **RB**: `npm run build`
- **RA**: `node --input-type=module < .sandcastle/logs/issue-5-review-docs.mjs` (the documentation example validator above).
- **RD**: `git diff --check` and focused Prettier check over all task/review files.

Receipts: `.sandcastle/logs/issue-5-review-{focused,planner,browser,typecheck,build}.log`;
exit status is independently observed through the tool sessions. Source/harness
manifest `.sandcastle/logs/issue-5-review-source.sha256` SHA-256
`70611c10da89b486fd4a4f16868b0868247bfc0e649b369752c3df45e6aee9a5`.
Environment: Linux aarch64, Node v24.21.0, npm 11.19.0; installed toolchain and
Playwright/Chromium match the package lock (SHA-256
`0147be5b31dd2ba8c5a65fb7988e3813fd399010fed5b8cf0de58180e938ff66`).
Fake tracker/model/Docker processes, real Git fixtures, HTTP, SDK, generated
consumers and headless browser; no production tracker mutations or task closure.
The build's production inputs were unchanged after RB; only test/doc files
changed before RP/RF/RT/RW. RP's two cases are excluded from RF; their exact
harness/source is unchanged, so their own fresh passing receipt applies.
No implementer receipt supplies reviewer evidence. This manifest is focused
provenance and cannot replace the integration owner's trusted cumulative gate.

Reviewer results: RP passed 2 cases at 16:46:43 UTC, 23.82s; RF passed
487 cases (two RP cases excluded) at 16:47:12 UTC, 189.63s, exit 0.
All 489 focused cases passed. RW passed 11 browser tests, 9.13s; RT and RB
exited 0 (RB also validates Effect-free public types); RA exited 0. No in-scope,
pre-existing or environmental test failure remains. RD passed: all 16 task/review
files pass focused Prettier checking, `git diff --check` is clean, and the final
scoped diff contains only repairs, regression evidence, docs and a patch changeset.

### Independent review ledger

Evidence names E1–E8, C1, G1–G5, R1–R6 and W1–W3 above identify exact tests.
**G6** is the two new configured Codex planner-attempt cases. E2 additionally
covers invalid owner syntax/name lengths, `.github` acceptance and all trusted
hold/qualification collisions. G2 additionally asserts iteration-limit outcomes.
Implementation symbols below refer to the reviewed source files in the file
coverage table. Each receipt is new reviewer execution under the manifest above;
only the integration owner's future check is pending-integration.

| ID  | Requirement                                      | Implementation evidence                            | Test evidence                         | Receipt/applicability                                                                                         | Owner             | Status              |
| --- | ------------------------------------------------ | -------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------- |
| 01  | AC1/6: same web/CLI settings, save/reload        | Workflow load/save; HTTP routes; CLI runtime       | E1/E2/C1/W1                           | RF/RW, real persistence/child                                                                                 | reviewer          | pass                |
| 02  | AC1: atomic invalid labels                       | Schema + validateProjectPolicy                     | E2 incl. trusted collisions           | RF, HTTP rejection + unchanged load                                                                           | reviewer          | pass                |
| 03  | AC1: atomic repository validation                | Repository schema                                  | E2 incl. valid .github                | RF, HTTP rejection + reload                                                                                   | reviewer          | pass                |
| 04  | AC1: atomic invalid limits                       | Limits schema                                      | E2                                    | RF, HTTP                                                                                                      | reviewer          | pass                |
| 05  | AC1: atomic unknown gate/verifier refs           | validateProjectPolicy                              | E2                                    | RF, HTTP                                                                                                      | reviewer          | pass                |
| 06  | AC1: standards/qualification preserved           | Save writes workflow only; frozen policy           | E1/E4                                 | RF, project artifacts/policy                                                                                  | reviewer          | pass                |
| 07  | AC2: actual bounded concurrency + failures       | settleIssues; generated caller                     | E3/W1                                 | RF/RW, actual callbacks                                                                                       | reviewer          | pass                |
| 08  | AC2: cycle stopping + recorded limit             | InitService generated MAX_ITERATIONS               | G2 both templates                     | RF, generated/provider/tracker                                                                                | reviewer          | pass                |
| 09  | AC2/5: immutable active settings, next-run saves | Runtime freeze/digests/reopen                      | E3/E5/E7/C1                           | RF, SDK/HTTP/CLI                                                                                              | reviewer          | pass                |
| 10  | AC3/6: explicit repo, project isolation          | Workflow repo + generated GH_REPO                  | E1/E2/C1/G1/G3/W3                     | RF/RW, upstream remote differs                                                                                | reviewer          | pass                |
| 11  | AC3: completed/integrated dependencies           | Retained ReadinessPolicy + generated readiness     | R1/R2/G3                              | RF, real ancestry + fake tracker                                                                              | reviewer          | pass                |
| 12  | AC3: authoritative holds                         | Effective hold union + admission                   | E4/E7/R5/G5 HOLD                      | RF, settings/proposals                                                                                        | reviewer          | pass                |
| 13  | AC3: meta tasks excluded                         | Retained classification/admission                  | R5/G5 META                            | RF, generated workflow                                                                                        | reviewer          | pass                |
| 14  | AC3: stale source/contracts rejected             | Retained admission + policy + checkout guards      | R2/R4/R5/G3                           | RF, edited source/tracker                                                                                     | reviewer          | pass                |
| 15  | AC3: incomplete reviews cannot merge             | Generated completion/retained-review guards        | G3/R6                                 | RF, model/tracker boundaries                                                                                  | reviewer          | pass                |
| 16  | AC4: report-only default; apply verifier         | Defaults/schema; retained readiness verify         | E1/E2/E4/R3/R4/W1                     | RF/RW, publication seam                                                                                       | reviewer          | pass                |
| 17  | AC4: full contract/publication integrity         | Existing readiness/policy checks still called      | R2/R4/G3                              | RF, full-scope/readback faults                                                                                | reviewer          | pass                |
| 18  | AC4/6: missing verifier, gate, qualification UI  | inspectWorkflow; diagnostics; text rendering       | E5/W1                                 | RF/RW, HTTP + browser                                                                                         | reviewer          | pass                |
| 19  | AC5: project-owned commands, required gates      | Frozen declarations; execFile; required gate union | E2/E4/E7                              | RF, trusted subprocesses                                                                                      | reviewer          | pass                |
| 20  | AC5: credential-free config/diagnostics          | Strict config; safe failures; public projection    | E2/E4/E5/W1                           | RF/RW, credential sentinel                                                                                    | reviewer          | pass                |
| 21  | AC6: no-progress/qualification-only outcomes     | Generated reportOutcome + stopping                 | G4/R6/E5/W1                           | RF/RW, unfinished tasks open                                                                                  | reviewer          | pass                |
| 22  | Parent: security/legacy compatibility            | Protected routes; project paths; legacy reopen     | E2/E6/E8 + Operator tests/W2          | RF/RW, origin/symlink/legacy                                                                                  | reviewer          | pass                |
| 23  | AC6: docs/changesets                             | README/operator guide; minor + repair patch        | RA; full diff + changeset inventory   | RA/RD, English guide/public examples                                                                          | reviewer          | pass                |
| 24  | Standards: affected package checks               | Effect/tagged errors/JSDoc; callers/exports        | RF/RT/RB                              | Linux build + Effect-free types                                                                               | reviewer          | pass                |
| 25  | Integrated cumulative gate                       | verify-affected.sh                                 | Full package + Agent Map browser gate | bash .sandcastle/scripts/verify-affected.sh 256f63bf6ddf13f2301224e3571fd1d14ecd8bf8; exact integrated commit | integration owner | pending-integration |
| 26  | Public planner retry limits                      | Generated MAX_PLANNER_ATTEMPTS                     | G6 limits 1/2                         | RP, invalid then valid model plan                                                                             | reviewer          | pass                |

### Changed-file review coverage

Every baseline-to-task diff was read completely per file or bounded group.
The evidence-file diff was paginated, with overlapping rereads to recover output
truncation. There are no opaque generated payloads in this change. The inline
HTML/CSS/JS assets were reviewed as source and exercised through their built
consumer. Repair diffs were inspected separately against the task HEAD.

| File                                              | Review method and result                                                                                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| .changeset/operator-workflow-settings.md          | Full diff; correct package/minor; all existing changesets checked for duplication. Pass.                                                                 |
| README.md                                         | Full diff and operator entry point; documentation matches settings/diagnostics. Pass.                                                                    |
| docs/evidence/issue-5.md                          | Full paginated diff; receipts treated as historical; independent criterion/file ledger added. Pass; final reviewer receipts recorded above.              |
| docs/operator.md                                  | Full diff; ownership/schema/limits/API/security reviewed; examples executed with public SDK; validation repair documented. Pass.                         |
| scripts/operator-workflow.browser.test.mjs        | Full diff; real browser/forms/HTTP, fake provider boundaries; two-project isolation/keyboard/error expectations. RW pass.                                |
| src/InitService.ts                                | Full diff; CodeGraph node/callers; generation anchors and both reviewed templates inspected; actual generated consumers in RF. Pass; RF green.           |
| src/OperatorCli.test.ts                           | Full diff; fixed CLI adapter/child/reopen reviewed; frozen and later settings observed through child. Pass; RF green.                                    |
| src/OperatorGenerated.test.ts                     | Full diff + full consumer fixture; unchanged generated consumers execute built package at fake Docker boundary, Node/Android/auth/cache. Pass; RF green. |
| src/OperatorRuntime.ts                            | Full diff; schema, digests/freezing/reopen, scheduler, subprocesses, diagnostics, public consumers reviewed. Pass; RF green.                             |
| src/OperatorServer.ts                             | Full diff; surrounding host/origin/session/size guards, save/start lock, projection and error handling. Pass; RF green.                                  |
| src/OperatorWorkflow.test.ts                      | Full diff; public SDK/HTTP behavior; strengthened independent valid/invalid identities + trusted policy collisions. Pass; focused and RF green.          |
| src/OperatorWorkflow.ts                           | Full diff; validation/persistence/project paths/references and callers; R1/R2 repaired with tagged Effect errors. Pass; focused and RF green.            |
| src/ReadinessWorkflow.test.ts                     | Full diff + fake boundaries/generation/policy fixtures; G2 diagnostics and G6 retry evidence strengthened. Pass; RP and RF green.                        |
| src/index.ts                                      | Full diff; public functions/types consumed by SDK/browser/CLI; RB public declaration check. Pass.                                                        |
| src/operatorAssets.ts                             | Full source diff; form IDs/validation/projection/text rendering/keyboard/navigation; actual browser consumption. RW pass.                                |
| .changeset/operator-workflow-validation-review.md | Full new file; distinct patch for R1/R2, correct package, no duplicate patch. Pass.                                                                      |

### Final reviewer receipt hashes

| Receipt                                       | SHA-256                                                            |
| --------------------------------------------- | ------------------------------------------------------------------ |
| .sandcastle/logs/issue-5-review-focused.log   | `b82ab323a519828581fb47d04ffef8ab7f4c8a82793c3867dff61ed9d2b048bf` |
| .sandcastle/logs/issue-5-review-planner.log   | `3273727cb58fd48a61a9f75e75186803fab83e3256ac1fd4e452d2047e35f4b2` |
| .sandcastle/logs/issue-5-review-browser.log   | `38695e34a03a8fbfc4c3c806a2ec76b9a396072d36a672fb7becb96c5c4bcf1d` |
| .sandcastle/logs/issue-5-review-typecheck.log | `e7c9d0c8beef624bc76156a9fdd7ca0359bdb3b4a6c3c32c0e308ea3239c65a7` |
| .sandcastle/logs/issue-5-review-build.log     | `e65a9cdac92d90db38400f2f3e9dc3c1706982daccf70a283f2ca6bc229cc203` |

All branch-required review rows pass, and all findings are repaired. Only the
integration owner's exact integrated-source cumulative gate is pending. The
committed candidate preserves the verified source/harness manifest; final
ledger edits do not change executable inputs. Task 5 remains open. This review
establishes branch readiness for integration and does not establish issue closure.
