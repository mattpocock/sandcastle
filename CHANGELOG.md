# @ai-hero/sandcastle

## 0.5.10

### Patch Changes

- 95d63a4: Apply `:z` SELinux label by default on Docker bind mounts, matching the existing Podman behavior. Adds `selinuxLabel` option to `DockerOptions` (`"z"` | `"Z"` | `false`, default `"z"`). Extracts shared `formatVolumeMount` from Podman provider into `src/mountUtils.ts` so both providers use the same volume-mount formatter.
- 9bf43df: Auto-create parent directories for file-target bind mounts under `/home/agent`. When a user mount targets a single file whose sandbox-side parent directory may not exist in the image (e.g. `/home/agent/.codex/auth.json`), both Docker and Podman providers now run `mkdir -p` + `chown` on the parent at container start. File mounts whose parent is outside `/home/agent` fail at config time with a clear error and remediation guidance.
- adbb3cc: Add `variant` option to the `opencode` agent provider for controlling reasoning effort via opencode's `--variant` CLI flag.

## 0.5.9

### Patch Changes

- 1b742cb: Replace hardcoded "GitHub issues" language in simple-loop and sequential-reviewer templates with backlog-agnostic wording so scaffolded projects read correctly regardless of the chosen backlog manager.
- a85d6c0: Add Docker UID alignment via build-arg and pre-flight diagnostic. Dockerfile templates now accept `AGENT_UID`/`AGENT_GID` build-args (default 1000) and `sandcastle docker build-image` defaults them to the host UID/GID. The Docker provider gains `containerUid`/`containerGid` options and a pre-flight `docker image inspect` check that catches UID mismatches before container start. See ADR-0014.
- 856e6b7: fix: unescape `\n`, `\r`, `\t`, and `\\` in double-quoted `.env` values to match standard dotenv semantics
- 77590d0: fix: sequential-reviewer template uses createSandbox so implementer and reviewer share a branch

  The sequential-reviewer template previously used `merge-to-head` for the implementer, which merged the temp branch into HEAD and deleted it. The reviewer then tried to create a worktree for the host branch (e.g. `main`), which was already checked out — causing a git worktree conflict.

  Restructured to use `createSandbox()` with an explicit named branch, so both the implementer and reviewer run in the same sandbox on the same branch. This matches the pattern used by the parallel-planner-with-review template.

- c9f8348: Fix Docker mount failures on Windows hosts by switching from `-v host:sandbox` to `--mount type=bind,source=...,target=...` format (avoiding colon ambiguity with drive letters), and adding missing `patchGitMountsForWindows` calls in `createSandbox` and `createSandboxFromWorktree` code paths.
- 0fd2e74: Add structured output support: `Output.object({ tag, schema })` and `Output.string({ tag })` extract typed, validated payloads from agent stdout. Adds `output` option to `RunOptions` with overloaded return type, `StructuredOutputError` for extraction failures, and entry-time validation for `maxIterations === 1` and tag-in-prompt checks.

## 0.5.8

### Patch Changes

- 7400ead: Add a short hint to the `parallel-planner` and `parallel-planner-with-review` plan prompts noting that the issues list is already filtered, so the planner agent is less likely to requery and pick up issues outside the configured filter.
- 21b6442: Fix Windows hosts emitting backslash separators for in-container paths during session capture/resume and `copyPaths`. `sandboxSessionStore`, `defaultSessionPathsLayer`, and `startSandbox`'s `copyPaths` now use POSIX joins for paths that target the Linux container, so `docker cp` / `podman cp` no longer reject them on Windows.

## 0.5.7

### Patch Changes

- 904ad82: Fix `PromptError: Prompt argument "{{TASK_ID}}" has no matching value in promptArgs` thrown on every iteration of the `simple-loop`, `sequential-reviewer`, and `parallel-planner*` merge flows after `sandcastle init`. The `VIEW_TASK_COMMAND` and `CLOSE_TASK_COMMAND` registry values used to embed `{{TASK_ID}}`, which got baked into prompts whose runtime promptArgs do not include `TASK_ID`. They now use a plain `<ID>` placeholder for the agent to fill in from surrounding context.

## 0.5.6

### Patch Changes

- 54b5111: Add `timeouts.copyToWorktreeMs` option to override the host-to-worktree copy timeout (default: 60 000 ms).
- d8484ca: Surface fallback `cp -R` failures from `copyToWorktree` as a typed `CopyToWorktreeError` instead of silently swallowing them
- b6cc84f: Fix `WorktreeManager.pruneStale` deleting active worktrees when `.sandcastle` (or any ancestor of the repo directory) is a symlink. `git worktree list` returns canonicalized paths, so the un-canonicalized prefix never matched the active set and parallel `createSandbox()` calls would wipe each other's worktrees mid-run, surfacing as `spawn /bin/sh ENOENT`.
- 26920ca: Fix `branchStrategy.baseBranch` being silently dropped when calling `sandcastle.run()` with a worktree-based sandbox. New branches now correctly fork from the requested `baseBranch` instead of the host's HEAD.
- bbb0f39: Fix `encodeProjectPath` to handle Windows paths by replacing backslashes with hyphens and stripping drive-letter colons, producing a valid single directory-name component on Windows.
- b2123e4: Add optional `timeoutMs` field to hook objects, allowing per-hook timeout overrides with fallback to the default 60s
- a658fcc: Update Quick Start install command to recommend `--save-dev` and note that Sandcastle is a dev/CI tool
- 425b77e: Use APFS clonefile (`cp -cR`) on macOS for copy-to-worktree instead of GNU `--reflink=auto`, giving Mac users instant copy-on-write on APFS volumes

## 0.5.5

### Patch Changes

- e868d2d: Fix `createWorktree` failing with "already exists" when reusing a preserved mid-rebase worktree. Collision detection now also matches by target path, covering the detached-HEAD state during an in-progress rebase.

## 0.5.4

### Patch Changes

- 9c8516d: Surface agent error details in `AgentError` when stderr is empty. Error events emitted to stdout by Codex and Pi, plus OpenCode's result text, are now parsed and included in the error message instead of being dropped.
- b2cc893: Show context window size per iteration in the run summary. Each iteration with usage data emits a `Context window: NNNk` line (tokens rounded up to the nearest 1000) in both terminal and log-to-file mode.
- 2843c1b: Support `baseBranch` when creating sandboxes, so new branches can be forked from a specified ref. Available both on `createSandbox` and in the named branch strategy.
- d860e84: Fix Beads Dockerfile build failure on arm64 hosts (e.g. Apple Silicon). The image now builds on both amd64 and arm64.
- fdd9b9e: Fix built-in review prompt templates so they respect the configured source branch instead of always diffing against `main`.
- cfbeb67: Fix parallel-planner-with-review template to capture reviewer result and merge commits from both implementer and reviewer runs
- eb03260: Fix transient worktree creation failure when `branch.autoSetupMerge` or `push.autoSetupRemote` is enabled globally
- 4032e64: Inline prompts (`prompt: "..."`) are now passed to the agent literally — no `{{KEY}}` substitution, no `` !`command` `` expansion, no built-in `{{SOURCE_BRANCH}}` / `{{TARGET_BRANCH}}` injection. Fixes #453: callers that build inline prompts from arbitrary content (issue bodies, PR descriptions) no longer fail when that content happens to contain `{{...}}`. Passing `promptArgs` alongside an inline prompt is now an error; use `promptFile` to opt into template behavior.
- 6bc4d74: Fix `PromptPreprocessor` executing `` !`...` `` patterns that arrive via `promptArgs` substitution. Argument values are now treated as inert data: only shell blocks written in the raw template are executed. Previously, any caller passing text through `promptArgs` (issue titles, bodies, docs excerpts, etc.) could hit spurious command execution — or, with untrusted inputs, remote shell execution — because the preprocessor scanned the fully-assembled prompt after substitution.
- 359907e: Add `onAgentStreamEvent` option to `logging` in log-to-file mode. The callback receives each `text` chunk and `toolCall` emitted by the agent, with the iteration number and a timestamp, so callers can forward the agent's output stream to an external observability system. Errors thrown by the callback are swallowed so a broken forwarder cannot kill the run.
- ce1bf1b: Support tilde expansion in `sandboxPath` for Docker and Podman mount configs.

  Users can now write `sandboxPath: "~/.npm"` and it expands to `/home/agent/.npm` inside the sandbox. The expansion uses the provider's declared `sandboxHomedir` (`"/home/agent"` for Docker and Podman). Using `~` in `sandboxPath` with a provider that has no `sandboxHomedir` throws a descriptive error at mount resolution time.

## 0.5.3

### Patch Changes

- 2e7147b: Show commit-aware sync logs only for isolated sandboxes. Displays "Syncing N commit(s) to host" when commits exist or "No commits to sync out" when there are none, instead of the generic "Syncing changes to host" message. Bind-mount providers no longer show sync logs since sync-out only applies to isolated sandboxes.
- b0d5400: Fix git worktree mounts broken on Windows hosts (issue #410). On Windows, the parent `.git` directory is now mounted at a deterministic POSIX path inside the sandbox, and the worktree's `.git` file is patched with a corrected `gitdir:` path that resolves inside the Linux container.

## 0.5.2

### Patch Changes

- 1c71374: Add AbortSignal support for cancelling runs and interactive sessions. Pass `signal` to `run()`, `interactive()`, `Sandbox.run()`, `Sandbox.interactive()`, or any Worktree equivalent. Aborting kills the in-flight agent subprocess; handles remain usable for subsequent calls. Lifecycle hooks (`host.onWorktreeReady`, `host.onSandboxReady`, `sandbox.onSandboxReady`) are also cancelled when the signal fires.
- 148905b: Expose per-iteration token usage on `IterationResult` via a new `usage?: IterationUsage` field. Returns raw token counts (`inputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`, `outputTokens`) for Claude Code runs. Non-Claude agent providers return `undefined`.
- 95ef2bd: Fix Codex agent provider not logging output during runs.
- 6ca70c1: Fix session resume failing with `docker cp (in) failed` / `podman cp (in) failed` when the sandbox's project directory didn't yet exist.
- 8d4e8ef: Fix Windows paths breaking Docker/Podman volume mounts. Backslashes in host paths and Windows-style sandbox paths are now normalized before reaching the container runtime.
- a971e1e: Faster sandbox startup — remove the recursive `chown` that ran on every Docker and Podman container start. Add `containerUid`/`containerGid` options to the Podman provider for controlling in-container ownership.
- 49c461e: Fix duplicate command entries appearing in the task log. Each command now appears once (with its token count).
- a2dff20: Remove `throwOnDuplicateWorktree` option; worktrees are now always reused — clean worktrees log a message, dirty worktrees log a warning.
- 51d668c: Fix runs failing when prompts exceed 128 KB on Linux. Prompts are now delivered via stdin instead of command-line arguments, avoiding the `execve(2)` argument size limit.
- 308a1f6: `Worktree.run()` now accepts `resumeSession` to resume a prior Claude Code session by ID, matching the existing support on top-level `run()`.

## 0.5.1

### Patch Changes

- ba6121e: Add a `cwd` option to `createSandbox()`, `createWorktree()`, `run()`, and `interactive()`. When provided, `cwd` replaces `process.cwd()` as the host repo directory used for worktrees, `.sandcastle/.env`, logs, patches, and git operations, letting you drive Sandcastle from outside the target repo. Relative paths resolve against `process.cwd()`; absolute paths pass through. A `CwdError` is raised when the path does not exist or is not a directory.
- f872268: Fix session capture, which always failed with "Could not find the file". Sandcastle was looking for session JSONLs under a `sessions/` subdirectory that Claude Code does not actually use.

## 0.5.0

### Minor Changes

- 800e743: Restructure hooks API to group by execution location (`host` vs `sandbox`). The old flat `hooks: { onSandboxReady }` shape is replaced with `hooks: { host?: { onWorktreeReady?, onSandboxReady? }, sandbox?: { onSandboxReady? } }`. Host hooks run on the developer's machine; sandbox hooks run inside the container. Breaking change (pre-1.0).

### Patch Changes

- 4515aa9: Add `copyFileIn` and `copyFileOut` methods to `BindMountSandboxHandle` for moving individual files between the host and the sandbox. Docker uses `docker cp`, Podman uses `podman cp`, and the new `testBindMount()` provider uses a plain filesystem copy.
- 3aa9d9a: Fix Podman sandbox failing on macOS when host UID differs from 1000 by chowning /home/agent to the host UID:GID after container start, matching Docker provider behavior.
- 0a84413: **Breaking:** Replace `RunResult.iterationsRun` with `RunResult.iterations: IterationResult[]`. Each `IterationResult` carries an optional `sessionId` extracted from Claude Code's stream-json init line. Consumers needing the iteration count should read `iterations.length`. Non-Claude agent providers produce `sessionId: undefined`. The same change applies to `OrchestrateResult`, `SandboxRunResult`, and `WorktreeRunResult`.
- 85eb071: Add session capture and resume for Claude Code:
  - **Capture:** after each iteration, the agent's session is saved to the host at `~/.claude/projects/<encoded>/sessions/<id>.jsonl` so it can be replayed or inspected locally with Claude Code's usual tooling. Adds `captureSessions` option to `claudeCode()` (default `true`) and `sessionFilePath` to `IterationResult`.
  - **Resume:** adds `resumeSession` option to `run()` for continuing a prior Claude Code conversation in a new sandbox run. Incompatible with `maxIterations > 1`.
  - Exposes the underlying `SessionStore` interface and `transferSession` helper for users who want to move sessions between the host and a sandbox directly.

## 0.4.8

### Patch Changes

- c8cfcc6: Add timeout to the isolated provider `copyPaths` loop in `startSandbox`. The entire copy loop is now wrapped with `withTimeout` (120s), producing a `CopyToWorktreeTimeoutError` on expiry, consistent with the per-step timeout pattern used elsewhere in the sandbox lifecycle.
- bab11e9: Add `network` option to Docker and Podman sandbox providers for custom container networking
- a2c580f: Make Dockerfile generation aware of the selected backlog manager. When "beads" is chosen, the Dockerfile installs beads CLI tools instead of GitHub CLI.
- a2fd5ad: Generate `.env.example` dynamically during `sandcastle init` based on selected agent and backlog manager instead of copying a static file from the template directory.
- 20741fe: Fix parallel-planner templates to use {{CLOSE_TASK_COMMAND}} placeholder instead of hardcoded "close the issue" language, and replace "GitHub issue" with backlog-agnostic wording
- b7880ec: Make `prompt`/`promptFile` optional in `interactive()` — when neither is provided, the agent TUI launches with no initial prompt (the full prompt pipeline is skipped).
- aea1131: Add per-step timeouts across the sandbox lifecycle. Every lifecycle step is now wrapped with `Effect.timeoutFail` via a `withTimeout` utility, producing a step-specific tagged error on expiry. Breaking: `TimeoutError` renamed to `AgentIdleTimeoutError` with `timeoutMs` field replacing `idleTimeoutSeconds`.
- c261079: Support relative paths in MountConfig for bind-mount sandbox providers. `hostPath` relative paths resolve from `process.cwd()`, and `sandboxPath` relative paths resolve from the sandbox repo directory.
- d13acc3: Remove unnecessary `copyToWorktree` and `branchStrategy` from planner and merger agents in parallel planner templates. These lightweight agents (maxIterations: 1) now default to head mode, avoiding the overhead of copying node_modules into worktrees.
- 0f8a99a: Remove semaphore concurrency limiter from parallel-planner-with-review template. Issue pipelines now run concurrently via Promise.allSettled without a concurrency cap, matching the parallel-planner template.
- bf23e83: Rename workspace terminology back to worktree across the codebase. All public API types and functions renamed from `Workspace*` to `Worktree*` (e.g. `createWorktree()`, `Worktree`, `WorktreeBranchStrategy`). `copyToWorkspace` renamed to `copyToWorktree`. `sandboxWorkspacePath` renamed to `sandboxRepoPath` and `SANDBOX_WORKSPACE_DIR` to `SANDBOX_REPO_DIR` for sandbox-internal paths. Source files renamed accordingly (`WorktreeManager.ts`, `CopyToWorktree.ts`, `createWorktree.ts`).

## 0.4.7

### Patch Changes

- 6d0c1fb: Make `sandbox` optional in `InteractiveOptions`, defaulting to `noSandbox()`

## 0.4.6

### Patch Changes

- fdeccd4: Change agent provider `buildPrintCommand` and `buildInteractiveArgs` to accept an options object `{ prompt, dangerouslySkipPermissions }` instead of a bare prompt string. The `claudeCode()` factory now conditionally includes `--dangerously-skip-permissions` based on the boolean.
- f413493: Add backlog manager selection to `sandcastle init` (GitHub Issues or Beads). All templates use placeholders (`{{LIST_TASKS_COMMAND}}`, `{{VIEW_TASK_COMMAND}}`, `{{CLOSE_TASK_COMMAND}}`) replaced at scaffold time with the correct commands for the chosen manager. Parallel-planner uses `{ id: string }` instead of `{ number: number }` in plan JSON, `TASK_ID` instead of `ISSUE_NUMBER` in prompt args, and raw IDs in log output. Selecting Beads skips the "Create Sandcastle label" step.
- 0e2e5fe: Fix `sandcastle init` to strip `--label Sandcastle` from scaffolded prompt files when user declines label creation
- f413493: Add `interactive()` API for launching interactive agent sessions inside sandboxes, replacing the old `interactive` CLI command. Includes the `sandbox.interactive()` method on `createSandbox()`, full prompt preprocessing (promptFile, shell expressions, argument substitution), all three branch strategies, `onSandboxReady` hooks, `copyToWorkspace` for worktree providers, env resolution, and `interactiveExec` on Docker and Podman providers. ClackDisplay now shows intro/summary and progress (creating worktree, copying files, starting sandbox, syncing, merging, commit collection) for interactive sessions.
- 29d224d: Add interactive arg collection for missing prompt arguments. When `interactive()` encounters `{{KEY}}` placeholders with no matching prompt argument, it prompts the user at the terminal via `@clack/prompts` text input. Built-in args (`SOURCE_BRANCH`, `TARGET_BRANCH`) are excluded from prompting. `run()` behavior is unchanged.
- 83a86f6: Add no-sandbox provider for interactive mode. `noSandbox()` runs the agent directly on the host with no container isolation — only accepted by `interactive()`, not `run()` or `createSandbox()`. The agent does not receive `--dangerously-skip-permissions`, so the user manages permissions themselves. Import from `@ai-hero/sandcastle/sandboxes/no-sandbox`.
- f413493: Fix Podman integration: rootless mode support with `--userns=keep-id` flag (configurable via `userns` option), pre-flight image existence check, Podman Machine detection on macOS/Windows, 5s timeout on signal handler cleanup, correct `:ro,z` syntax for SELinux-labeled readonly bind mounts, and `interactiveExec` for interactive agent sessions via `podman exec -it`.
- 0cde1a2: Add PodmanLifecycle module and `sandcastle podman build-image` / `sandcastle podman remove-image` CLI commands, mirroring the existing Docker CLI commands for Podman users.
- 530a8af: Fix Podman container crashes: rename base image's `node` user (UID 1000) to `agent` instead of creating a new user, so `--userns=keep-id` maps to the correct home directory owner. Override entrypoint in `podman run` to avoid double-sleep when the image already defines `ENTRYPOINT ["sleep", "infinity"]`.
- 8bcb78e: Add post-agent logging to withSandboxLifecycle for syncing, merging, and commit collection phases
- 1844288: Rename `copyToSandbox` option to `copyToWorkspace` across the public API (`run()`, `interactive()`, `createSandbox()`) and rename internal module `CopyToSandbox.ts` to `CopyToWorkspace.ts`. This aligns with the formalized distinction between "sandbox" (isolation boundary) and "workspace" (directory where the agent runs). No behavior changes.
- 35feb6f: Add sandbox provider selection (Docker / Podman) to `sandcastle init`. Selecting Podman writes `Containerfile` instead of `Dockerfile` and uses Podman-specific build commands.
- c54e389: Show per-command estimated token counts in the "Expanding shell expressions" taskLog after shell expressions resolve

## 0.4.5

### Patch Changes

- e84ffe3: Add a Codex `effort` option that forwards `model_reasoning_effort` to Codex for exec and interactive runs.

## 0.4.4

### Patch Changes

- 98d22da: Add `applyToHost` lifecycle callback to `SandboxInfo` so isolated providers can sync changes to the host worktree before host-side git operations. Fix `baseHead` recording to use the host worktree instead of the sandbox, ensuring correct commit collection after `syncOut` creates new SHAs via `format-patch`/`am`.
- be40c63: `createSandbox()` now uses the shared `startSandbox` helper, adding support for isolated sandbox providers (e.g. Vercel, Daytona). Each `run()` call syncs commits back to the host worktree via `applyToHost`.
- 0d393c9: Write SandboxError messages to the log file when run() fails in file-logging mode
- c0a4db3: Isolated sandbox providers now create worktrees, matching the bind-mount lifecycle. This enables proper branch strategy support (merge-to-head and named branches) and failure-mode worktree preservation for isolated providers.
- 973ed21: Run onSandboxReady hooks and shell expressions in parallel for faster environment setup
- 4f99506: Allow optional whitespace inside prompt argument placeholders so that both `{{ARG}}` and `{{ ARG }}` resolve identically

## 0.4.3

### Patch Changes

- e3fd351: Add `sudo` option to hook commands and `exec()` interface for running commands with elevated privileges inside sandboxes
- a30acb3: Strip matching surrounding quotes from .env file values so that `KEY="value"` and `KEY='value'` are parsed as `value` instead of including literal quote characters
- f1fdd4f: Log files now append between runs instead of overwriting. Each run writes a `--- Run started: <ISO timestamp> ---` delimiter header, preserving logs from previous runs of the same branch+agent combination.

## 0.4.2

### Patch Changes

- cd2a219: Fix templates crashing with "copyToSandbox is not supported with head branch strategy" by adding explicit `branchStrategy: { type: "merge-to-head" }` to all template `run()` calls that use `copyToSandbox`.
- 2cafddd: Use sandbox provider's `workspacePath` instead of hardcoded `/home/agent/workspace` for sandbox-side commands, fixing Vercel sandbox support where the workspace is at `/vercel/sandbox/workspace`.

## 0.4.1

### Patch Changes

- 0bb95e2: Add CODING_STANDARDS.md to reviewer-based templates (sequential-reviewer, parallel-planner-with-review) so the reviewer agent has concrete standards to enforce during code review.
- bb444af: Add optional `mounts` config to `docker()` and `podman()` providers for mounting host directories (e.g. package manager caches) into sandbox containers. Each mount supports `hostPath` (with `~` expansion), `sandboxPath`, and optional `readonly` flag. Throws a clear error if a host path does not exist.
- 16315da: Add Daytona isolated sandbox provider (`@ai-hero/sandcastle/sandboxes/daytona`)
- a8e7d72: Add OpenCode as a built-in agent provider. The `opencode()` factory returns an `AgentProvider` that invokes `opencode run` with raw stdout passthrough (no JSON stream parsing). Includes CLI registry entry, init scaffold with Dockerfile template, and documentation.
- 9d6dfba: Add `parallel-planner-with-review` template that combines parallel execution with per-branch code review using `createSandbox`. Also fix `maxIterations` defaults: sequential-reviewer reviewer 10→1, parallel-planner merger 10→1.
- 859f2f5: Add Podman sandbox provider (`sandcastle/sandboxes/podman`) as a bind-mount provider mirroring Docker's behavior with SELinux label support
- d917d69: Allow sandbox providers and agent providers to accept `env: Record<string, string>` at construction time. Provider env is merged with the `.sandcastle/.env` resolver output at launch, with provider values taking precedence. Agent and sandbox provider env must not have overlapping keys.
- 6192024: Add `throwOnDuplicateWorktree` option to `RunOptions` and `CreateSandboxOptions`. When set to `false`, a worktree collision reuses the existing worktree instead of failing. Defaults to `true` (current behavior).
- 22ec222: Add Vercel isolated sandbox provider (`sandcastle/sandboxes/vercel`) using `@vercel/sandbox` SDK
- 0d08a33: Buffer Pi provider text deltas before display to prevent one-word-per-line terminal output in stdout mode
- 448c9da: Support directories in `copyIn` for isolated sandbox providers and rename `copyOut` to `copyFileOut`
- c30f690: Derive CLI version from package.json instead of hardcoding it.
- 6e7738d: Fix sequential-reviewer template: replace broken prompt argument placeholders with self-contained issue selection and closure logic matching the simple-loop pattern
- a43cfe4: Merge `exec` and `execStreaming` into a single `exec` method with an optional `onLine` callback in options.

  **Breaking change (pre-1.0):** The `execStreaming` method has been removed from `BindMountSandboxHandle`, `IsolatedSandboxHandle`, and `SandboxService`. Use `exec(command, { onLine: (line) => ... })` instead.

  **Migration:** Replace `handle.execStreaming(cmd, onLine, { cwd })` with `handle.exec(cmd, { onLine, cwd })`.

- d1b75e4: Move `branchStrategy` from sandbox provider config to `run()` options. Branch strategy is now specified as an optional field on `RunOptions` instead of on provider factory functions like `docker()`. When omitted, defaults to `{ type: "head" }` for bind-mount providers and `{ type: "merge-to-head" }` for isolated providers. Using `{ type: "head" }` with an isolated provider now throws a clear runtime error.
- 8265b88: Remove Docker-specific language from JSDoc comments on provider-agnostic APIs
- 90c017d: Reset idle timer on any stdout line from the sandbox, not just parsed structured events. This prevents false idle timeouts for providers that emit non-JSON output (e.g. TUI-based agents).

## 0.4.0

### Minor Changes

- 40a756f: Replace `worktree` config with `branchStrategy` on the sandbox provider. Define `BranchStrategy` types (`head`, `merge-to-head`, `branch`) and wire them into bind-mount and isolated providers. `IsolatedSandboxProvider` exposes `branchStrategy` (defaulting to `{ type: "merge-to-head" }`), `testIsolated()` accepts a `branchStrategy` option, and TypeScript prevents `{ type: "head" }` on isolated providers at compile time. The deprecated `worktree` field on `RunOptions` and the `WorktreeMode` type have been removed. README documentation, code examples, the "How it works" section, and option tables have been updated to use `branchStrategy` terminology throughout.

### Patch Changes

- 6a16d69: Make chownInContainer non-fatal so sandbox startup doesn't crash when chown -R fails on macOS VirtioFS read-only bind mounts
- 105f1ef: Fix pi parser to handle current pi-mono JSON stream format
- 7bf0961: Remove TokenUsage feature from all providers and orchestrator. The TokenUsage interface, extractUsage helper, formatUsageRows function, and usage summary display have been deleted. ParsedStreamEvent's result variant no longer carries a usage field.
- c8df3a1: Point users to #191 for using Claude subscription instead of an API key in .env.example, README, and init CLI output

## 0.3.0

### Minor Changes

- 5b04e73: ### Breaking changes
  - `sandbox` is now a required option on `run()` and `createSandbox()`
  - `imageName` removed from top-level `RunOptions` and `CreateSandboxOptions` — image configuration now lives inside the sandbox provider (e.g. `docker({ imageName })`)
  - `docker()` factory is exported exclusively from `@ai-hero/sandcastle/sandboxes/docker`
  - `sandcastle build-image` and `sandcastle remove-image` are now `sandcastle docker build-image` and `sandcastle docker remove-image`

  ### New features
  - Pluggable sandbox provider abstraction with bind-mount and isolated provider types
  - `createBindMountSandboxProvider` and `createIsolatedSandboxProvider` factories
  - Filesystem-based test isolated provider
  - Git bundle sync-in for isolated providers
  - `copyToSandbox` support for isolated providers via `copyIn` after sync-in
  - Git format-patch/am sync-out for committed changes
  - Git diff/apply sync-out for uncommitted changes
  - Untracked file extraction via `copyOut` back to the host
  - Artifact persistence and recovery for failed sync-out (patches saved to `.sandcastle/patches/<timestamp>/`)

## 0.2.4

### Patch Changes

- 4d79ab9: Add optional `effort` parameter to `claudeCode()` for controlling Claude Code's reasoning effort level (`low`, `medium`, `high`, `max`)

## 0.2.3

### Patch Changes

- 01846be: Fix Docker sandbox failing when run from a git worktree. When `.git` is a worktree file (not a directory), also mount the parent repository's `.git` directory so git can resolve the repository inside the container.

## 0.2.2

### Patch Changes

- 008e539: Use `.mts` extension for scaffolded main file to fix ESM resolution in projects without `"type": "module"` in package.json. When the project's package.json has `"type": "module"`, the file is scaffolded as `main.ts` instead.

## 0.2.1

### Patch Changes

- fc62054: Fixed npm global install permission error in PI and Codex agent Dockerfiles by running `npm install -g` as root before switching to the `agent` user.

## 0.2.0

### Minor Changes

- 674e426: Add `{ mode: 'none' }` worktree variant that bind-mounts the host working directory directly into the sandbox container. No worktree is created, pruned, or cleaned up, and no merge step runs after iterations complete. Commits go directly onto the host's checked-out branch. `copyToSandbox` throws a runtime error with `mode: 'none'`. Both `SOURCE_BRANCH` and `TARGET_BRANCH` built-in prompt arguments resolve to the host's current branch.

### Patch Changes

- 77765bb: Add codex agent provider: `codex(model)` factory, stream parser for Codex CLI's `--json` JSONL output, Dockerfile template, init scaffolding, and CLI support
- 1f2134d: Add pi as a supported agent provider. `pi(model)` factory function is exported from `@ai-hero/sandcastle`. Pi's `--mode json` JSONL output is parsed correctly (message_update, tool_execution_start, agent_end events). `sandcastle init --agent pi` scaffolds a working setup with pi's Dockerfile and correct `main.ts`. `sandcastle interactive --agent pi` launches an interactive pi session.
- 3aff5f5: Refactor AgentProvider to runtime-only factory pattern. `run()` now requires `agent: claudeCode("model")` instead of `model: "..."`. The `claudeCode` factory and `AgentProvider` type are now exported from the package. Removed: `getAgentProvider`, `parseStreamJsonLine`, `formatToolCall`, `DEFAULT_MODEL` from public API.
- 75b4400: Bump default idle timeout from 5 minutes to 10 minutes to reduce spurious TimeoutError failures during long agent operations
- c62b429: Wire CLI interactive command for multi-agent support. The `interactive` command now accepts `--agent` and `--model` flags, uses the provider's `buildInteractiveArgs()` for docker exec, and displays the provider name in status messages.
- b1dd427: Add `createSandbox()` programmatic API for reusable sandboxes across multiple `run()` calls
- 54e76e0: Decouple init scaffolding from runtime providers. `envManifest` and `dockerfileTemplate` removed from `AgentProvider` interface. `sandcastle init` now has `--agent` and `--model` flags with interactive agent selection. Dockerfile templates owned by init's internal registry. Each template carries a static `.env.example` file copied as-is during scaffold. Scaffolded `main.ts` is rewritten with the selected agent factory and model.
- f35fa48: Log periodic idle warnings every minute of agent inactivity
- fabf0f7: Use run name instead of agent name in worktree and branch naming. When a `name` is provided to `run()`, worktree directories and temp branches now include the run name (e.g. `sandcastle/<name>/<timestamp>`) instead of the agent provider name. Renamed `sanitizeAgentName` to `sanitizeName`.
- cce183a: Replace top-level `branch` option on `RunOptions` with a `worktree` discriminated union that explicitly models two workspace modes: `{ mode: 'temp-branch' }` (default) and `{ mode: 'branch', branch: string }`. This is a breaking change — the old `branch` field is removed.

## 0.1.8

### Patch Changes

- 783b4cd: Base worktree cleanup on uncommitted changes rather than run success/failure.

  Previously, worktrees were always preserved on failure and always removed on success. Now the decision is based on whether the worktree has uncommitted changes (unstaged modifications, staged changes, or untracked files):
  - Success + clean worktree: remove silently (same as before)
  - Success + dirty worktree: preserve and print "uncommitted changes" message
  - Failure + clean worktree: remove and print "no uncommitted changes" message
  - Failure + dirty worktree: preserve with current preservation message

  `RunResult` now includes an optional `preservedWorktreePath` field set when a successful run leaves a worktree behind due to uncommitted changes. `TimeoutError.preservedWorktreePath` and `AgentError.preservedWorktreePath` are only set when the worktree is actually preserved (dirty), not on every failure.

## 0.1.7

### Patch Changes

- 5eef716: Inject `{{SOURCE_BRANCH}}` and `{{TARGET_BRANCH}}` as built-in prompt arguments. These are available in any prompt without passing them via `promptArgs`. Passing either key in `promptArgs` now fails with an error.
- 78ef034: Fix sandbox crash on macOS by setting `HOME=/home/agent` in the container environment. Previously, Docker's `--user` flag caused `HOME` to default to `/`, making `git config --global` fail with a permission error on `//.gitconfig`.
- fed9a66: Replace wall-clock timeout with idle-based timeout that resets on each agent output event.
  - Rename `timeoutSeconds` → `idleTimeoutSeconds` in `RunOptions` and `OrchestrateOptions`
  - Change default from 1200s (20 min) to 300s (5 min)
  - Timeout now tracks from last received message (text or tool call), not run start
  - Error message updated to: "Agent idle for N seconds — no output received. Consider increasing the idle timeout with --idle-timeout."

- b16e0e0: Support multiple completion signals via `completionSignal: string | string[]`. The result field `wasCompletionSignalDetected: boolean` is replaced by `completionSignal?: string` — the matched signal string, or `undefined` if none fired.
- 0f48ef8: Preserve worktree on failure (timeout, agent error, SIGINT, SIGTERM)

  When a run session ends in failure, the sandbox (Docker container) is removed but the
  worktree is now preserved on the host. A message is printed with the worktree path and
  manual cleanup instructions. On successful completion, both the sandbox and worktree
  are removed as before.

  `TimeoutError` and `AgentError` now carry an optional `preservedWorktreePath` field
  so programmatic callers can inspect or build on the preserved worktree.

## 0.1.6

### Patch Changes

- 1cd8bdb: Remove single-branch shortcut in parallel-planner template; always use the merge agent

## 0.1.5

### Patch Changes

- 1cd8bdb: Close GitHub issue when single-branch merge is performed directly in parallel-planner template

## 0.1.4

### Patch Changes

- 8e08f7e: Document custom completion signal in the Early termination README section
- 6f9d3be: Fix CLI option tables to show correct default `--image-name` as `sandcastle:<repo-dir-name>` instead of `sandcastle:local`
- 4c94c5f: Fix README incorrectly describing `.sandcastle/prompt.md` as a default for `promptFile`. Neither `prompt` nor `promptFile` has a default — omitting both causes an error. The `.sandcastle/prompt.md` path is a convention scaffolded by `sandcastle init`, not an automatic fallback.
- 0d93587: Include run name in log filename to prevent overwrites in multi-agent workflows. When `name` is passed to `run()`, it is appended to the log filename (e.g. `main-implementer.log` instead of `main.log`).
- 26683b5: Lead the API section with a simple run() example before the full options reference.
- 3e32b7b: Remove `sandcastle interactive` CLI command documentation from README
- 762642e: Remove stale `patches/` entry from scaffolded `.sandcastle/.gitignore`. Nothing in Sandcastle creates a `.sandcastle/patches/` directory — the worktree-based architecture eliminated patch-based sync.

## 0.1.3

### Patch Changes

- 8b43a04: Remove pnpm/corepack from default sandbox Dockerfile template. The base Node.js image already includes npm, so the `corepack enable` step is unnecessary overhead. All init templates now use `npm install` and `npm run` instead of pnpm equivalents.
- 925506d: Replace pnpm with npm in README documentation
- 74b3f3b: Replace pnpm with npm in scaffold templates. All generated prompt files and main.ts hooks now use `npm install` and `npm run` instead of pnpm, consistent with the project's migration to npm.

## 0.1.2

### Patch Changes

- 3ece5cb: Removed unused `mkdir -p /home/agent/repos` from Dockerfile template. The workspace is bind-mounted at `/home/agent/workspace`, so this directory was never used.

## 0.1.1

### Patch Changes

- 0f61f59: Filter issue lists by `Sandcastle` label in all templates. `sandcastle init` now offers to create the label on the repo.

## 0.1.0

### Minor Changes

- a5cff39: Hide `agent` option from public API. The `agent` field has been removed from `RunOptions` and the `--agent` CLI flag has been removed from `init` and `interactive` commands. Agent selection is now hardcoded to `claude-code` internally. The agent provider system remains as an internal implementation detail.

### Patch Changes

- f11fd90: Add JSDoc comments to all public-facing type properties: `RunResult`, `LoggingOption`, and `PromptArgs`.
- 1fc5e32: Add kitchen-sink `run()` example to README with inline JSDoc-style comments on every option. Also updates the `RunOptions` table to remove the hidden `agent` field, fix the `maxIterations` default (1, not 5), fix the `timeoutSeconds` default (1200, not 900), update the `imageName` default, and add the missing `name` and `copyToSandbox` fields. Removes the removed `--agent` flag from the `sandcastle init` and `sandcastle interactive` CLI tables.
- b713226: Migrate from npm to pnpm across the project (issue #168).
  - Added `packageManager: "pnpm@10.7.0"` to `package.json`
  - Generated `pnpm-lock.yaml` (replaces `package-lock.json`)
  - Updated CI and release workflows to use `pnpm/action-setup` and `pnpm` commands
  - Updated all template `main.ts` files to use `pnpm install` in `onSandboxReady` hooks
  - Updated all prompt files (`.sandcastle/` and `src/templates/`) to reference `pnpm run typecheck` and `pnpm run test`
  - Updated `README.md` development and hooks examples to use pnpm
  - Updated `InitService.ts` next-steps text to reference pnpm

- cd429c0: Replace --ff-only with regular merge for worktree merge-back (issue #162)

  When the agent finishes, Sandcastle now uses `git merge` instead of `git merge --ff-only` to integrate the temp branch back into the host branch. This allows users to make commits on the host branch while Sandcastle is running without causing merge-back failures. Fast-forward still happens naturally when the host branch hasn't moved; only the requirement that it _must_ fast-forward is removed.

- db3adec: Show run name instead of provider name in log-to-file summary (issue #160).

  When `name` is passed to `run()`, it now appears as the `Agent` value in the run summary instead of the internal provider name (`claude-code`). When no name is provided the provider name is used as before.

- df9fe6c: Surface tool calls in run logs (issues #163, #164, #165, #166).

  `parseStreamJsonLine` now returns an array of events per line. Assistant messages may produce `text` and/or `tool_call` items. Tool calls are filtered to an allowlist (Bash, WebSearch, WebFetch, Agent) with per-tool arg extraction, and displayed interleaved with agent text output. The Display service gains a `toolCall(name, formattedArgs)` method rendered as a dim-styled step in terminal mode and a plain log line in log-to-file mode.

- dbe5989: Update 'How it works' section in README to describe the worktree-based architecture, replacing the outdated sync-in/sync-out description. Also fix related references to sync-in/sync-out throughout the README.
