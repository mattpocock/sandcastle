# Task 2 requirement ledger

Contract: GitHub task 2, loaded 2026-10-11, and parent #1 Product decisions and Delivery/acceptance insofar as role configuration, frozen evidence, security and compatibility apply.
Environment: Linux workspace, npm lockfile/toolchain from package.json; all evidence new (no applicable receipts). Root package @ai-hero/sandcastle. Implementer owns all rows except integration. Tests/receipts recorded below as slices complete.

| ID   | source                       | requirement                                                                                                                  | public seam                        | exact test                                                                                                                                                                                                                                                                                                                                                                               | command                                                                              | evidence (new/reused) | receipt/applicability                                                                                    | owner             | status              |
| ---- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------- | -------------------------------------------------------------------------------------------------------- | ----------------- | ------------------- |
| C1   | AC1                          | Explicit-project operator CLI; dashboard remains read-only                                                                   | CLI / HTTP                         | offers an operator command requiring an explicit host project; operator CLI serves only its explicit project and hands its frozen runtime to the fixed workflow; AgentMap read-only regressions                                                                                                                                                                                          | F, A                                                                                 | new                   | F/A; unchanged CLI/AgentMap consumers                                                                    | implementer       | pass                |
| C2   | AC1; parent defaults         | Five current roles; suggestions/custom IDs; capability efforts and low/low/high/high/high defaults                           | SDK / browser                      | missing configuration defaults to all five Codex roles and saves custom models durably; model dropdowns and custom IDs save, reload and route to the selected project                                                                                                                                                                                                                    | F, W                                                                                 | new                   | F/W; all five role values and four efforts                                                               | implementer       | pass                |
| C3   | AC2                          | Validate all five roles before atomic save; actionable errors and no partial config change                                   | SDK / HTTP                         | all role, schema, provider, effort and unsafe-field failures leave the saved revision intact; operator HTTP requires a local session and exact origin/host and cannot partially save malformed requests                                                                                                                                                                                  | F                                                                                    | new                   | F; each role omission/provider/effort/model rejection reads original config                              | implementer       | pass                |
| C4   | AC2                          | Missing config defaults; unsupported schema/provider/effort and malformed stored source rejected                             | SDK                                | missing configuration defaults to all five Codex roles and saves custom models durably; stored configuration fails closed on malformed JSON, unsupported source schema and tampered revision; all role, schema, provider, effort and unsafe-field failures leave the saved revision intact                                                                                               | F                                                                                    | new                   | F; schema 0/2, each role unsupported provider/effort, malformed JSON, revision mismatch                  | implementer       | pass                |
| C5   | AC3                          | Shared runtime in both new reviewed Codex and Codex AFK artifacts; dropdown changes reach fake provider without editing main | Generated consumer / browser / SDK | parallel-planner-with-review Codex consumers use the shared runtime and preserve the selected model; codex-afk Codex consumers use the shared runtime and preserve the selected model; generated Codex workflow consumes saved models and effort for all roles through real provider commands and records; model dropdowns and custom IDs save, reload and route to the selected project | F, R, W                                                                              | new                   | R/W; real Codex command/parser + fake process, project sandbox boundary                                  | implementer       | pass                |
| C6   | AC3                          | Existing SDK/provider calls compatible; project sandbox/gate adapter seam retained                                           | SDK / build                        | Legacy run, createSandbox, AgentProvider and prompt tests; HTTP run uses a frozen runtime, reports actual roles, prevents overlapping starts, and isolates selected projects                                                                                                                                                                                                             | F, B                                                                                 | new                   | F/B; existing call signatures and Effect-free public declarations                                        | implementer       | pass                |
| C7   | AC4                          | Frozen config revision/runtime identity and actual role model/effort in observed run records                                 | SDK / HTTP                         | runtime freezes revision, prompt templates and image identity while the next run uses saved role settings; HTTP run uses a frozen runtime, reports actual roles, prevents overlapping starts, and isolates selected projects; generated Codex workflow consumes saved models and effort for all roles through real provider commands and records                                         | F, R                                                                                 | new                   | F/R; all five actual role command settings and HTTP snapshot                                             | implementer       | pass                |
| C8   | Parent freeze                | Private frozen prompt contents/digests and resolved sandbox image identity                                                   | SDK record / CLI                   | runtime freezes revision, prompt templates and image identity while the next run uses saved role settings; frozen runtime handoff verifies its source schema, version, revision and prompt integrity; operator CLI serves only its explicit project and hands its frozen runtime to the fixed workflow                                                                                   | F                                                                                    | new                   | F; frozen copies, digest integrity, image ID and exact child UUID                                        | implementer       | pass                |
| C9   | AC4                          | Save during execution changes next run only                                                                                  | SDK / HTTP / browser               | runtime freezes revision, prompt templates and image identity while the next run uses saved role settings; saving during a run leaves its displayed settings frozen and opens recorded workflow logs                                                                                                                                                                                     | F, W                                                                                 | new                   | W; active low/default remains frozen; next fake process receives saved xhigh/new model                   | implementer       | pass                |
| C10a | AC4 admission                | Fresh admission before worktree/implementation; pinned source guards unchanged                                               | Generated workflow / SDK           | shared Codex runtime preserves fresh admission guards; refreshes tracker eligibility before creating any selected worktree; Readiness admission/source tests                                                                                                                                                                                                                             | R, F                                                                                 | new                   | R/F; mutated tracker eligibility stops implementation                                                    | implementer       | pass                |
| C10b | AC4 completion               | BLOCKED implementation with commits cannot advance to review/merge                                                           | Generated workflow                 | shared Codex runtime preserves blocked completion guards; does not review or merge a blocked implementation that produced commits                                                                                                                                                                                                                                                        | R                                                                                    | new                   | R; forbidden review and merge observations                                                               | implementer       | pass                |
| C10c | AC4 review                   | BLOCKED review cannot advance to merge; retained progress is reviewed                                                        | Generated workflow                 | shared Codex runtime preserves blocked review guards; reviews retained branch commits before integration when the resumed implementer adds none                                                                                                                                                                                                                                          | R                                                                                    | new                   | R; blocked review stops merge; retained branch receives review                                           | implementer       | pass                |
| C10d | AC4 merge                    | Merger completion required before readiness or next planning                                                                 | Generated workflow                 | shared Codex runtime preserves merger completion guards; runs the generated two-batch workflow through real orchestration and unlocks the next issue after merge                                                                                                                                                                                                                         | R                                                                                    | new                   | R; incomplete merge stops readiness/next planner; successful merge unlocks dependency                    | implementer       | pass                |
| C10e | AC4 readiness                | Readiness assessment cannot modify checkout or bypass independent post-merge verification                                    | Generated workflow / SDK           | shared Codex runtime preserves readiness checkout integrity guards; shared Codex runtime preserves post-merge verification guards; rejects an assessor’s uncommitted edits before starting the planner; stops before the next planner when post-merge project verification fails                                                                                                         | R, F                                                                                 | new                   | R/F; dirty assessment and failing verifier stop advancement                                              | implementer       | pass                |
| C10f | Existing workflow invariants | No-progress stop and external qualification remain enforced                                                                  | Generated workflow                 | stops a no-progress batch after one implementation attempt; reports pending external qualification without implementing or closing its issue                                                                                                                                                                                                                                             | R                                                                                    | new                   | R; source guards retained, no bypass through runtime settings                                            | implementer       | pass                |
| C11  | AC5                          | Local session plus validated origin/host for mutations                                                                       | HTTP / browser                     | operator HTTP requires a local session and exact origin/host and cannot partially save malformed requests; model dropdowns and custom IDs save, reload and route to the selected project                                                                                                                                                                                                 | F, W                                                                                 | new                   | F/W; absent/forged session, hostile host/origin, missing Origin; per-port cookies                        | implementer       | pass                |
| C12  | AC5                          | Malformed/cross-origin requests cannot write config                                                                          | HTTP                               | operator HTTP requires a local session and exact origin/host and cannot partially save malformed requests                                                                                                                                                                                                                                                                                | F                                                                                    | new                   | F; malformed JSON, 16 KiB bound, content type, unknown fields, prior public read intact                  | implementer       | pass                |
| C13  | AC5; parent auth             | Project secrets/auth never returned; no executable/config command fields                                                     | HTTP / schema / browser            | all role, schema, provider, effort and unsafe-field failures leave the saved revision intact; operator HTTP requires a local session and exact origin/host and cannot partially save malformed requests; HTTP run uses a frozen runtime, reports actual roles, prevents overlapping starts, and isolates selected projects                                                               | F                                                                                    | new                   | F; .env secret excluded; auth/command fields and nonempty run body rejected; prompts excluded from HTTP  | implementer       | pass                |
| C14  | AC6                          | Dropdown save and reload persistence                                                                                         | Browser                            | model dropdowns and custom IDs save, reload and route to the selected project                                                                                                                                                                                                                                                                                                            | W                                                                                    | new                   | W; suggested and custom models persist after reload                                                      | implementer       | pass                |
| C15  | AC6                          | Invalid-input feedback and keyboard use                                                                                      | Browser                            | keyboard operation and actionable invalid-input feedback preserve durable settings                                                                                                                                                                                                                                                                                                       | W                                                                                    | new                   | W; native keyboard select, Enter save, invalid model diagnostic and previous durable value               | implementer       | pass                |
| C16  | AC6                          | Immutable active settings and correct selected-project routing                                                               | HTTP / browser                     | HTTP run uses a frozen runtime, reports actual roles, prevents overlapping starts, and isolates selected projects; model dropdowns and custom IDs save, reload and route to the selected project; saving during a run leaves its displayed settings frozen and opens recorded workflow logs                                                                                              | F, W                                                                                 | new                   | F/W; two projects in one browser, query override rejection, overlap rejection                            | implementer       | pass                |
| C17  | AC6                          | Source-schema compatibility, init and run-record regressions                                                                 | SDK / generated consumer / HTTP    | frozen runtime handoff verifies its source schema, version, revision and prompt integrity; rejects a Codex init model that cannot form valid shared role configuration; both Codex consumers use the shared runtime; generated Codex workflow consumes saved models and effort for all roles through real provider commands and records; AgentMap legacy regressions                     | F, R, A                                                                              | new                   | F/R/A; supported handoff + unsupported schema/version/revision/prompt cases; existing snapshots readable | implementer       | pass                |
| C18  | AC7                          | Document feature and public interfaces; minor changeset                                                                      | Artifacts / build                  | README guide link and built SDK/HTTP export validator; public declaration Effect-free check; scoped changeset inspection                                                                                                                                                                                                                                                                 | L, B, D                                                                              | new                   | L/B/D; English docs agree, related changesets inspected before adding distinct feature changeset         | implementer       | pass                |
| B1   | Feedback loops               | Affected types/build and scoped clean diff                                                                                   | Executable gates                   | branch typecheck; build/public declarations; scoped diff inspection                                                                                                                                                                                                                                                                                                                      | T, B, D                                                                              | new                   | New logs; tested production source fingerprint below                                                     | implementer       | pass                |
| I1   | Feedback loops               | Exact integrated authoritative/cumulative gate                                                                               | Integrated source                  | Integrated package/full tests/build/Agent Map browser gate                                                                                                                                                                                                                                                                                                                               | bash .sandcastle/scripts/verify-affected.sh a22f71e6713d7fdba64f38b030c529aabcd58690 | new                   | Exact final integrated candidate required; no full-gate receipt claimed                                  | integration owner | pending-integration |
| I2   | AC6 integration              | Operator browser regression on integrated built candidate                                                                    | Integrated browser                 | Three operator browser scenarios above                                                                                                                                                                                                                                                                                                                                                   | node --test scripts/operator.browser.test.mjs (after integrated build)               | new                   | Exact integrated source required                                                                         | integration owner | pending-integration |

Navigation: CodeGraph explore/query/impact/affected used; graph lacks operator symbols because feature is new. Exact contracts read directly. Observation seams are exported SDK config/runtime, loopback HTTP, generated consumer, and browser. Narrow RED commands use npm test -- src/Operator.test.ts --run. Persistence uses existing writePrivateRecord (atomic private file). Security excludes authentication and executable text from strict schema. Runtime must retain existing workflow guards; role configuration is independent of project adapter policy.

## Slice evidence (new; preliminary results, not reused receipts)

- 2026-10-11 15:44 UTC: config public-seam RED observed missing five-role defaults (empty role object). 15:45 UTC GREEN: `npm test -- src/Operator.test.ts --run` (3 tests); `npm run typecheck` pass. Covers C2/C3/C4/C13 SDK behavior. Complete invalid-input matrix tests every role omission and each unsupported provider/effort, empty/unsafe model plus unknown auth/command/schema fields; previous public read remains identical.
- 15:46 UTC: runtime RED: “Runtime not implemented”. 15:47 UTC GREEN same focused command (4 tests), typecheck pass. C7/C8/C9 runtime revision, runtime version, immutable image identity and prompt content/digest; subsequent runtime picks new settings. Command expectation corrected to existing Codex public `-m` contract; missing required permission argument corrected in harness.
- 15:48 UTC: HTTP RED: “Operator server not implemented”. 15:50 UTC GREEN focused Operator command (6 tests), typecheck pass. C11/C12/C13/C16 session/origin/host, malformed/oversized/content-type/unknown fields, no query project overrides. Node fetch ignores a Host override, so hostile Host evidence uses real node:http request. HTTP running/observation test covers actual role metadata and project isolation; cleanup waits for owned workflow completion.
- 15:51 UTC: init RED: roles.json absent in both new Codex consumers. GREEN: `npm test -- src/InitService.test.ts --run -t 'Codex consumers use'` (2 tests), typecheck pass. C5/C17 artifacts. Existing reviewer expectation of hardcoded xhigh updated to parent's high default in config, preserving standards/session mounts.
- 15:52 UTC: CLI RED: operator help absent. Help test tightened after root-help fallback exposed a weak initial assertion. CLI built help is now present. Existing CLI hardcoded-provider text expectation updated to public config model and shared provider seam.
- 15:54 UTC: browser RED: model field was not a select. Native dropdown added with Custom model ID input. Subsequent browser failure established accessible label included option text; explicit labels fix exact keyboard/browser observation.
- 15:53–15:56 UTC: affected build caught new error class Effect declaration leakage; removed root error export and build's public declaration validator passes. Generated fake Codex fixture initially had a newline escaping error; corrected executable harness, no acceptance/product relaxation. Final affected checks remain required below.

- 15:57–15:59 UTC: native dropdown save/reload/custom IDs, keyboard submission, actionable model feedback and immutable running settings/browser log navigation pass (3 tests). Actionable feedback RED established that Effect promise failures were losing the safe tagged diagnostic; HTTP boundary now unwraps only safe OperatorError failures.
- 15:57 UTC: generated Codex happy path passes through the real provider, sandbox SDK, Git workflow and run-record HTTP consumer. Fake model emits one final message (matching the existing provider contract) instead of separate final messages overwriting the readiness payload. Harness timeout matches the executable workflow's duration.
- 16:00 UTC: frozen handoff compatibility passes: unsupported source fields/schema, package version, runtime ID, configuration revision and altered frozen prompt are rejected; valid reopening retains the original record.
- 16:00–16:01 UTC: same-browser project-routing RED found session cookies collided across operator ports; port-specific cookie GREEN (3 browser tests) leaves each project independently writable.
- 16:02 UTC: executable CLI serves an explicit temporary project, HTTP saves selected roles, and the fixed child reopens the exact frozen runtime/image identity (1 test pass).
- 16:05 UTC: init invalid-model RED resolved to a corrupt generated config; GREEN uses the same validated atomic Effect save as web/SDK. Focused init/config command passes (5 selected tests), typecheck passes.
- Final evidence selection: new evidence for every branch-required row. No reused receipt. Focused set includes new config/runtime/HTTP/browser/CLI tests, init's provider/package-manager compatibility, Agent Map HTTP/legacy browser contracts, real generated workflow guards, SDK/provider/session callers and prompt resolution. Full/cumulative gate remains integration-owned. Diagnostic logs below are local branch evidence, never validated full-gate proof.

## Final executable commands and receipt applicability

All results are new branch evidence, with original UTC timestamps retained.
No full-gate receipt is reused or claimed. Local logs are ignored runtime artifacts.

- **F**: `npm test -- src/Operator.test.ts src/OperatorCli.test.ts src/InitService.test.ts src/InitService.agents.test.ts src/InitService.packageManager.test.ts src/InitService.sandboxProviders.test.ts src/ReadinessWorkflow.test.ts src/Readiness.test.ts src/ReadinessPolicy.test.ts src/PlannerBatch.test.ts src/AgentMap.test.ts src/AgentProvider.test.ts src/run.test.ts src/PromptResolver.test.ts src/ReviewerInput.test.ts src/createSandbox.test.ts --run` — 708 passing tests, 2026-10-11 16:08:04–16:09:34 UTC. The 695 non-workflow cases remain applicable: their production, consumer and harness source did not change afterward. Workflow-specific evidence is superseded by R.
- **R**: `npm test -- src/ReadinessWorkflow.test.ts --run` — final 15 passing generated-workflow tests, including all six Codex fault/guard cases, at 16:14:43 UTC + 103.88 seconds. Test-only changes isolate global Git configuration and add explicit blocked reviewer/merger faults; all affected workflow cases rerun. Total distinct focused cases: 710.
- **W**: `node --test scripts/operator.browser.test.mjs` — final three browser tests pass after adding real fake-Codex SDK execution, shared-browser project routing, isolated Git configuration and next-run verification.
- **A**: `node --test scripts/agent-map.browser.test.mjs` — six existing dashboard browser contracts pass; Agent Map production/browser harness did not change afterward.
- **T**: `npm run typecheck` — final pass; required npm command used.
- **B**: `npm run build` — pass, including `scripts/check-public-types-effect-free.mjs`. Production/build/declaration source did not change afterward.
- **D**: `git diff --check` plus scoped diff/status inspection — pass; no unrelated initial working-tree changes existed, and no runtime/generated outputs are staged.
- **L**: `node --input-type=module` with the validator below — pass. This checks the new README link and documented built API exports, complementing executable CLI/HTTP contracts.

```js
import { readFileSync, existsSync } from "node:fs";
import * as sdk from "./dist/index.js";
const readme = readFileSync("README.md", "utf8");
const guide = readFileSync("docs/operator.md", "utf8");
if (
  !readme.includes("[operator guide](docs/operator.md)") ||
  !existsSync("docs/operator.md")
)
  throw new Error("Operator guide link is broken");
for (const name of [
  "defaultRoleConfig",
  "loadRoleConfig",
  "saveRoleConfig",
  "createProjectRuntime",
  "openProjectRuntime",
  "startOperator",
]) {
  if (typeof sdk[name] !== "function")
    throw new Error("Documented API missing: " + name);
}
for (const path of ["/api/config", "/api/run", "/dashboard"]) {
  if (!guide.includes(path))
    throw new Error("Missing HTTP documentation: " + path);
}
console.log(
  "Operator README link and documented public SDK/HTTP interfaces verified against built exports.",
);
```

Environment: Linux; Node v24.21.0; npm 11.19.0 executing the existing npm lockfile;
Vitest 3.2.4; Playwright 1.63.0 with headless Chromium. Tests use temporary Git
projects, fake Codex/GitHub executable boundaries, the real SDK and loopback HTTP.
New browser/generated-workflow fixtures isolate their global Git configuration.
No live model/tracker mutation, package publication or issue closure is involved.

Receipt directory: `.sandcastle/logs/issue-2-evidence/`.
These checks establish branch readiness only. I1/I2 are neither passes nor waivers;
the integration owner must verify the exact integrated source before closure.

Tested production-source manifest SHA-256: `9856311f08afe48ca839d249770d615899547503aed6bf89174ee153376a5f0b`.

```text
9569ead784f43f78ea042ebe178558336ec81ca1fb3dd347397e827a9f396447  src/Operator.ts
fff8fea7fb4310bbff5293f074a365073d557bb792f019ff5543ffbbdb5cd1fc  src/OperatorRuntime.ts
03ec5ab7d657b9c8846e82ba6f632c7214c2e2d69ef31d21e293e4eed8edc669  src/OperatorServer.ts
8d6f435291dcab31b027922edc6439b142a6ec9f47571dbd7d58e8d2b7f9f06e  src/OperatorCli.ts
538e42a8569e747d718b6979e5db86cce9cbcd8823fa81bac5e08a852b3c4040  src/operatorAssets.ts
905f5ae975a857b51fff63947186deb60b60d69652864d1a770037dfec9b7a8e  src/AgentMap.ts
8515149fa67195b058b289618d5deebdac51ec024002972aa8f5736a93cbdae6  src/InitService.ts
7f24da5de888f6b7daa536f5143c51e32e52034346376a7b0b7dcf516395c600  src/cli.ts
4a699f5a5614d466a48d466b9da0a73f8b74f5c8a3b5bc7e7e2e91af045fb73f  src/index.ts
```

| Receipt log                | Original completion (UTC) | SHA-256                                                            | Result |
| -------------------------- | ------------------------- | ------------------------------------------------------------------ | ------ |
| build.log                  | 2026-10-11 16:06:41       | `8b4b303c57448ff434e915aa9b1fc44c13241cf1819b1864ea1f282933e7037b` | pass   |
| focused.log                | 2026-10-11 16:09:33       | `8d1ab81d07a5f2f50b22cfaccdad9c1b75e1fdcbf1e69fac0ce8b6c95a617759` | pass   |
| workflow-final.log         | 2026-10-11 16:16:27       | `f18975858ada9b782059af1faab15b31b693884192e099bd5879029afe3a9d82` | pass   |
| operator-browser-final.log | 2026-10-11 16:15:43       | `d2f4c3223d1c5e52548e14a7d7048ecd44be3f236906d8b3a5acdb182c5ab861` | pass   |
| dashboard-browser.log      | 2026-10-11 16:08:46       | `d07921ca7fcc7218d222b0fd95569a2f87db893f621a3317bbe11799c4da3d05` | pass   |
| typecheck-final.log        | 2026-10-11 16:16:07       | `e7c9d0c8beef624bc76156a9fdd7ca0359bdb3b4a6c3c32c0e308ea3239c65a7` | pass   |
| docs-contract.log          | 2026-10-11 16:16:07       | `f87d7f281d165c77b175733479c680091b342a9122ab388bc24181a65dec2fc5` | pass   |

## Independent review

Reviewer contract read: full `gh issue view 2 --json number,title,body,labels,comments`
from the origin repository `hanhnghh/sandcastle` (no comments). The stale upstream
AGENTS.md repository pointer resolves to an unrelated scaffolding issue and was
not used as the contract. Parent read was limited to Product decisions relevant
to roles/configuration/freezing/security and Delivery/acceptance compatibility.
CODING_STANDARDS.md, FEEDBACK_LOOPS.md and EVIDENCE_POLICY.md were read completely.

All C1–C18 (including C10a–f) and B1 require new reviewer evidence. No implementer
receipt is reused: the authored ledger alone is not executable proof. Selected
checks: focused operator/config/runtime/CLI/init/generated-workflow tests,
affected legacy SDK/Agent Map/provider/prompt callers, operator and dashboard
browser contracts, npm typecheck/build, documentation/export inspection and
diff inspection. The full suite and cumulative gate remain integration-owned.

| Files                                                                    | Review method                                                                                                                   | Result                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `.changeset/shared-role-operator.md`, `README.md`, `docs/operator.md`    | Full baseline diff; related changesets; compare documented routes/defaults/exports with production                              | Reviewed; no duplicate release entry or scope expansion                          |
| `docs/issue-2-ledger.md`                                                 | Full baseline diff; compare every C row with task and actual public assertions                                                  | Reviewed; independent evidence required below                                    |
| `.changeset/pinned-runtime-project.md`                                   | Full repair diff; check package name, patch bump and all related changesets                                                     | Pass; distinct runtime project-routing bugfix                                    |
| `scripts/operator.browser.test.mjs`                                      | Full baseline diff; inspect fake executable boundary, real SDK/browser assertions and cleanup                                   | Reviewed; save/reload/keyboard/project routing/frozen next-run coverage          |
| `src/AgentMap.ts`                                                        | Full baseline diff; read snapshot parser, recorder and HTTP consumer; navigate callers                                          | Reviewed; optional metadata preserves legacy recordings                          |
| `src/InitService.ts`, `src/InitService.test.ts`                          | Full baseline diffs; read scaffold callers, rewrite stages and original workflow anchors                                        | Reviewed; inspect generated execution with focused tests                         |
| `src/Operator.ts`, `src/Operator.test.ts`                                | Full baseline diffs; read private atomic writer and provider capability; inspect HTTP/SDK seams                                 | Reviewed; add persistence failure/concurrency evidence                           |
| `src/OperatorCli.ts`, `src/OperatorCli.test.ts`                          | Full baseline diffs; inspect fixed child launch, session/image handoff and shutdown ownership                                   | Reviewed; validate built CLI                                                     |
| `src/OperatorRuntime.ts`                                                 | Full baseline diff; CodeGraph query/impact/affected; read runtime consumers                                                     | Finding R1: delayed SDK operations re-resolve a relative cwd after process.chdir |
| `src/OperatorServer.ts`                                                  | Full baseline diff (including separately paginated omitted section); inspect host/origin/session, serialization and run locking | Reviewed; strengthen failed-start/retry evidence                                 |
| `src/ReadinessWorkflow.test.ts`                                          | Full baseline diff; read generated harness and real guard consumers                                                             | Reviewed; all six Codex fault scenarios require execution                        |
| `src/cli.ts`, `src/cli.test.ts`, `src/index.ts`, `src/operatorAssets.ts` | Full baseline diffs; inspect registered command, public exports, form serialization/accessibility/data rendering                | Reviewed; validate built CLI/browser/declarations                                |

R1 (C6/C16): a runtime created or reopened with a relative explicit project path
must keep that project for frozen prompt access and observations after the host
changes its working directory. Current hydration resolves the path on each
promptFile/map call, selecting another project. Add a public SDK regression,
observe RED, pin the hydrated host path once, then observe GREEN.

Coverage findings: C3 atomic persistence lacks read-during-save and filesystem
failure observations; C11/C16 run admission lacks failed adapter/image/prompt
start and retry coverage. Add public SDK/HTTP evidence without internal mocks.
These are evidence repairs, not claims of an established product failure.

Additional C5/C17 coverage finding: the AFK artifact initially had generated-text
assertions only. The existing real generated-workflow harness now exercises both
reviewed Codex and Codex AFK workflows. Only sandbox provisioning/bootstrap and
external CodeGraph/model/tracker commands use fixture boundaries; the shared
runtime, provider command/parser, SDK, admission and workflow guards remain real.
All five role command arguments and HTTP-observed role records use independently
specified configured model/effort values. No copied provider code is edited to
select those values.

R1 repair: resolve the host project once during hydration and use that absolute
path for both frozen prompts and Agent Map. README was checked; its guide link
and feature description remain accurate. The guide documents stable project
routing, and a separate patch changeset records the bugfix (all existing
changesets inspected). The repair diff and each new test were read in full.

Diagnosis (review phase; all acceptance and integration gates retained):

- 16:26:40 UTC, 1.86s: the first cwd regression unexpectedly passed because its
  `../../../tmp` path still resolved to the same root after the directory change.
  This weak harness result was not used as behavior evidence. Replaced the
  input with the public `cwd: "."` case in the selected project.
- 16:27:26 UTC, 1.53s: `npm test -- src/Operator.test.ts --run -t 'retain the explicit project'`
  failed with ENOENT in the other project's runtime directory. Established
  product cause: deferred cwd resolution. RED log: `runtime-red.log`.
- 16:27:58 UTC, 1.70s: same command after pinning hydration's cwd passed.
  GREEN log: `runtime-green.log`. Final O rechecks both create and reopen and
  verifies prompt contents plus persisted observations through dashboard HTTP.
- Persistence and failed-start evidence additions passed against existing
  production behavior; no meaningful product RED was claimed for those gaps.
  O also verifies the known prompt SHA-256 and private file/directory modes.
- The first AFK test invocation had a mistyped log directory; shell redirection
  failed before Vitest ran. Corrected only that path; 16:29:46 UTC, 15.65s:
  `npm test -- src/ReadinessWorkflow.test.ts --run -t 'generated codex-afk Codex workflow'`
  passed (one selected test). The final workflow suite supersedes this slice.

Reviewer environment: Linux, uid 501, Node v24.21.0, npm 11.19.0, locked
Vitest 3.2.4 and Playwright 1.63.0/headless Chromium; temporary Git projects,
isolated Git config and fake external executables. The POSIX permission case
ran and passed here; its root/Windows skip covers environments where these
mode bits cannot establish the tested write denial. No scenario was skipped
in this review environment. No live tracker/model mutation or issue closure.

Reviewer receipts are new executions, not reused implementer results. Their
directory is `.sandcastle/logs/issue-2-review/` (ignored). The tested source and
harness manifest `source.sha256` has digest
`20caaff472dcfaa9e89b8fbfcae42bcf5f4e321c21075b1f96018d275405422a`.
This manifest is provenance for focused review evidence, not full-gate proof.
Build/browser evidence remains applicable: production source has not changed
since the repaired runtime was built. Only the affected test harness changed
after F; its workflow evidence is superseded by the complete final R execution.

- O: `npm test -- src/Operator.test.ts --run` — 13 passed, no skipped cases,
  16:31:59 UTC, 1.99s; `operator-final.log`.
- F: `npm test -- src/OperatorCli.test.ts src/cli.test.ts src/InitService.test.ts src/InitService.agents.test.ts src/InitService.packageManager.test.ts src/InitService.sandboxProviders.test.ts src/ReadinessWorkflow.test.ts src/Readiness.test.ts src/ReadinessPolicy.test.ts src/PlannerBatch.test.ts src/AgentMap.test.ts src/AgentProvider.test.ts src/run.test.ts src/PromptResolver.test.ts src/ReviewerInput.test.ts src/createSandbox.test.ts --run`
  — 732 passed, 16:29:09 UTC, 126.46s; `focused.log`. The 717 non-workflow
  cases remain applicable; R supersedes the 15 workflow cases.
- W: `node --test scripts/operator.browser.test.mjs` — 3 passed, 16:29:14 UTC
  completion, 4.76s; `operator-browser.log`.
- A: `node --test scripts/agent-map.browser.test.mjs` — 6 passed, 16:29:37 UTC
  completion, 27.95s; `dashboard-browser.log`.
- B: `npm run build` — passed, 16:28:46 UTC completion; `build.log`, including
  the public Effect-free declaration validator.
- T: `npm run typecheck` — final passed after the last test edit;
  `typecheck-review.log`.
- L: documented defaults/README link/built public exports/HTTP paths verified
  with `node --input-type=module`, 16:31:10 UTC; `docs.log`. Changesets and
  public JSDoc/interface ownership inspected directly.
- D: `git diff --check`, scoped full diff/status inspection and focused
  `npx prettier --check` — passed; repeat diff/status inspection before commit.
- R: `npm test -- src/ReadinessWorkflow.test.ts --run` — final 16 passed,
  16:31:49 UTC, 125.43s; `workflow-final.log`. Both Codex consumers and all
  admission/completion/review/merge/readiness faults executed with the final
  harness. Distinct Vitest cases across O/F/R: 746; browser cases W/A: 9.

| Receipt | Completion UTC | SHA-256                                                            |
| ------- | -------------- | ------------------------------------------------------------------ |
| O       | 16:32:01       | `4d76d2192c1636576c574da4e86b2af24f1323bad2c80dfc16c2cafeec509528` |
| F       | 16:31:16       | `d10d2cbb5e31492f6efdddb26efdd282227ac615cbaa2addd4fc4cca56ea45c4` |
| R       | 16:33:55       | `f5414a0f70588355e33801aab452b090b913885d4ecc9beb2615b954f8ac8a69` |
| W       | 16:29:14       | `e5fc42ed4ba0a5941f3747d11a716459d1328a38ab220733cae2a38161b9c1ee` |
| A       | 16:29:37       | `5899a0ed596e602ff0ad8140d1869db805d802814cbf3daf2e8d02286f7ca769` |
| B       | 16:28:46       | `b337e07212722c1cf288b65075d9f0ebe7ce62ad66963a7c02df4da09f5a94af` |
| T       | 16:33:23       | `e7c9d0c8beef624bc76156a9fdd7ca0359bdb3b4a6c3c32c0e308ea3239c65a7` |
| L       | 16:31:10       | `7f882af7129e3f8c66094c0e283f0c3b6824d90a808e704a9f10ee2eccf30e2f` |

Final reviewer ledger (supersedes implementer status for branch readiness;
original implementation history above is retained). Every receipt below is a
fresh Linux execution with the applicability limits specified above. No full
gate was run or claimed. Every changed file in the immutable task diff was
reviewed in full, plus the new patch changeset and all repair diffs.

| ID   | requirement                                                                          | implementation evidence                                                         | test evidence                                                                               | receipt/applicability                         | owner             | status              |
| ---- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------- | ------------------- |
| C1   | Explicit project CLI; dashboard read-only                                            | cli.ts command; OperatorCli; AgentMap HTTP                                      | CLI help/explicit project/child handoff; legacy dashboard                                   | F/A, unchanged consumers                      | reviewer          | pass                |
| C2   | Five roles/current values/suggestions/custom IDs/capability/defaults                 | Operator schemas/defaults; operatorAssets form                                  | Five SDK defaults, custom save; browser dropdown/reload                                     | O/W, final runtime                            | reviewer          | pass                |
| C3   | Complete validation, atomic persistence, actionable errors, no partial writes        | Operator save; writePrivateRecord                                               | Per-role invalid matrix; competing writes/readers; permission denial preserves durable read | O, POSIX case executed                        | reviewer          | pass                |
| C4   | Missing defaults; reject unsupported/malformed stored source                         | Operator load/schema/revision validation                                        | Missing file, JSON/schema/provider/effort/role/revision cases                               | O, final source                               | reviewer          | pass                |
| C5   | Both Codex consumers use shared config; dropdown reaches fake run without main edits | InitService runtime wiring; OperatorRuntime                                     | Both generated workflows execute all five configured roles; browser fake process            | F/R/W, final harness                          | reviewer          | pass                |
| C6   | SDK compatibility; project adapter retains sandbox/gates                             | Public exports; OperatorProjectAdapter; additive map metadata                   | Existing provider/run/sandbox/prompt calls; HTTP adapter; stable SDK cwd                    | O/F/B, unchanged callers                      | reviewer          | pass                |
| C7   | Freeze revision/runtime identity; record actual role model/effort                    | Runtime record; runtime agents/map metadata                                     | Real provider arguments agree with HTTP role records for all five roles                     | O/R, final source                             | reviewer          | pass                |
| C8   | Private frozen prompts/digests/image identity                                        | Runtime freeze/handoff; CLI image inspect                                       | Known digest/content; 700/600 modes; immutable CLI image ID/UUID                            | O/F, Linux permissions                        | reviewer          | pass                |
| C9   | Running save affects next run only                                                   | Frozen record and child handoff                                                 | Active settings unchanged; next browser fake process gets new model/effort                  | O/W, final runtime                            | reviewer          | pass                |
| C10a | Admission/source guards                                                              | Existing admission seam retained in generated workflow                          | Fresh eligibility stops implementation/worktree progression                                 | F/R, actual workflow                          | reviewer          | pass                |
| C10b | BLOCKED implementation cannot advance                                                | Existing completion guard retained                                              | Committed blocked implementation gets no review/merge                                       | R, actual workflow                            | reviewer          | pass                |
| C10c | Review guard and retained progress                                                   | Existing reviewer path retained                                                 | Blocked review stops merge; retained commits receive review                                 | R, actual workflow                            | reviewer          | pass                |
| C10d | Merge completion before readiness/planning                                           | Existing merger guard retained                                                  | Blocked merger stops next phase; successful merge unlocks dependency                        | R, actual workflow                            | reviewer          | pass                |
| C10e | Readiness checkout and independent verification guards                               | Existing readiness/verification seams retained                                  | Dirty assessment and failed post-merge verification stop advancement                        | F/R, actual workflow                          | reviewer          | pass                |
| C10f | No-progress and external qualification invariants                                    | Existing workflow policies retained                                             | No-progress stops; qualification stays open/unimplemented                                   | R, actual workflow                            | reviewer          | pass                |
| C11  | Session/origin/host protect mutations                                                | OperatorServer exact authority/session checks                                   | Missing/forged session, hostile/missing origin, hostile host; port-specific cookies         | O/W, public HTTP/browser                      | reviewer          | pass                |
| C12  | Malformed requests cannot write                                                      | Bounded JSON body; strict config schema                                         | Malformed/oversized/wrong-type/unknown-field requests preserve config                       | O, public HTTP/SDK                            | reviewer          | pass                |
| C13  | No secrets/auth or arbitrary execution config                                        | Safe error mapping; strict config/run bodies; prompt omission                   | .env excluded; unsafe auth/command rejected; adapter secret errors suppressed               | O, public HTTP/SDK                            | reviewer          | pass                |
| C14  | Save/reload persistence                                                              | Native form; shared durable config                                              | Suggested/custom model and effort persist across reload                                     | W, real browser                               | reviewer          | pass                |
| C15  | Invalid feedback and keyboard access                                                 | Labels/native controls/status region                                            | Keyboard selection/Enter; invalid model feedback preserves durable settings                 | W, real browser                               | reviewer          | pass                |
| C16  | Immutable running settings; selected-project routing                                 | Bound HTTP cwd; pinned SDK cwd; overlap guard                                   | Two projects/shared browser; active vs next run; cwd regression; failed-start retry         | O/W, final runtime                            | reviewer          | pass                |
| C17  | Source schema/init/run-record regressions                                            | Strict config/runtime parsers; generated consumers; additive map schema         | Unsupported handoffs/tampering; both generated consumers; legacy records and UI             | O/F/R/A, final harness                        | reviewer          | pass                |
| C18  | Docs/public interfaces/changesets                                                    | README/operator guide; documented exports; minor feature + patch repair entries | Link/default/export/route validator; declaration build; scoped artifact inspection          | L/B/D, current docs                           | reviewer          | pass                |
| B1   | Branch typecheck/build/clean scoped diff                                             | Final repaired source and test harness                                          | npm typecheck/build; formatter and diff check                                               | T/B/D, current production                     | reviewer          | pass                |
| R1   | Stable relative-project runtime routing                                              | Hydrate pins absolute projectDirectory                                          | Meaningful RED then GREEN; both reopened/created prompt and map operations                  | O, regression repaired                        | reviewer          | pass                |
| I1   | Final cumulative Linux implementation gate                                           | Exact integrated candidate                                                      | `bash .sandcastle/scripts/verify-affected.sh a22f71e6713d7fdba64f38b030c529aabcd58690`      | Future integrated source; not branch evidence | integration owner | pending-integration |
| I2   | Operator browser on integrated build                                                 | Exact integrated runtime/browser consumers                                      | `node --test scripts/operator.browser.test.mjs` after integrated build                      | Future integrated source; not branch evidence | integration owner | pending-integration |

Outcome: all branch-required review rows pass; R1 and all coverage findings are
repaired. Branch-ready for integration only. Task 2 and parent #1 remain open.
