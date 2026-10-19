# Task 3 requirement ledger

Contract: GitHub task 3, successfully loaded in full at session start; parent
hanhnghh/sandcastle#1 product decisions and delivery requirements apply to prompt
ownership, frozen inputs, public compatibility and local security. Baseline:
`c4450f8dcb17ee55b952ddee71b30346eb78b34c`; branch `sandcastle/issue-3` began clean.

All receipts below are **new** executions on Linux, Node v24.21.0, npm 11.19.0,
repository package-lock.json, installed repository dependencies, Playwright
Chromium and the current source/test harness. No prior receipt was reused.
Dependencies were already present; no bootstrap/install was necessary. Graph
navigation identified runtime/server/CLI callers; new symbols missed the index,
so direct source reads established their exact contracts. There are no localized
operator documents beyond English.

## Executable evidence and exact tests

- **U**: `npm test -- src/OperatorPrompts.test.ts src/Operator.test.ts src/OperatorCli.test.ts src/PromptArgumentSubstitution.test.ts --run` — 60 tests passed, 2026-10-11 17:06:52 UTC, 4.84 seconds.
- **W**: `node --test scripts/operator.browser.test.mjs scripts/operator-prompts.package.test.mjs` — seven tests passed, 2026-10-11 17:06:53 UTC, 7.89 seconds. Isolated built package fixture updates packaged template files; browser fake Codex executable records selected prompt through the public `run()` boundary.
- **T**: `npm run typecheck` — passed, 2026-10-11 17:06 UTC.
- **B**: `npm run build` — passed, 2026-10-11 17:06 UTC, including declarations, template copying and the public Effect-free type validator.
- **A**: documented-artifact validator (`node --input-type=module`, exact command below) — passed, 2026-10-11 17:10 UTC; checks real SDK exports, README guide link, prompt HTTP/ownership contracts and package-named minor changeset.
- **D**: `git diff --check` and scoped diff/status inspection — passed, 2026-10-11 17:07 UTC. Changed-file `npx prettier --check` also passed.

Exact test names used in the matrix:

- **U1**: defaults advance while overrides retain their base and reset follows current defaults
- **U2**: invalid templates preserve prior prompt
- **U3**: selected overrides freeze at run start
- **U4**: prompt writes reject paths and symlink escapes
- **U5**: packaged default adoption preserves existing customized project files
- **U6**: template validation follows runtime placeholder syntax and rejects control-marker shell injection
- **U7**: operator HTTP requires a local session and exact origin/host and cannot partially save malformed requests
- **U8**: operator CLI serves only its explicit project and hands its frozen runtime to the fixed workflow
- **U9**: runtime freezes revision, prompt templates and image identity while the next run uses saved role settings
- **W1**: prompt editor saves with keyboard, reloads, resets and renders data
- **W2**: fake model receives selected prompt while edits apply to the next run
- **W3**: prompt overrides persist across an operator web restart and isolate projects
- **W4**: installed packaged defaults advance without overwriting project customization

## Final matrix

Command and exact-test IDs expand to the complete executable strings/names above.
Receipt applicability: U/W/T/B bind to the unchanged production source and their
listed harnesses on this branch; D additionally covers documentation/changeset.
All branch rows are owned by the implementer. I1 is the integration owner's
future gate, not a pass or waiver.

| ID  | source                            | requirement                                                      | public seam                | exact test                              | command                                                                                         | evidence (new/reused) | receipt/applicability                                                            | owner             | status              |
| --- | --------------------------------- | ---------------------------------------------------------------- | -------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------- | ----------------- | ------------------- |
| P1a | #3 AC1/6                          | each of five roles has editor and default/override status        | browser                    | W1, W3                                  | W                                                                                               | new                   | Linux/current source                                                             | implementer       | pass                |
| P1b | #3 AC1/6                          | edit/save/reload                                                 | browser/HTTP               | W1                                      | W                                                                                               | new                   | Linux/current source                                                             | implementer       | pass                |
| P1c | #3 AC1                            | persist across web restart                                       | browser/HTTP               | W3                                      | W                                                                                               | new                   | Linux/current source                                                             | implementer       | pass                |
| P1d | #3 AC1/6                          | reset to current default                                         | browser/SDK                | W1, U1, U5                              | W, U                                                                                            | new                   | Linux/current source                                                             | implementer       | pass                |
| P1e | #3 AC1/2                          | readable editor/default and changed-default diffs                | browser                    | W1                                      | W                                                                                               | new                   | diff opened by keyboard, plus/minus text                                         | implementer       | pass                |
| P2a | #3 AC2; #1 ownership              | override distinct from versioned default/base                    | SDK                        | U1, W4                                  | U, W                                                                                            | new                   | content-addressed versions, retained original base                               | implementer       | pass                |
| P2b | #3 AC2                            | untouched prompts receive current packaged defaults              | installed SDK              | W4                                      | W                                                                                               | new                   | isolated package templates updated after adoption                                | implementer       | pass                |
| P2c | #3 AC2/6                          | customized prompts survive updates and show changed defaults     | installed SDK/browser      | W4, W1                                  | W                                                                                               | new                   | override/base unchanged, new default visible                                     | implementer       | pass                |
| P2d | #1 ownership/public compatibility | existing customized project files survive explicit adoption      | SDK/file contract          | U5, W4                                  | U, W                                                                                            | new                   | original files remain untouched                                                  | implementer       | pass                |
| P3a | #3 AC3/6                          | unknown role rejected                                            | HTTP                       | U4                                      | U                                                                                               | new                   | traversal role rejected with 400                                                 | implementer       | pass                |
| P3b | #3 AC3/6                          | unknown/missing/malformed template placeholders rejected         | SDK                        | U2                                      | U                                                                                               | new                   | each invalid case retains prior public read                                      | implementer       | pass                |
| P3c | #3 AC3                            | runtime whitespace/mixed-case placeholder syntax supported       | SDK                        | U6                                      | U                                                                                               | new                   | matches existing substitution contract, 40 compatibility tests in U              | implementer       | pass                |
| P3d | #3 AC3                            | completion/output contracts required by runtime preserved        | SDK                        | U2, U6                                  | U                                                                                               | new                   | missing completion, role output and custom output tag rejected                   | implementer       | pass                |
| P3e | #3 AC3                            | invalid save gives actionable error and preserves prior template | browser/SDK                | W1, U2                                  | W, U                                                                                            | new                   | role and missing literal shown; reload retains override                          | implementer       | pass                |
| P3f | #3 AC3; #1 security               | prompt content rendered as data                                  | browser                    | W1                                      | W                                                                                               | new                   | script text retained; no page execution or errors                                | implementer       | pass                |
| P4a | #3 AC4                            | fake model receives selected prompt                              | public run/browser         | W2                                      | W                                                                                               | new                   | fake external executable receives frozen template text                           | implementer       | pass                |
| P4b | #3 AC4; #1 snapshot               | run records exact content/digest and runtime version             | SDK runtime                | U3, U9                                  | U                                                                                               | new                   | selected content/digest, immutable snapshot and version                          | implementer       | pass                |
| P4c | #3 AC4/6                          | editing during execution leaves active run unchanged             | SDK/browser                | U3, W2                                  | U, W                                                                                            | new                   | active snapshot unchanged after save                                             | implementer       | pass                |
| P4d | #3 AC6                            | next-run semantics and CLI/shared runtime resolution             | SDK/CLI/browser            | U3, U8, W2                              | U, W                                                                                            | new                   | next invocation receives saved prompt                                            | implementer       | pass                |
| P5a | #3 AC5; #1 security               | writes confined to selected managed prompt area                  | HTTP/storage/browser       | U4, W3                                  | U, W                                                                                            | new                   | second project isolated; fixed role filenames; directory symlink rejected        | implementer       | pass                |
| P5b | #3 AC5                            | traversal and attempts to touch authentication rejected          | HTTP/storage               | U4                                      | U                                                                                               | new                   | path/auth fields rejected; outside authentication bytes preserved                | implementer       | pass                |
| P5c | #1 security                       | local session, exact origin/host checks remain authoritative     | HTTP                       | U4, U7                                  | U                                                                                               | new                   | shared pre-route guard; hostile prompt Origin rejected                           | implementer       | pass                |
| P5d | #1 security                       | web cannot introduce host executable text                        | SDK                        | U2, U6                                  | U                                                                                               | new                   | new shell expressions and internal control marker rejected                       | implementer       | pass                |
| P6a | #3 AC7                            | document customization and upgrade ownership                     | README/operator guide      | scoped artifact inspection              | D                                                                                               | new                   | SDK examples, ownership/reset/upgrade and HTTP contracts agree                   | implementer       | pass                |
| P6b | #3 AC7; AGENTS.md                 | minor changeset without duplicates                               | changeset artifact         | scoped artifact inspection              | D                                                                                               | new                   | all existing changesets inspected; package name matches manifest                 | implementer       | pass                |
| B1  | feedback loops                    | affected type checks                                             | public SDK types           | package typecheck                       | T                                                                                               | new                   | unchanged production/type source                                                 | implementer       | pass                |
| B2  | feedback loops                    | affected build/consumer contract checks                          | built SDK/CLI/templates    | package build and public-type validator | B                                                                                               | new                   | built declarations and templates, W/U CLI consume completed build                | implementer       | pass                |
| B3  | completion gate                   | task-scoped diff, formatting and final status                    | git/artifacts              | scoped inspection                       | D                                                                                               | new                   | no unrelated initial changes, secrets, generated artifacts or local state staged | implementer       | pass                |
| I1  | feedback loops                    | authoritative integrated full/cumulative gate                    | exact integrated candidate | full gate                               | bash .sandcastle/scripts/verify-affected.sh <batch-base-sha> (includes package/Agent Map gates) | new (future)          | immutable integration baseline and final integrated source                       | integration owner | pending-integration |

## RED/GREEN and diagnosis notes

Resolution first failed at the missing API, then an executable stub produced the
expected missing selected content (16:55 UTC); real resolution passed at 16:56.
Invalid-template test first accepted invalid content, then passed with validation
(16:56–16:57). Snapshot test first selected the original default instead of the
override, then passed with shared resolution (16:57). HTTP security test first
returned unsupported-route 405, then passed with the protected prompt route
(16:58). Browser editor test first timed out on the absent Prompts link, then
passed after UI wiring. Packaged adoption test first lacked its public API,
then passed with explicit ownership selection (17:01). Runtime syntax test
first rejected a spaced built-in placeholder, then passed with runtime-aligned
syntax, generic output tags and control-marker rejection (17:04).

A browser next-run assertion initially observed the preceding completed status;
it now waits for a different run identity before asserting completion. No
product behavior was relaxed. At 17:06 the CLI test ran concurrently with a
build cleaning `dist` and exited 1. This was a scheduling error: after the build
completed, the original four-file command passed all 60 tests at 17:06:52.
There are no unresolved branch failures. No full-gate pass is claimed.

## Documented-artifact validator

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import * as sdk from './dist/index.js';
const readme = readFileSync('README.md', 'utf8');
const guide = readFileSync('docs/operator.md', 'utf8');
assert.ok(readme.includes('[operator guide](docs/operator.md)') && existsSync('docs/operator.md'));
for (const name of ['loadProjectPrompts', 'saveProjectPrompt', 'usePackagedPromptDefaults']) {
  assert.equal(typeof sdk[name], 'function');
  assert.ok(guide.includes(name));
}
for (const contract of ['GET /api/prompts', 'PUT /api/prompts', 'original base', 'next frozen runtime']) assert.ok(guide.includes(contract), contract);
const change = readFileSync('.changeset/versioned-project-prompts.md', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert.ok(change.startsWith(`---\n"${pkg.name}": minor\n---\n`));
console.log('PASS: documented SDK exports, guide link, prompt HTTP/ownership contracts and minor package changeset');
JS
```

The docs website package owns `docs/content/docs`, as declared by
`docs/source.config.ts`; these root-linked Markdown guides do not change its
build inputs. No docs website build is applicable.

## Independent review

Reviewer loaded issue #3's full body, labels and comments with
`gh issue view 3 --json number,title,body,labels,comments`. Parent #1's product
decisions were read only to interpret ownership, frozen inputs and local
security. Review baseline is `c4450f8dcb17ee55b952ddee71b30346eb78b34c`,
implementation source is `5616fc1787ad23cbc57b961a0762dd3ae9b52c1a`.
The complete host coding standards, feedback loops and evidence policy were
read before judging changes or choosing checks. No implementer receipt is
reused: their applicability is not independently validated. All P1a–P6b,
B1–B3 rows above need new reviewer evidence; I1 remains owned by integration.

Review findings before repair:

- R1: saving/resetting a role calls `loadPrompts()` which replaces every
  editor, discarding other roles' unsaved drafts. Add browser regression,
  establish RED, then refresh only the saved role and retain keyboard focus.
- R2: CLI evidence checks frozen model/effort/image but not prompt selection.
  Strengthen the public CLI/child-runtime test to observe saved prompt text
  and next-run selection. This is a coverage gap, not a proven product defect.
- R3: first SDK saves check directory existence before non-recursive mkdir;
  concurrent saves can race during managed-directory creation. Persistence
  needs new public SDK evidence before repairing this suspected defect.

All findings are repaired. R1 reproduced at the browser seam: the reviewer
draft became the default after saving implementer. The focused command
`node --test --test-name-pattern='saving and resetting a role' scripts/operator.browser.test.mjs`
failed, then passed after role-local refresh/focus restoration and a build
(1 test, 1.10 seconds). R3 reproduced through concurrent public SDK saves:
some promises rejected while creating managed storage. The focused command
`npm test -- src/OperatorPrompts.test.ts --run -t 'concurrent first saves'`
failed at 17:15:02 UTC (1.52 seconds), then passed at 17:15:11 UTC
(1.72 seconds) after idempotent mkdir. The first reproduction used
`Promise.all`; the final harness uses `Promise.allSettled` so cleanup waits
for every save. No failure classification or expected behavior was relaxed.
R2's strengthened CLI evidence passed without a product repair; a meaningful
RED was not applicable to this coverage-only finding.

### Reviewer receipts

All executions below are new review evidence on 2026-10-11, Linux
6.12.54-linuxkit, Node v24.21.0, npm 11.19.0, installed lockfile dependencies,
Vitest 3.2.4 and Playwright 1.63.0 Chromium. No external model, container service
or migration is needed: fake executables and temporary no-sandbox projects
exercise public runtime/CLI/browser seams. Test cleanup completed. Build
finished before the final built-package tests started.

Receipt location: this section. Tested production, relevant consumers,
manifests, templates and harness bytes are bound by SHA-256
`69b1282044aa0b5fd09d260a6adbab2f8addef9e9bece7d7ab0592e50f8f9cd7`.
The fingerprint is computed over sorted filenames plus NUL, file bytes plus
NUL, for: package.json, package-lock.json, tsconfig.json, tsup.config.ts;
src/{index,Operator,OperatorPrompts,OperatorRuntime,OperatorServer,operatorAssets,
OperatorCli,InitService,writePrivateRecord,PromptArgumentSubstitution,
PromptPreprocessor}.ts; src/{OperatorPrompts,Operator,OperatorCli,
PromptArgumentSubstitution,PromptPreprocessor}.test.ts;
scripts/{operator.browser.test,operator-prompts.package.test,
check-public-types-effect-free}.mjs; and all five
src/templates/parallel-planner-with-review/\*-prompt.md files.
These are focused receipts, not reusable full-gate proof. Only documentation
ledger recording follows these executions; tested product/harness bytes are
unchanged in the review commit.

- **RU**: `npm test -- src/OperatorPrompts.test.ts src/Operator.test.ts src/OperatorCli.test.ts src/PromptArgumentSubstitution.test.ts src/PromptPreprocessor.test.ts --run`
  — 74 passed, start 17:18:05 UTC, 5.06 seconds. U1–U9 above retain their exact
  names. U8 now observes selected and next-run prompt content in the real CLI's
  child runtime. Additional exact tests: **U10**, `concurrent first saves retain
each role's project override`; **U11**, `managed prompt records cannot follow
authentication symlinks`. U2 now protects a previously saved override, and
  U4 also tests missing/forged sessions and absent/hostile Origins at the
  prompt endpoint. The additional preprocessor suite independently checks
  trusted shell expansion and failure semantics (12 tests).
- **RW**: `node --test scripts/operator.browser.test.mjs scripts/operator-prompts.package.test.mjs`
  — eight passed, 17:18 UTC, 7.97 seconds. W1–W4 above retain their exact names.
  W1 now independently asserts both diff signs, opens both diffs by keyboard,
  rejects unknown/malformed templates and checks no script DOM is inserted.
  W3 now asserts every role's ownership status. Additional exact test **W5**:
  `saving and resetting a role preserves other prompt drafts and keyboard focus`.
- **RT**: `npm run typecheck` — passed at 17:18 UTC, 0.98 seconds, including
  the final typed regression tests.
- **RB**: `npm run build` — passed at 17:17 UTC, declarations in 6.79 seconds,
  postbuild copied templates and passed the public Effect-free type validator.
  Existing bundler unused-import notices did not fail the build.
- **RA**: `node --input-type=module` documented-artifact validator above,
  extended to assert the draft documentation and package-named patch changeset
  — passed at 17:18 UTC. Checks real built SDK exports and README guide link.
- **RD**: `git diff --check`, changed-file `npx prettier --check`, full scoped
  diff and final status inspection — pass. All changesets were read before
  adding the distinct patch changeset; no duplicates or unrelated churn.

### File review coverage

Each original file was read through its complete
`git diff c4450f8dcb17ee55b952ddee71b30346eb78b34c...sandcastle/issue-3 -- <path>`;
the repair diff was additionally inspected in full. No encoded/generated
payloads needed alternate review. Graph explore/query/impact/node/affected
guided navigation, with direct reads for graph misses. Graph output is not
used as correctness evidence.

| File                                        | Review method and result                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| .changeset/versioned-project-prompts.md     | Full diff + all changesets + manifest name; unique minor feature entry, RA passes.                                                          |
| README.md                                   | Full diff + operator section/link target; ownership summary remains accurate, RA passes.                                                    |
| docs/evidence/issue-3.md                    | Full diff + policy/applicability audit; historical implementer evidence retained, new independent review recorded.                          |
| docs/operator.md                            | Full diff + surrounding SDK/HTTP contracts; accurate ownership/upgrade limits, draft wording repaired, RA passes.                           |
| scripts/operator-prompts.package.test.mjs   | Full diff + package producer/consumer path; isolated real built SDK defaults advance without replacing customization, RW passes.            |
| scripts/operator.browser.test.mjs           | Full diff + fixture/fake-provider/cleanup; public browser evidence strengthened, RW passes.                                                 |
| src/OperatorPrompts.test.ts                 | Full diff + public API assertions; durable override, concurrency and auth symlink regressions strengthened, RU passes.                      |
| src/OperatorPrompts.ts                      | Full diff + source templates/substitution/preprocessor/private-write callers; R3 repaired, containment/hash/validation checked, RU/RW pass. |
| src/OperatorRuntime.ts                      | Full diff + snapshot creation/hydration/reopening; selected prompt frozen, digest/version/integrity retained, RU/RW pass.                   |
| src/OperatorServer.ts                       | Full diff + complete route/security/semaphore handling; fixed project/role writes under shared session/origin guard, RU/RW pass.            |
| src/index.ts                                | Full diff + manifest exports + built public types; documented SDK surface is Effect-free, RB/RA/RW pass.                                    |
| src/operatorAssets.ts                       | Full diff + script/DOM/CSP consumer; R1 repaired, text-only diff/editor rendering and keyboard behavior verified, RW passes.                |
| src/OperatorCli.test.ts                     | Full repair diff + OperatorCli/CLI/InitService consumers; exact selected/next-run prompt in real child runtime, RU passes.                  |
| .changeset/preserve-prompt-editor-drafts.md | Entire new artifact + existing entries/manifest; distinct patch for R1/R3, RA passes.                                                       |

The relevant prompt ADRs and CONTEXT terminology were checked. Effect owns
production IO/error channels, exported APIs have JSDoc, path comparisons
normalize separators, host paths use host joins, and tests observe public seams
without mocking internal collaborators. Root Markdown guides are not website
build inputs (`docs/source.config.ts` points to content/docs); no website gate
applies. No product-scope or task-contract changes were made.

### Final reviewer ledger

RU/RW/RT/RB bind to the fingerprint/environment above and are fresh reviewer
runs. RA/RD additionally cover the final documentation/changesets and inspected
diff. U/W exact test names are defined above; no acceptance relies on a nearby
test alone. Implementation columns name the observable path checked against
each assertion. All branch rows are owned by the reviewer.

| ID  | requirement                                                      | implementation evidence                                | test evidence                                                | receipt/applicability                                                                                   | owner             | status              |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ----------------- | ------------------- |
| P1a | Five role editors and default/override status                    | operatorAssets role fieldsets and status text          | W3 all labels/statuses                                       | RW, public browser                                                                                      | reviewer          | pass                |
| P1b | Edit/save/reload                                                 | prompt PUT and persistent role record                  | W1, W5                                                       | RW, public browser/HTTP                                                                                 | reviewer          | pass                |
| P1c | Persistence across web restart                                   | project record resolution on GET                       | W3 restart                                                   | RW, new operator instance                                                                               | reviewer          | pass                |
| P1d | Reset to current default                                         | null override resolution                               | W1, U1, U5, W4                                               | RU/RW, browser/SDK                                                                                      | reviewer          | pass                |
| P1e | Readable editor/default and changed-default diffs                | text-only signed diff against default/base             | W1 both signs and keyboard opening                           | RW, browser                                                                                             | reviewer          | pass                |
| P2a | Override distinct from default/base version                      | content-addressed ProjectPrompt base/default           | U1, W4                                                       | RU/RW, public resolution                                                                                | reviewer          | pass                |
| P2b | Untouched prompts receive current defaults                       | packagedDefault with retained adoption bases           | W4 package template update                                   | RW, isolated installed SDK                                                                              | reviewer          | pass                |
| P2c | Customized prompts survive updates and show changed-default diff | override/base retained; defaultChanged surfaced        | W4 preserved customization; W1 displayed diff                | RW, installed SDK + browser                                                                             | reviewer          | pass                |
| P2d | Existing customized project files survive adoption               | local source classified as project override            | U5; W4 source unchanged after reset                          | RU/RW, SDK/source ownership                                                                             | reviewer          | pass                |
| P3a | Validate role names                                              | fixed operatorRoles allowlist                          | U4 traversal role                                            | RU, prompt HTTP                                                                                         | reviewer          | pass                |
| P3b | Validate missing/unknown/malformed template arguments            | validate placeholder scanner and base requirements     | U2, W1                                                       | RU/RW, SDK + browser                                                                                    | reviewer          | pass                |
| P3c | Runtime whitespace/mixed-case syntax compatible                  | matching substitution syntax                           | U6; 40 substitution tests                                    | RU, public resolution + compatibility                                                                   | reviewer          | pass                |
| P3d | Required completion/output literals preserved                    | validation of base's completion/output tags            | U2, U6                                                       | RU, public saves                                                                                        | reviewer          | pass                |
| P3e | Actionable invalid-save errors preserve prior prompt             | validation before atomic private record write          | U2 saved override preserved; W1 error/reload                 | RU/RW, public save/read                                                                                 | reviewer          | pass                |
| P3f | Prompt content rendered as data                                  | textarea.value and diff.textContent                    | W1 literal script/diff and absent script DOM                 | RW, browser                                                                                             | reviewer          | pass                |
| P4a | Fake model receives selected prompt                              | frozen runtime promptFile through run()                | W2 fake executable stdin                                     | RW, public model/run seam                                                                               | reviewer          | pass                |
| P4b | Record exact selected content/digest/version                     | immutable RuntimeRecord and reopen integrity           | U3, U9                                                       | RU, SDK content and independently known digest                                                          | reviewer          | pass                |
| P4c | Edits during execution cannot change active prompt               | snapshot files isolated from live overrides            | U3, W2                                                       | RU/RW, active SDK/browser runtime                                                                       | reviewer          | pass                |
| P4d | Next-run and CLI/shared resolution                               | createProjectRuntime shared loader; CLI child reopen   | U3, strengthened U8, W2                                      | RU/RW, SDK/real CLI/browser                                                                             | reviewer          | pass                |
| P5a | Writes confined to selected managed project                      | canonical directory guards and fixed role filenames    | U4, U11, W3                                                  | RU/RW, SDK/HTTP/project isolation                                                                       | reviewer          | pass                |
| P5b | Traversal and authentication writes rejected                     | strict HTTP fields; symlink read guards                | U4 auth/path fields; U11 record/root symlinks                | RU, rejection + unchanged external auth bytes                                                           | reviewer          | pass                |
| P5c | Local session and exact Origin/Host remain authoritative         | pre-route OperatorServer guard                         | U4 prompt session/origin cases; U7 wrong Host                | RU, HTTP boundary                                                                                       | reviewer          | pass                |
| P5d | Web cannot add host shell execution                              | shell-expression allowlist + control-marker rejection  | U2, U6; 12 preprocessor tests                                | RU, public save + runtime expansion compatibility                                                       | reviewer          | pass                |
| P6  | Browser/public tests cover all AC6 named scenarios               | editor/HTTP/SDK/runtime/CLI seams                      | W1–W5, U1–U11 as mapped above                                | RU/RW, edit/save/reload/reset/invalid/default-change/keyboard/next-run                                  | reviewer          | pass                |
| P6a | Customization/upgrade ownership documented                       | README link and operator SDK/HTTP/ownership guide      | documented-artifact validator                                | RA/RD, actual exports and artifacts                                                                     | reviewer          | pass                |
| P6b | Correct changesets without duplicates                            | manifest-named minor feature and distinct patch repair | validator + full changeset inspection                        | RA/RD, project standard                                                                                 | reviewer          | pass                |
| R1  | Retain other drafts and keyboard focus on save/reset             | refresh saved role only; restore action focus          | W5 RED then GREEN                                            | RW, public browser regression                                                                           | reviewer          | pass                |
| R2  | CLI prompt evidence gap closed                                   | real CLI child's frozen promptFile read                | strengthened U8 first/next-run exact content                 | RU, coverage-only repair                                                                                | reviewer          | pass                |
| R3  | Concurrent first saves preserve every role                       | idempotent mkdir followed by containment check         | U10 RED then GREEN                                           | RU, public SDK regression                                                                               | reviewer          | pass                |
| B1  | Affected type checks                                             | public interfaces + final typed tests                  | npm run typecheck                                            | RT, final typed source                                                                                  | reviewer          | pass                |
| B2  | Affected build/consumer checks                                   | bundled SDK/CLI/templates/declarations                 | npm run build; RU CLI; RW built SDK                          | RB/RU/RW, final production source                                                                       | reviewer          | pass                |
| B3  | Scoped diff, standards, formatting and clean committed branch    | full original/repair file inspection                   | diff check + Prettier + final status                         | RD, final artifacts                                                                                     | reviewer          | pass                |
| I1  | Future integrated full/cumulative gate                           | exact final integrated candidate                       | bash .sandcastle/scripts/verify-affected.sh <batch-base-sha> | Immutable integration batch baseline; includes typecheck, full npm test, build, Agent Map browser gates | integration owner | pending-integration |

Branch-ready for integration; task #3 remains open. No full-gate result or
issue closure is claimed. No unresolved in-scope failures remain.
