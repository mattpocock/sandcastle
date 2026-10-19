# Local operator

Start the operator for an explicit host project:

```sh
npx sandcastle operator --cwd /path/to/project --port 4319
```

Open the printed loopback URL. Choose each role's suggested model or **Custom
model ID**, choose effort, and press **Save settings**. Native form controls
support keyboard navigation. Reloading reads the project's saved configuration.
The operator supports Codex's declared efforts: low, medium, high and xhigh.
Suggestions are convenience values, not a remote model availability check.
Authentication remains project-owned; the operator neither edits nor returns
credential values.

**Start run** launches the project's existing reviewed workflow. New
`parallel-planner-with-review` scaffolds selected with Codex and all `codex-afk`
scaffolds consume shared runtime settings. Use **Environment** to select/build
a Docker image and run preflight. Podman images still use the existing CLI
build command. Install the workflow's dependencies (including tsx) first. The CLI
adapter resolves the image to its immutable ID and passes that frozen runtime
to the one `.sandcastle/main.ts` or `main.mts`. It rejects legacy workflows
that do not consume frozen configuration; it does not rewrite existing copied
workflows. Adopt the SDK below for a customized project adapter.

**Observe runs and logs** opens Agent Map. `sandcastle dashboard` remains
read-only and retains its existing CLI and HTTP contracts. Closing the operator
closes observation; SDK project adapters own workflow cancellation. The CLI
terminates its owned child workflow when the CLI process shuts down.

## Configuration contract

The common CLI/web/SDK source is `.sandcastle/roles.json`:

```json
{
  "schemaVersion": 1,
  "revision": "<computed SHA-256 content revision>",
  "roles": {
    "planner": { "provider": "codex", "model": "gpt-6.1-sol", "effort": "low" },
    "implementer": {
      "provider": "codex",
      "model": "gpt-6.1-sol",
      "effort": "low"
    },
    "reviewer": {
      "provider": "codex",
      "model": "gpt-6.1-sol",
      "effort": "high"
    },
    "merger": { "provider": "codex", "model": "gpt-6.1-sol", "effort": "high" },
    "readiness": {
      "provider": "codex",
      "model": "gpt-6.1-sol",
      "effort": "high"
    }
  }
}
```

Init preserves its selected model for all five roles. A missing file uses
gpt-6.1-sol with the efforts shown above. An existing invalid file fails closed.
Schema version 1 requires exactly all five roles and their model/provider/effort
fields. Unknown fields, schema versions, providers and efforts are rejected.
Model IDs are 1–200 characters: letters, digits, dots, underscores, colons,
slashes or hyphens, beginning with a letter or digit. Config has no auth, prompt
paths, sandbox commands or executable fields.

### Schema version 2: multiple providers and fallback

Version 2 lets each role select any supported agent provider and an ordered
fallback chain. Version 1 files keep loading and saving unchanged; nothing is
converted implicitly. Convert explicitly with `migrateRoleConfig(config)` (which
preserves every role's behaviour) or by saving a provider/fallback change in the
operator web.

```json
{
  "schemaVersion": 2,
  "revision": "<computed SHA-256 content revision>",
  "roles": {
    "implementer": {
      "provider": "codex",
      "model": "gpt-6.1-sol",
      "effort": "medium",
      "fallback": [
        {
          "provider": "claudeCode",
          "model": "claude-sonnet-5-5",
          "effort": "high"
        }
      ]
    },
    "reviewer": {
      "provider": "claudeCode",
      "model": "claude-opus-5-5",
      "effort": "high"
    },
    "readiness": { "provider": "opencode", "model": "google/<gemini-model>" }
  }
}
```

(All five roles are still required; three are shown.) `effort` is optional and
validated against `providerCapabilities`, then mapped to the provider's own flag:

| Provider     | Accepted `effort`                        | Maps to                     |
| ------------ | ---------------------------------------- | --------------------------- |
| `codex`      | low, medium, high, xhigh                 | `-c model_reasoning_effort` |
| `claudeCode` | low, medium, high, xhigh, max            | `--effort`                  |
| `pi`         | off, minimal, low, medium, high, xhigh   | `--thinking`                |
| `copilot`    | low, medium, high                        | `--effort`                  |
| `opencode`   | free-form provider variant (plain token) | `--variant`                 |
| `cursor`     | none (field must be absent)              | —                           |

`fallback` holds at most three entries; an entry may not repeat the role's own
target or an earlier entry. Use `roleSetting(config, role)` for a normalized view
of either version. Credentials remain outside configuration: each provider uses
its own existing authentication; config references none.

In the SDK runtime, `runtime.agent(role, options)` builds the role's configured
provider. Top-level `options` remain Codex options (unchanged contract); pass
other providers' project options (session storage, env, permission mode) under
`options.providers.<provider>`. `runtime.agentChain(role, options)` returns the
primary provider followed by each fallback, and `runtime.roleSetting(role)` the
frozen setting.

#### Automatic fallback

`runtime.agent(role)` carries the role's fallback chain, so generated workflows
need no changes. Within each iteration the engine tries the primary first and
moves to the next entry only when both hold:

- the failure is classified as a provider failure — `rate-limit`,
  `unavailable` (5xx, overloaded, network), `authentication`, `missing-cli`,
  `model-unavailable`, or `startup-timeout` (idle timeout with no output); and
- the failed attempt made **no tool call**, so it cannot have edited files or
  created commits.

Any other failure, a failure after a tool call, or exhaustion of the chain ends
the iteration as before; when more than one provider was tried, the error lists
every attempt. Session resume/fork applies to the primary only, because
sessions are provider-specific. Each iteration result records `provider` (the
one that ran) and `providerAttempts`; Agent Map shows the attempts and the
provider/model/effort that actually ran when a fallback was used.

#### Credential scope

Providers built from role configuration run each command with every other
provider's well-known agent credential variables unset (`env -u …`), e.g. a
Codex role does not see `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, and a
Claude Code role does not see `OPENAI_API_KEY`. Multi-vendor agents (`pi`,
`opencode`) keep vendor API keys. Variables outside the provider table (for
example `GH_TOKEN` or project variables) are untouched, and providers created
directly with `codex(...)`, `claudeCode(...)` etc. are not scoped.

### Cross-provider review

A reviewer on a different provider from the implementer gives an independent
second opinion. Defaults are unchanged (all roles Codex).

- **Preset.** In the operator web, **Use cross-provider review preset** sets the
  reviewer to Claude Code (`claude-opus-5-5`, effort high), or to Codex when the
  implementer already uses Claude Code; press **Save settings** to apply. From
  host automation use `applyCrossProviderReviewPreset(config)`, which changes
  only the reviewer and returns a version-two document.
- **Policy.** Set `"review": { "requireDifferentProvider": true }` in
  `.sandcastle/workflow.json` (or tick **Require a different reviewer provider**
  in the workflow form). Run admission then fails with an actionable message when
  any provider the reviewer can run on — primary or fallback — is also one the
  implementer can run on. `reviewProviderConflict(config)` returns that message
  or `null`. The option is absent (off) by default.
- **Instructions.** Codex, OpenCode, pi, Copilot and Cursor read `AGENTS.md`;
  Claude Code reads `CLAUDE.md`. When a saved configuration lets any role run on
  Claude Code and the project has `AGENTS.md` but no `CLAUDE.md`, the operator
  (and init) create a `CLAUDE.md` containing `@AGENTS.md`, so instructions are
  not duplicated. An existing `CLAUDE.md` is never modified; if it does not
  import `AGENTS.md`, the save message says so. Host automation can call
  `ensureProviderInstructions({ cwd, config })`.
- **Protocol.** Bundled prompts are provider-neutral and completion remains the
  `<promise>COMPLETE</promise>` text, which every supported provider's stream
  parser surfaces.
- **Observation.** Agent Map shows each node's provider, model and effort, so
  implementer and reviewer providers are distinguishable, plus any fallback
  attempts.

### Review → repair loop

The `parallel-planner-with-review` workflow replaces single-pass review with a
bounded loop:

1. The reviewer ends with a structured verdict before the completion signal:

   ```text
   <review-verdict>{"verdict":"changes-requested","summary":"…","findings":[{"id":"F1","severity":"major","file":"src/a.ts","line":12,"change":"…"}]}</review-verdict>
   <promise>COMPLETE</promise>
   ```

   `verdict` is `approve`, `changes-requested` or `blocked` (`blocked` emits
   `<promise>BLOCKED</promise>` instead). `changes-requested` needs at least one
   finding; `approve` may list only `minor` findings; ids are unique.

2. On `changes-requested` the implementer runs again in the same sandbox with
   the findings as `{{REVIEW_FINDINGS}}`, then the reviewer re-reviews
   (`{{REVIEW_ROUND}}`).
3. Only an `approve` verdict with the completion signal admits the branch to
   merge. A `blocked` verdict, a blocked repair, an exhausted budget, or missing
   or malformed reviewer output (fails closed) keep the branch unmerged; other
   issues continue.

Set the budget with `"review": { "maxRepairRounds": 2 }` in
`.sandcastle/workflow.json` or **Review repair rounds** in the workflow form
(0–5, default 2). `0` restores single-pass review: the reviewer may repair in
place and a plain `<promise>COMPLETE</promise>` is accepted.

Agent Map records each review's verdict, summary and findings; a
`changes-requested` or invalid review shows as `stopped`, and repair runs appear
as implementer nodes titled "(repair N)". Host automation can use
`runReviewLoop`, `withReviewVerdict`, `parseReviewVerdict` and
`formatReviewFindings`.

Projects with customized prompts: the implementer prompt gains
`{{REVIEW_FINDINGS}}` and the reviewer prompt `{{REVIEW_ROUND}}` and
`{{REVIEW_REPAIR_ROUNDS}}`, plus the verdict instructions. A customized reviewer
prompt without the verdict instructions fails closed (`invalid-review`) unless
`maxRepairRounds` is `0`.

### Task retries and the provider circuit breaker

Each issue pipeline in `parallel-planner-with-review` runs through
`runTaskWithRetries`. A failed attempt is classified:

| Class            | Meaning                                                                         | Retried                |
| ---------------- | ------------------------------------------------------------------------------- | ---------------------- |
| `provider`       | the agent failed with a classified provider failure after its fallback chain    | yes, within the budget |
| `infrastructure` | sandbox, worktree, copy, sync or lifecycle timeout errors                       | yes, within the budget |
| `task`           | anything else: blocked or unapproved work, prompt errors, failed implementation | never                  |

Retries reuse the retained branch in a fresh sandbox, and the implementer node
is titled "(retry N)". A shared circuit breaker counts consecutive provider
failures across issues (task failures do not reset it; a success does). Once it
opens, no new pipeline starts, running pipelines finish, and the run stops with
the `provider-unavailable` diagnostic instead of planning further batches.

Configure in `.sandcastle/workflow.json` `limits`:
`"taskRetries": 1` (0–3, default 1) and `"consecutiveProviderFailures": 3`
(1–20, default 3). Host automation can use `runTaskWithRetries`,
`classifyPipelineFailure` and `createCircuitBreaker`.

### Merge mode

`parallel-planner-with-review` integrates approved branches in one of two modes,
set by `"merge": { "mode": "batch" }` in `.sandcastle/workflow.json` or **Merge
mode** in the workflow form:

- **`batch`** (default, unchanged): after every pipeline settles, one merger
  integrates all approved branches.
- **`per-branch`**: each approved branch enters a FIFO queue as soon as its
  review approves; a single consumer runs the merger for one branch at a time on
  the integration checkout while other pipelines keep running in their
  worktrees.

Both modes keep the same guards for every merge: the checkout is clean and at
the expected head before the merger starts; afterwards the head must have
advanced, be clean, on the planned branch, and contain the base and every merged
branch; then post-merge readiness/verification runs for exactly those branches.
In `per-branch` mode a merge that fails while leaving the checkout untouched
(for example a blocked merger) only retains that branch; any failure that
changed the checkout, or a failed post-merge verification, stops the queue.
Planning the next batch still waits for every pipeline and the queue to settle.

### Incremental readiness

After a merge, `parallel-planner-with-review` reassesses only issues whose
readiness can have changed (`incremental` option of `reassessGitHubReadiness`):

- issues that depend on an issue closed by the merge (same repository);
- issues whose body or comments mention a file changed by the merge
  (`git diff --name-only base HEAD`; names shorter than 4 characters or without
  `.`/`/` are ignored to avoid matching prose);
- issues labelled `readiness:reassess`.

Issues outside that set are not sent to the assessor and keep their previous
readiness record; if the set is empty no assessment runs. The selection is fixed
from the first snapshot, so freshness rechecks compare the same issues. The
startup assessment is always full, every `readiness.fullEvery` post-merge
assessments (default 5) is full, and a full assessment is used whenever the
changed files cannot be computed. The audit record states the scope
(`incremental` with selected/excluded numbers, or `full`). Configure with
`"readiness": { "fullEvery": 5 }` in `.sandcastle/workflow.json`;
`selectIncrementalReadiness` exposes the selection rules.

Use `loadRoleConfig({ cwd })` and `saveRoleConfig({ cwd, config })` to edit from
host automation. Save validates the entire document, computes the revision,
writes a private temporary file, syncs it and atomically renames it. Validation
failure preserves the last durable configuration. Revision is a digest, not a
counter or concurrency token; competing saves use last successful write wins.
Reads verify the stored revision. Pass the current loaded document to save
rather than hand-writing a revision.

## Workflow limits, tracker and feedback gates

**Workflow** edits `.sandcastle/workflow.json` through the same validated
`loadWorkflowConfig({ cwd })` / `saveWorkflowConfig({ cwd, config })` host API
used by the CLI child runtime. Choose the explicit GitHub `owner/repository`,
scope label, ready/blocked state labels, and hold labels (one per line). New
reviewed Codex workflows require an explicit repository before tracker or agent
execution; they never fall back to an upstream remote. Custom SDK adapters
continue to own their tracker boundary. Existing copied workflows need explicit
adoption of the runtime methods below; the operator does not rewrite them.

```json
{
  "schemaVersion": 1,
  "revision": "<computed SHA-256 content revision>",
  "repository": "owner/project",
  "scopeLabel": "Sandcastle",
  "readyLabel": "ready-for-agent",
  "blockedLabel": "blocked",
  "holdLabels": ["readiness:hold"],
  "limits": { "cycles": 10, "concurrency": 100, "plannerAttempts": 3 },
  "readiness": { "mode": "report-only", "verifier": null, "gates": [] }
}
```

Cycle limits count plan/execute/review/merge rounds, not individual agent
invocations. Cycles accept integers 1–1000, concurrent issue pipelines 1–100,
and planner validation attempts 1–10. Review and merge completion guards and
existing per-role invocation limits stay authoritative. Bounded scheduling
settles every pipeline in input order, including failures, before integration.
No-progress stops immediately; reaching the cycle limit with remaining work
fails the run. Qualification-only backlogs report pending external qualification
and leave their issues open.

Labels accept 1–50 letters/digits, spaces, dots, underscores, colons, slashes
or hyphens, starting with a letter/digit; surrounding whitespace is trimmed.
Scope, state, project qualification and effective hold labels must be distinct;
collisions with project-required holds are rejected before saving. Duplicate
holds/gates are rejected. Repository owners accept up to 39 letters/digits with
single interior hyphens; repository names accept up to 100 letters/digits, dots,
underscores or hyphens, including `.github`, but not `.` or `..`.
Reference names accept letters/digits, dots, underscores and hyphens, starting
with a letter/digit (maximum 100 characters). Unknown fields, repositories,
limits or references fail atomically with safe errors. Configuration files and
the configuration directory cannot redirect writes through symlinks.

A missing workflow file derives tracker defaults from project-owned
`.sandcastle/readiness.json`; a missing readiness file uses the example's labels,
null repository and report-only mode. Existing project apply mode is retained
only with its declared verifier. The shared runtime uses report-only for legacy
disabled readiness when an explicit repository is configured, preserving the
host admission checks. A saved workflow file becomes the editable source;
changes to trusted project policy are separate from saving its settings.
Malformed files and mismatched revisions fail closed. Save recomputes the digest
and uses the same private atomic persistence as role configuration. Competing
saves use the last successful complete write.

Commands remain host-owned. The existing `readiness.json.verifyCommand` argv
is exposed only as the reserved verifier reference **readiness**. Projects can
also declare references by creating `.sandcastle/feedback-gates.json` through
trusted host automation:

```json
{
  "verifiers": { "project": ["node", ".sandcastle/verify-readiness.mjs"] },
  "gates": { "tests": ["npm", "test", "--", "--run"] },
  "requiredGates": ["tests"]
}
```

The web lists names and selects references; it cannot accept executable text,
auth values, or edit these declarations. Declared argv runs on the selected host
project, without an implicit shell, with a five-minute timeout per command.
Each gate must exit successfully; then the selected verifier receives the full
readiness input as JSON on stdin and must return the existing readiness
verification JSON contract. Gates/verifiers are trusted host programs with the
host's environment. Keep authentication in project-owned environment/auth
references. Their output is not returned to the operator; failures produce safe
status diagnostics. A passing feedback command does not approve an agent's
proposal: the existing full-contract, source freshness, dependency completion
and integration, review, publication and readback checks still apply.

Project-required gates always run even if unchecked in the editable form.
Project-owned hold labels are unioned with editable holds; removing an editable
hold never removes a project hold. Qualification labels, parent context,
publication policy, standards and qualification adapters remain project-owned.
Readiness defaults to **report-only**. **Apply** requires an explicit repository
and a selected trusted project verifier. The form explains missing verifier
requirements; the run view reports feedback failures, no-progress, cycle limits
and pending qualification beside **Observe runs and logs**.

`inspectWorkflow({ cwd })` exposes only config, declared reference names,
required holds/gates and safe configuration diagnostics. At runtime:

- `runtime.workflow` exposes the frozen snapshot to trusted SDK callers.
- `runtime.readiness` supplies frozen effective tracker/readiness options.
- `runtime.settleIssues(issues, execute)` applies frozen issue concurrency.
- `runtime.verifyReadiness(input)` executes frozen required/selected gates and
  verifier; pass it to the existing readiness API's trusted `verify` callback.
- `runtime.reportOutcome({ code, issues })` records safe outcome codes
  `qualification-pending`, `no-progress`, `iteration-limit` or `feedback-failed`.
  `runtime.diagnostics()` reads them across the child-process boundary.

Settings and declaration argv are frozen privately at run start, with a digest
checked when reopening. Editing settings or declarations affects a later run.
Host command files remain project-owned programs; changing their contents can
change those programs, so do not modify gates during a run. Legacy role-only runtime records still reopen for their original role/prompt
operations. Workflow operations require the new frozen snapshot and fail with
an actionable message on those legacy records; start a new run rather than
inventing policy from live settings.

## Docker environment and jobs

**Environment** shows the configured name, installed host images, availability
and resolved SHA-256 identity. Select an installed image or **Custom image name**,
then press **Save environment**. Custom names may be unavailable until explicitly
built or installed outside the operator. Saves persist to private, atomic
`.sandcastle/environment.json`, isolated to the selected host project:

```json
{
  "schemaVersion": 1,
  "image": "sandcastle:my-project",
  "dockerfile": ".sandcastle/Dockerfile",
  "buildArgs": { "AGENT_UID": "1000" }
}
```

`loadEnvironmentConfig({ cwd })` and `saveEnvironmentConfig({ cwd, config })`
provide the same host automation interface. Missing settings use the project's
existing default image name and `.sandcastle/Dockerfile`. Corrupt settings and
configuration symlinks fail closed. Image names support repository/tag and
SHA-256 digest references. Dockerfiles must be existing files inside the
project: absolute paths, traversal, escaped symlinks, backslashes and shell
syntax are rejected. Build argument keys are identifiers; values are literal
letters/digits or `._/:@,+-`, up to 1,000 characters. The form accepts one
`KEY=value` per line. Arguments are passed directly, without a host shell.
Keep credentials in project-owned auth references rather than build arguments.
Build context is the selected project root, with the configured Dockerfile.
As with CLI builds, `AGENT_UID`/`AGENT_GID` default to the host UID/GID where
available; explicitly saved arguments override those defaults.

**Build image** and **Run preflight** start explicit asynchronous jobs using a
snapshot of saved settings. Output streams into a keyboard-focusable log viewer;
completed, failed and cancelled results remain visible across page reloads.
The operator retains the last 20 jobs and up to 65,536 UTF-16 code units of
output per job in this server session. Restarting the server starts a new job
history; saved settings remain durable. Build output redacts declared secret
environment values, including output split across chunks. Preflight discards
raw diagnostic output and reports only safe prerequisite summaries.

A build uses an owned temporary image tag and promotes the resolved image only
after success. Failure/cancellation preserves the previously usable image and
saved configuration. Cancel terminates the owned Docker process, escalating
if necessary, and removes only owned temporary tags/preflight sandboxes. Once
promotion starts, cancellation returns 409; wait for its terminal result.
Closing the operator cancels its environment jobs and waits for cleanup.
Ordinary Docker operations have a 30-second limit; builds have 30 minutes.
Save never builds, removes images, publishes images, or changes project gates,
bootstrap, branch-isolated caches or authentication mounts. Only an explicit
build changes image contents. Role/prompt/image edits apply to the next run;
active sandboxes use the frozen immutable image identity.

Preflight checks Docker daemon access, selected image identity, actual image
UID against the host UID, and required executable versions in ephemeral,
network-disabled sandboxes without project/cache/auth mounts. Default tools
are `git`, `gh`, `codex`; generated Node/npm profiles add `node`, `npm`, and
Android profiles add `java`, `sdkmanager`. Project profiles declare isolated
Codex auth at `.sandcastle/codex-home/auth.json`; an existing codex-home also
declares it. Secret environment keys declared in `.sandcastle/.env` are checked
using the existing environment resolver. Auth results explicitly mean file/value
presence, not verified remote login. Missing declarations are reported as such;
no credential contents are returned. Follow the project's existing login/setup
instructions (for isolated Codex, `CODEX_HOME=.sandcastle/codex-home codex login`).

Custom SDK adapters can declare `environment: { uid, tools, authFiles }`, using
executable names and a mapping of safe status labels to trusted host credential
file paths. HTTP cannot edit this policy. Custom adapters continue to own
`sandboxIdentity()` and sandbox construction: resolve
`(await loadEnvironmentConfig({ cwd })).image` through their Docker boundary
and use `runtime.record.sandboxIdentity` while retaining project-owned options.
The CLI adapter and new reviewed Docker scaffolds already do this. Existing
copied workflows require explicit adoption; the operator does not rewrite them.
Docker environment jobs do not alter existing Podman/provider contracts.

## Prompt customization and upgrades

Open **Prompts** to edit any configured role. Each editor shows default/override
ownership, content-addressed default/base versions, a text diff against the
current default and a separate changed-default diff. **Save** stores a private,
atomic project override in `.sandcastle/prompts/<role>.json`. **Reset** selects
the current default; it does not rewrite the project source file. Native forms
support keyboard save/reset. Saving or resetting one role preserves other roles'
unsaved drafts. Reloads and operator restarts retain saved overrides.

`loadProjectPrompts({ cwd, promptFiles })` exposes the same resolution used by
CLI, web and `createProjectRuntime`. `saveProjectPrompt({ cwd, promptFiles,
role, content })` saves a template; pass `content: null` to reset. The adapter's
trusted `promptFiles` remain source defaults unless the project explicitly
adopts packaged defaults. Null source paths disable a role. Existing custom
adapters and copied prompts keep their project ownership.

To use the installed package's `parallel-planner-with-review` defaults, run this
once from trusted host automation, supplying the project's tracker commands:

```ts
import { usePackagedPromptDefaults } from "@ai-hero/sandcastle";

await usePackagedPromptDefaults({
  cwd: "/path/to/project",
  templateArgs: {
    VIEW_TASK_COMMAND: "gh issue view <ID>",
    CLOSE_TASK_COMMAND: "gh issue close <ID>",
  },
});
```

This records selection and original defaults in
`.sandcastle/prompts/defaults.json`. It preserves existing copied files that
differ from the packaged defaults as overrides, including project-specific
Codex AFK guidance. It never migrates the workflow, standards, gates or auth.
Review compatibility before explicitly resetting a customized role. Untouched
copies (or missing source files) receive current installed defaults. Customized
roles retain their original base and selected content after package updates;
the editor shows changed-default diffs. Package updates and project migration
remain separate operations. The base version is a SHA-256 of rendered default
text; runtime evidence additionally records the installed package version and
exact selected content/digest. Keep prompt configuration and override files in
project version control as appropriate for their sensitivity; keep runtime
snapshots private.

Saves preserve required placeholders from the customization's base, reject
unknown or malformed placeholders, and preserve completion signals and output
tag literals present in that base. Placeholder syntax matches runtime
substitution, including whitespace and mixed-case names. Errors identify the
role and missing contract; rejected saves leave the durable prompt intact.
New shell expressions and control markers are rejected: executable expansion
policy belongs in trusted source defaults. Existing source shell expressions
can be retained. Prompt text and diffs render as data. Templates are limited to
1,048,576 UTF-16 code units; the HTTP request limit below also applies.
Settings and prompt edits during a run apply only to the next frozen runtime.

## Shared runtime SDK and project adapter

`createProjectRuntime({ cwd, promptFiles, sandboxIdentity })` freezes effective
settings before any role runs. Supply all five prompt paths (relative to cwd or
absolute), using null for roles without a prompt, and the resolved sandbox
identity. `runtime.agent(role, options?)` builds the configured Codex provider
while allowing project-owned session storage/environment/approval options.
Effort comes from the frozen configuration.

The runtime resolves its project directory when created or reopened. Later host
working-directory changes keep prompt access and observations in that project.

`runtime.promptFile(role)` returns an absolute host path to the frozen template;
existing prompt arguments and sandbox shell expansion still apply.
`runtime.createAgentMap(name)` records the runtime ID, config revision, version
and sandbox identity, and attaches the effective model/provider/effort to each
tracked role invocation. Use that same runtime's agent for the invocation.

Private `.sandcastle/runtime/<UUID>/record.json` records the package runtime
version, effective settings, image identity and all prompt contents/digests.
Frozen prompt copies are private too. New scaffolds ignore this directory.
Keep these files private: prompts can contain project-sensitive content.
A save or prompt edit while running affects the next runtime only.
`openProjectRuntime({ cwd, id })` reopens that frozen invocation for a
project-owned child process. It checks runtime version, identity, configuration
revision and prompt integrity; incompatible source records fail closed.
The CLI passes only the UUID using `SANDCASTLE_RUNTIME_ID`.

```ts
import { startOperator } from "@ai-hero/sandcastle";

const server = await startOperator({
  cwd: "/path/to/project",
  port: 0,
  adapter: {
    promptFiles: {
      planner: ".sandcastle/plan-prompt.md",
      implementer: ".sandcastle/implement-prompt.md",
      reviewer: ".sandcastle/review-prompt.md",
      merger: ".sandcastle/merge-prompt.md",
      readiness: ".sandcastle/readiness-prompt.md",
    },
    sandboxIdentity: async () => projectImageDigest,
    run: async (runtime) => {
      // Invoke your existing project workflow with this runtime.
      // Keep its sandbox, admission, review, completion, merge and readiness gates.
      await projectWorkflow(runtime);
    },
  },
});
console.log(server.url);
// await server.close() when observation should finish.
```

The adapter is trusted host code. HTTP cannot supply commands, change the
selected project or bypass the adapter's gates. Existing `run()`, providers
and `createAgentMap()` calls remain compatible.

## HTTP interface

The operator binds only to 127.0.0.1. Host must match its loopback authority.
Any supplied Origin must exactly match that host/port. All mutations additionally
require that Origin and the HttpOnly, SameSite=Strict local session cookie
established by opening `GET /`. There are no credential-valued APIs.

| Route                                      | Behavior                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/environment`                     | Saved environment config, installed images, availability and resolved identity                                                  |
| `PUT /api/environment`                     | Complete validated environment document; atomic save only                                                                       |
| `POST /api/environment/jobs`               | Exactly `{ "kind": "build" }` or `{ "kind": "preflight" }`; 202 with job snapshot                                               |
| `GET /api/environment/jobs`                | Last 20 operator-session jobs, including latest logs/results                                                                    |
| `GET /api/environment/jobs/<UUID>`         | Project-session job snapshot and terminal result                                                                                |
| `GET /api/environment/jobs/<UUID>/events`  | SSE `data` messages containing snapshots; bounded log replay, then live updates; closes at terminal status                      |
| `POST /api/environment/jobs/<UUID>/cancel` | Empty object; 202 after requesting cancellation, 409 during promotion                                                           |
| `GET /api/prompts`                         | Effective role templates, ownership, default/base contents and versions, changed-default status                                 |
| `PUT /api/prompts`                         | Exactly `{ "role": "implementer", "content": "..." }`; null content resets; returns resolved prompts                            |
| `GET /api/workflow`                        | Workflow settings, trusted reference names, required holds/gates and safe diagnostics                                           |
| `PUT /api/workflow`                        | Complete validated reference-only workflow document; atomic save                                                                |
| `GET /api/config`                          | Validated config, declared model/effort capability and selected project                                                         |
| `PUT /api/config`                          | Complete config document; returns the saved config/revision                                                                     |
| `POST /api/run`                            | Empty JSON object only; freezes settings, invokes the fixed adapter; 202 with ID/revision                                       |
| `GET /api/run`                             | Current operator-session status, frozen role/workflow settings and safe workflow diagnostics, excluding prompt/command contents |
| `GET /dashboard`                           | Opens the project's read-only Agent Map                                                                                         |

Mutations require `Content-Type: application/json` and at most 16 KiB.
Invalid config/body returns 400 with actionable diagnostics; invalid session,
origin or host returns 403; wrong content type 415; oversized body 413;
overlapping starts in one operator session 409. Query overrides are rejected.
Execution failures report failed status; inspect workflow logs and host output.

## Runtime Updates

Create the project-owned `.sandcastle/updates.json` before using **Updates**:

```json
{
  "schemaVersion": 1,
  "package": "@your-org/sandcastle-fork",
  "dependency": "@ai-hero/sandcastle",
  "registry": "https://registry.npmjs.org",
  "channel": "latest",
  "manifest": ".sandcastle/package.json",
  "source": { "kind": "registry" }
}
```

Replace the example identity with your maintainer's actual fork name. The
`dependency` key preserves existing workflow imports through an npm alias.
Registry, package, channel, destination and source are explicit; the operator
never tries the upstream namespace when fork resolution fails. The configured
fork registry takes precedence over npm scope mappings. Registry URLs use HTTPS
(HTTP is allowed for loopback test registries) without embedded
credentials. Keep npm authentication in your own `.npmrc` or npm environment;
status/errors never return tokens or raw npm output. The trusted project config
is edited on the host, not through browser input.

Use `.sandcastle/package.json` for isolated automation, including a fresh
consumer. Choose `package.json` only for an existing declared runtime dependency
in `dependencies` or `devDependencies`. Installation preserves that section and
pins the resolved exact fork version. It updates the selected manifest,
`package-lock.json` and `node_modules` together after staging and verification.
Use npm-managed manifests; workspace/link dependencies or installations needing
lifecycle scripts may need project-owned installation outside this facility.
Other package managers and copied workflow migrations are separate operations.

```sh
sandcastle updates --cwd /path/to/project --dry-run
sandcastle updates --cwd /path/to/project --version '^0.13.0' --dry-run
sandcastle updates --cwd /path/to/project --version 0.13.0-fork.123 --install
sandcastle updates --cwd /path/to/project --install
sandcastle updates --cwd /path/to/project --rollback
```

Without an action flag the CLI prints a plan. Dry-run resolves metadata without
changing the consumer manifest, lock or installation. Version constraints select
the highest matching release regardless of registry metadata order. Plans include
installed version/archive/integrity/source, selected exact version, release notes,
destination and a content revision. Legacy installed archives without release
provenance are identified explicitly and can be replaced by the selected fork;
they are not misrepresented as source-qualified releases. Plans label a runtime
as current only when its package, version, integrity and source
provenance match the candidate. Malformed installation evidence requires host
reconciliation before preview or installation. CLI phase progress
goes to stderr and the result is printed as JSON on stdout. Select one action
flag at a time.

For a development archive, change `source` to:

```json
{
  "kind": "archive",
  "path": "releases/your-org-sandcastle-fork-0.13.0-fork.123.tgz"
}
```

Paths resolve against the selected project, or may be absolute host paths.
The archive's embedded package identity must match the configured fork. Its
SHA-512 integrity and provenance are displayed. This source is **pinned**:
it never follows npm latest and rejects version selection; choose a new archive
path explicitly. Old upstream development archives are supported as existing
installations, while new install candidates must carry fork release metadata.

The Updates form previews the same plan and has an explicit **Install/update
runtime** action and **Roll back runtime** action. A browser install is bound
to the reviewed revision; changed candidate/manifest/lock requires another
preview. Progress and failures are polled asynchronously, keeping run observation
responsive. Active operator runs, running Agent Map recordings (including stale
unreconciled runs), and Git recovery ownership block install/rollback. A project
execution claim also excludes a second operator instance or CLI update when a custom adapter does not record Agent Map sessions. There is
no force override. Starting an operator run during its update job is rejected.
Restart the operator after success to load the new runtime.

Relaunch using the selected manifest's installed CLI. For the isolated manifest
and the dependency alias shown above:

```sh
node /path/to/project/.sandcastle/node_modules/@ai-hero/sandcastle/dist/main.js operator --cwd /path/to/project
```

For a root manifest, use `/path/to/project/node_modules/` instead. Adjust the
dependency path if configured differently. A global CLI installation is a
separate installation; restarting that executable keeps its own runtime version.

Installs disable lifecycle scripts, stage dependencies away from the active
installation, verify installed package exports/version, source and integrity,
and preserve workflows, prompts, standards, configuration, gates and auth.
Host manifest/lock or runtime-identity edits during staging reject promotion and
retain those edits. The managed evidence directory writes its own ignore rule so
private staging/rollback files stay out of consumer Git status.
An install does not adopt or rewrite copied workflows/defaults; use the explicit
SDK/default-adoption procedures above when needed. Root dependency installations
replace the selected manifest's complete dependency tree with npm's verified
staged result, so review compatibility and stop all project execution first.

Private `.sandcastle/updates/<UUID>/record.json` retains target/previous evidence,
original-file backups and phase state. The latest successful install retains
rollback access even after a later attempt fails. Failures before promotion
leave the active installation intact; promotion failures restore its backups.
After a process interruption, stop/reconcile the recorded npm/host processes,
inspect the private record and operation lock, then remove the stale
`.sandcastle/updates/operation.lock` only after proving its owner has stopped.
Run `--rollback` to restore a staging/promoting attempt before starting another
install. Never expire or steal a lock by age. Keep this entire directory private
and ignored: staging may contain copies of npm auth references and dependencies.

The host SDK exports `runtimeVersion`, `planRuntimeUpdate({ cwd, version })`,
`installRuntimeUpdate({ cwd, version, expectedRevision, onProgress })` and
`rollbackRuntimeUpdate({ cwd })`. Pass `null` for the configured channel (or
archive), and the plan revision for a reviewed install. Trusted CLI-style
automation may use `expectedRevision: null` to resolve immediately.

| Updates route                | Contract                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `GET /api/updates`           | Configured-channel/pinned-source plan                                              |
| `POST /api/updates/plan`     | Exactly `{ "version": null }` or a string tag/version/constraint; same plan        |
| `POST /api/updates/install`  | Exactly `{ "version": null, "revision": "<plan revision>" }`; 202 asynchronous job |
| `POST /api/updates/rollback` | Empty object; 202 asynchronous job                                                 |
| `GET /api/updates/job`       | Latest operator-session job, safe phase progress and terminal failure/result       |

All existing session, origin, host, content-type and project-scope protections
apply. Runtime installation is a maintainer-trusted package operation; the web
cannot change package identity, registry, source paths or host command policy.

## Preparing a fork release candidate

Build and check the reviewed source first. Then prepare a distinct fork package
without changing the source package identity or publishing anything:

```sh
npm ci
npm run typecheck
npm run build
node scripts/pack-fork.mjs --name @your-org/sandcastle-fork --out /tmp/fork-candidates
# Optional: --version 0.13.0-fork.20261012.1 --notes /path/to/release-notes.md
```

The default version includes the source version, timestamp and Git commit.
An explicit version must be a unique prerelease; an existing candidate filename
in the destination is rejected. Use a clean reviewed checkout and a fresh build.
The artifact includes all built public exports, CLI and operator UI, default
templates, MIT license, README, release notes, and `runtime-source.json`.
The package manifest embeds `sandcastleRuntime` with schema version 1, repository,
40-character source commit and the exact package version. `sandcastleChangelog`
contains release notes. A sibling `.tgz.json` receipt records source, file
inventory and independently calculated SHA-512 archive integrity.

Test the archive in a temporary consumer and exercise the same registry contract
with the loopback fake registry/real npm browser suite:

```sh
node --test scripts/operator-updates.browser.test.mjs
```

Registry candidates must expose the same embedded metadata through npm's
version metadata and use a tarball from the configured registry origin. Real
registry publication, registry accounts and channel promotion remain
maintainer-owned. This preparation command only packs a candidate; it does not
publish, run npm lifecycle scripts, change accounts or edit consumer projects.

## Existing-project migration

Package installation and consumer migration are separate reviewed actions. Install
and verify the explicitly configured fork with **Updates** first, then restart the
operator using that installed runtime. Open **Existing project migration**, preview
the file diffs and prompt base/default/override comparisons, confirm the review,
and explicitly choose to preserve prompt conflicts before applying. The status
reports completion or a readable conflict/error; configuration forms refresh after
apply or rollback. Migration does not establish readiness or acceptance.

The same operations are available without interactive prompts:

```sh
sandcastle migration --cwd /path/to/project --dry-run
# Copy revision from the reviewed JSON plan:
sandcastle migration --cwd /path/to/project --apply --revision <revision> --preserve-overrides
sandcastle migration --cwd /path/to/project --rollback
```

The recognizer supports GitHub/Docker reviewed Codex and Codex AFK Node/Android
consumers matching the generated orchestration at
`a22f71e6713d7fdba64f38b030c529aabcd58690`. It compares program structure statically,
allowing literal role settings, cycle/planner limits, sandbox options, mounts,
bootstrap hooks and AFK path/cache settings to vary. It never imports or evaluates
the consumer workflow to discover settings. Modified orchestration, dynamic role
settings, custom prompt paths, other providers/trackers and unmatched historical
templates remain unchanged with instructions to adopt `createProjectRuntime` /
`openProjectRuntime`, `runtime.agent` and `runtime.promptFile` manually. Different
per-role or dynamic images, including a mixture of default and explicit images,
also require a project adapter; a single literal image
moves into versioned environment settings. Nested environment values remain
project-owned; quoted image keys and spacing variations keep the frozen runtime
image at execution. Accessors, computed/escaped keys and top-level sandbox option
spreads require manual adaptation because they can override that image. Conflicting existing
image settings must be resolved on the host first.

A supported consumer retains its project-owned sandbox/hook code and uses the
shared runtime for frozen role, prompt, workflow and feedback settings. Explicit
legacy model/effort settings are retained, including AFK reviewer effort; roles
that had no explicit effort adopt the documented operator defaults. Existing
versioned role/workflow settings take precedence. Readiness policy, verifier/gate
commands, standards, Dockerfile, auth references, working branches and journals
remain project-owned. Migration preserves each legacy prompt as an explicit
override against a content-addressed known template base, while already-managed
prompts keep their original bases and reset/override choices. The current packaged
default is shown separately; no conflict automatically replaces project text.
Review prompt defaults before explicitly resetting an override later.

Plans include installed and target package/source/archive integrity, the managed
file snapshot, proposed file contents and recognizer provenance. Matching `0.12.0`
versions alone is insufficient: changed source commits or archive bytes require
a controlled runtime installation before migration. The installed SDK must expose
compatible versioned configuration and runtime APIs. The recognizer identity is
comparison evidence, not proof of the original legacy template's release source.

Apply requires the reviewed revision and validates the source snapshot again.
Managed files use durable temporary-file promotion individually; the whole set is
not a filesystem-wide atomic transaction. A private, ignored
`.sandcastle/migrations/latest.json` records the plan, source/runtime provenance,
managed originals and promotion progress before each write. Failures restore
promoted files where their contents still belong to the migration. Repeat apply
of an unchanged completed plan is a no-op. Active or unreconciled runs and runtime
operations block apply/rollback across operator instances.

After process interruption, prove the recorded owner has stopped before removing
its `.sandcastle/updates/operation.lock`, then run migration `--rollback` to recover
before applying again. Roll back migration **before** rolling back its runtime
installation. Rollback refuses to overwrite subsequent host edits; preserve those
edits and reconcile the named file manually. Private auth files, sessions, branches
and existing journals are never migration destinations or backup inputs. Recovery
records and backups have no HTTP download route; keep them private on the host.

Host SDK exports:

- `planProjectMigration({ cwd })`
- `applyProjectMigration({ cwd, expectedRevision, preserveOverrides, onProgress })`
- `rollbackProjectMigration({ cwd })`

| Migration route                 | Contract                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET /api/migrations/plan`      | File-by-file plan, prompt comparisons, status/instructions and content revision                          |
| `POST /api/migrations/apply`    | Exactly `{ "revision": "<reviewed revision>", "preserveOverrides": true }`; synchronous completion/error |
| `POST /api/migrations/rollback` | Empty object; synchronous restoration/error                                                              |

All existing session/origin/host/content-type protections apply. Requests cannot
select project paths, upload workflow code, alter package identity or access
private recovery backups. Migration web diffs redact declared secret values and
credential literals; the revision still binds the complete host snapshot.
