# Sandcastle

A TypeScript toolkit that orchestrates AI coding agents inside isolated sandbox environments, managing the lifecycle of sandboxes, branches, prompts, and iterations.

## Language

### Core concepts

**Sandcastle**:
The TypeScript CLI tool that orchestrates an **agent** inside a **sandbox**.
_Avoid_: "the tool", "the CLI", "RALPH"

**Sandbox**:
The isolation boundary around the **agent** -- a container, VM, or similar environment that constrains the **agent**'s access.
_Avoid_: "container" (too specific), "Docker sandbox" (ambiguous with Claude's built-in feature), "workspace"

**Host**:
The developer's machine where Sandcastle runs and the real git repo lives.
_Avoid_: "local" (ambiguous -- the sandbox also has a local filesystem)

**Agent**:
The AI coding tool invoked inside the **sandbox** (e.g. Claude Code, Codex).
_Avoid_: "RALPH", "the bot", "Claude" (too specific -- agent is swappable)

### Sandboxes

**Sandbox provider**:
A pluggable implementation that creates and manages a **sandbox**, injected into `run()` via the `sandbox` option.
_Avoid_: "backend", "runtime", "sandbox factory"

**Bind-mount sandbox provider**:
A **sandbox provider** where the **host** filesystem is mounted directly into the environment.
_Avoid_: "local provider", "mount provider"

**Isolated sandbox provider**:
A **sandbox provider** where the environment has its own filesystem, requiring sync to move code in and commits out.
_Avoid_: "remote provider", "sync provider"

**No-sandbox provider**:
A **sandbox provider** where no container is created -- the **agent** runs directly on the **host**.
_Avoid_: "local provider", "none provider", "host provider"

### Branching

**Branch strategy**:
Configuration on a **sandbox provider** that controls how the agent's changes relate to branches, set at provider construction time.
_Avoid_: "worktree mode" (old name), "branch mode"

**Head (branch strategy)**:
A **branch strategy** where the **agent** works directly in the **host** working directory -- no **worktree**, no branch indirection.
_Avoid_: `"none"` (old name), "direct"

**Merge-to-head (branch strategy)**:
A **branch strategy** where Sandcastle creates a temporary branch, the agent works on it, and changes are merged back to HEAD.
_Avoid_: `"temp-branch"` (old name), "auto-branch"

**Branch (branch strategy)**:
A **branch strategy** where commits land on an explicitly named branch provided by the caller.
_Avoid_: "named-branch"

**Worktree**:
A git worktree created in `.sandcastle/worktrees/` on the **host**, used by the **merge-to-head** and **branch** strategies. For **bind-mount sandbox providers**, the **worktree** is mounted into the **sandbox**. For **isolated sandbox providers**, the **worktree** is the sync source/destination -- commits from the **sandbox** are pulled back into the **worktree**. Created explicitly via `createWorktree()` or implicitly by `run()`/`interactive()` when using a non-**head** **branch strategy**.
_Avoid_: "workspace", "branch copy", "clone"

**Source branch**:
The branch the **agent** works on -- determined by the **branch strategy**.
_Avoid_: "working branch", "agent branch"

**Target branch**:
The **host**'s active branch at `run()` time -- the branch Sandcastle merges into when using **merge-to-head**.
_Avoid_: "base branch", "destination branch", "merge target"

### Agents

**Agent provider**:
A pluggable implementation that builds commands and parses output for a specific **agent**, injected into `run()` via the `agent` option.
_Avoid_: "agent adapter", "agent driver"

### Execution

**Agent invoker**:
The Effect service (`Context.Tag`) that wraps the raw call handing a fully-resolved **prompt** to the **agent provider** for one **iteration**. The seam used to substitute a recording or scripted fake in tests without running a real **agent**.
_Avoid_: "agent runner", "agent caller"

**Iteration**:
A single invocation of the **agent** inside the **sandbox**, producing at most one commit against one **task**.
_Avoid_: "run" (ambiguous with the JS `run()` function), "cycle", "loop"

**Task**:
A work item from the **backlog manager** that the **agent** selects and works on during an **iteration**.
_Avoid_: "job", "work item", "ticket"

**Completion signal**:
The `<promise>COMPLETE</promise>` marker in the **agent**'s output indicating all actionable tasks are finished. A pure termination signal -- carries no payload. Distinct from **structured output**.
_Avoid_: "done flag", "exit signal", conflating with **structured output**

**Structured output**:
A schema-validated JSON payload emitted by the **agent** inside a caller-specified XML tag and returned to the caller of `run()`. Configured via `output: Output.object({ tag, schema })`. Orthogonal to the **completion signal** -- a run can use either, both, or neither. The caller owns the prompt-side instruction telling the agent to emit the tag; Sandcastle does not inject it, and `run()` errors early if the resolved prompt does not contain the configured tag.
_Avoid_: "output payload", "result", "JSON output"

**Output schema**:
The Standard Schema validator (e.g. Zod, Valibot) the caller passes alongside the XML tag name to parse and validate **structured output**.
_Avoid_: "validator", "result schema"

### Prompts

**Prompt**:
The instruction text passed to the **agent** at the start of each **iteration**.
_Avoid_: "system prompt" (too specific), "instructions" (too vague), "message"

**Inline prompt**:
A **prompt** provided as a string via the `prompt` option. Passed through to the **agent** as-is — no **prompt argument substitution**, no **prompt expansion**.
_Avoid_: "dynamic prompt", "string prompt"

**Prompt template**:
A **prompt** sourced from a file via the `promptFile` option. May contain `{{KEY}}` placeholders and `` !`command` `` **shell expressions**, which are resolved via **prompt argument substitution** and **prompt expansion** before being passed to the **agent**.
_Avoid_: "prompt file" (refers to the option, not the concept), "template prompt"

**Prompt argument**:
A runtime **template argument** passed via `promptArgs` in `run()` that substitutes a `{{KEY}}` placeholder in a **prompt**.
_Avoid_: "prompt variable" (ambiguous with env vars), "template variable", "parameter"

**Prompt argument substitution**:
**Template argument substitution** applied to a **prompt** at runtime, using the **prompt arguments** map.
_Avoid_: "template expansion", "interpolation", "variable substitution"

**Prompt expansion**:
The preprocessing step that evaluates **shell expressions** in a **prompt**, replacing them with their stdout.
_Avoid_: "prompt preprocessing" (too generic), "command expansion"

**Shell expression**:
A `` !`command` `` marker in a **prompt** that evaluates a shell command inside the **sandbox**.
_Avoid_: "command" (overloaded), "inline command", "prompt command"

**Built-in prompt argument**:
A **prompt argument** that Sandcastle injects automatically -- not provided by the user via `promptArgs`.
_Avoid_: "system variable", "auto argument", "default prompt argument"

### Hooks

**Host hook**:
A lifecycle hook that runs on the **host** machine, not inside the **sandbox**. Host hooks are `{ command: string }` — no `sudo`, no `cwd`.
_Avoid_: "local hook"

**Sandbox hook**:
A lifecycle hook that runs inside the **sandbox** container. Sandbox hooks are `{ command: string; sudo?: boolean }`.
_Avoid_: "container hook", "remote hook"

### Init

**Init**:
The CLI command that scaffolds the **config directory** in a **host** repo.
_Avoid_: "create", "bootstrap", "new"

**Config directory**:
The `.sandcastle/` directory in a **host** repo containing sandbox configuration.
_Avoid_: ".sandcastle folder", "sandcastle dir"

**Backlog manager**:
A pluggable source of **tasks** for the **agent**, selected during **init** (e.g. GitHub Issues, Beads).
_Avoid_: "task source", "issue tracker"

**Template argument**:
A named `{{KEY}}` placeholder in a scaffold template (Dockerfile, prompt `.md` file) that **init** replaces with a value derived from the user's choices.
_Avoid_: "placeholder", "variable"

**Template argument substitution**:
The preprocessing step during **init** that replaces **template arguments** with their resolved values.
_Avoid_: "template expansion", "interpolation"

### Infrastructure

**Build-image**:
A provider-namespaced CLI command that rebuilds the image (e.g. `sandcastle docker build-image`).
_Avoid_: "setup-sandbox" (old name)

**Remove-image**:
A provider-namespaced CLI command that removes the image (e.g. `sandcastle docker remove-image`).
_Avoid_: "cleanup-sandbox" (old name)

**Agent session**:
The **agent**'s persisted conversation record. Storage shape and location are owned by the **agent provider** -- Claude Code writes a `<session-id>.jsonl` under `~/.claude/projects/<encoded-cwd>/`; other agents use their own conventions (e.g. `~/.codex/sessions/`, `~/.pi/agent/sessions/`, OpenCode's SQLite store). Resumable when the **agent provider** declares session-storage support; the resume mechanism is the agent's native flag (e.g. `claude --resume`, `codex exec resume`, `pi --session`).
_Avoid_: "chat history", "transcript"

### Display

**Log-to-file mode**:
The display mode where Sandcastle writes iteration progress and agent output to a **run log**.
_Avoid_: "file mode", "file logging", "quiet mode"

**Run log**:
A log file written to `.sandcastle/logs/` during a run session.
_Avoid_: "log file" (too generic), "output file"

**Terminal mode**:
The display mode where Sandcastle renders an interactive UI in the terminal with spinners and styled status messages.
_Avoid_: "stdout mode", "interactive mode", "CLI mode" (ambiguous with the CLI itself)

**Agent stream event**:
A single item in the **agent**'s output stream -- either a `text` chunk or a `toolCall` -- surfaced to the caller of `run()` so the stream can be forwarded to an external observability system. Available only in **log-to-file mode** via the `onAgentStreamEvent` callback on the `logging` option. Each event carries its `iteration` number and a `timestamp`.
_Avoid_: "log event" (the log file contains more than just agent output), "display entry" (internal UI type)

## Relationships

- **Sandcastle** orchestrates an **agent** inside a **sandbox**
- A **sandbox** is created by a **sandbox provider**, which is injected into `run()` via the `sandbox` option -- this is required, there is no default
- A **sandbox provider** is a **bind-mount sandbox provider**, **isolated sandbox provider**, or **no-sandbox provider**
- Each **sandbox provider** has a **branch strategy** configured at construction time
- A **bind-mount sandbox provider** supports all three **branch strategies**: **head** (default), **merge-to-head**, and **branch**
- An **isolated sandbox provider** supports **merge-to-head** (default) and **branch** only -- **head** is not valid because it cannot write directly to the **host** filesystem
- An **isolated sandbox provider** handles syncing code in and extracting commits out -- optionally using **bundle/patch sync**. **Isolated sandbox providers are defined in the type system but not yet implemented**
- A **no-sandbox provider** supports all three **branch strategies** (default: **head**). It is only accepted by `interactive()`, not `run()` -- enforced at the type level. The **agent provider** does not receive `dangerouslySkipPermissions: true`
- `interactive()` accepts all three **sandbox provider** types; `run()` accepts only **bind-mount** and **isolated**
- `createSandbox()` does not accept a **no-sandbox provider**
- **Sandbox providers** are imported from subpaths (e.g. `sandcastle/sandboxes/docker`) -- the main `sandcastle` entry point does not re-export any provider
- **Host hooks** run on the **host**; **sandbox hooks** run inside the **sandbox**. Hooks are grouped under `host` and `sandbox` in the `hooks` option
- Lifecycle ordering: `copyToWorktree` -> `host.onWorktreeReady` (sequential) -> sandbox created -> `host.onSandboxReady` + `sandbox.onSandboxReady` (parallel)
- Each **iteration** may produce one or more commits; iterations repeat until the **completion signal** fires or the max count is reached
- **Init** creates the **config directory** on the **host**, prompting the user to select an **agent** and **backlog manager**
- **Init** performs **template argument substitution** on Dockerfiles and scaffold `.md` files, replacing **template arguments** with values derived from the user's choices
- Each **backlog manager** declares a Dockerfile snippet (installed via **template argument substitution**) and command placeholders for **prompt** templates
- The **agent**'s Dockerfile template contains **template arguments** (e.g. `{{BACKLOG_MANAGER_TOOLS}}`) that **init** fills in based on the selected **backlog manager**
- **Build-image** and **remove-image** are namespaced under their provider in the CLI (e.g. `sandcastle docker build-image`)
- The **agent provider** is selected via the `agent` field in config or `--agent` CLI flag
- At launch, Sandcastle resolves env vars from **config directory** `.env` and `process.env`, then passes the full env map into the **sandbox**
- **Inline prompts** bypass **prompt argument substitution** and **prompt expansion** entirely -- they are passed to the **agent** as-is. `promptArgs` cannot be combined with an **inline prompt**; doing so raises an error
- **Prompt argument substitution** and **prompt expansion** only apply to **prompt templates** (prompts sourced via `promptFile`)
- **Prompt argument substitution** runs once after prompt resolution, replacing `{{KEY}}` placeholders with values from **prompt arguments** -- this happens on the **host**, before the **sandbox** exists
- **Prompt expansion** runs before each **iteration**, evaluating all **shell expressions** inside the **sandbox**
- **Prompt argument substitution** runs before **prompt expansion**, so **prompt arguments** can inject values into **shell expressions**
- A `{{KEY}}` placeholder in a **prompt template** with no matching **prompt argument** is an error in `run()` (AFK mode); in `interactive()`, Sandcastle prompts the user to fill in missing values
- Unused **prompt arguments** produce a warning
- A **prompt** may contain zero or more **prompt arguments** and/or **shell expressions**; each substitution step is skipped if there are no matches
- Sandcastle injects **built-in prompt arguments** `{{SOURCE_BRANCH}}` and `{{TARGET_BRANCH}}` automatically
- If a user passes `SOURCE_BRANCH` or `TARGET_BRANCH` in `promptArgs`, **prompt argument substitution** fails with an error -- **built-in prompt arguments** cannot be overridden
- **Target branch** defaults to the **host**'s current branch at `run()` time (via `git rev-parse --abbrev-ref HEAD`)
- **Source branch** is either the explicitly provided `branch` option or a Sandcastle-generated temp branch
- **Log-to-file mode** is the default for programmatic use via `run()`; **terminal mode** is used when passing `logging: { type: 'stdout' }` to `run()`
- In **log-to-file mode**, Sandcastle writes a **run log** to `.sandcastle/logs/` and prints a `tail -f` command to the console
- In **terminal mode**, Sandcastle renders spinners, styled status messages, and summaries directly in the terminal
- In **log-to-file mode**, callers may pass an `onAgentStreamEvent` callback on the `logging` option to receive each **agent stream event** alongside the file log -- intended for forwarding the **agent**'s output to an external observability system. The callback is sync, fire-and-forget, and errors thrown by the callback are swallowed so a broken forwarder cannot kill the run

## Example dialogue

### Sandbox providers & branch strategies

> **Dev:** "What if I want to use Podman instead of Docker?"

> **Domain expert:** "Import a different **sandbox provider**. Instead of `import { docker } from 'sandcastle/sandboxes/docker'`, use `import { podman } from 'sandcastle/sandboxes/podman'`. Both are **bind-mount sandbox providers** -- the **branch strategy** controls how changes land. By default it's **head**, so the agent writes directly to your working directory."

> **Dev:** "What if I want safety -- a temp branch that merges back?"

> **Domain expert:** "Pass `branchStrategy: { type: 'merge-to-head' }` when constructing the provider. Sandcastle creates a **worktree**, the agent works on a temp branch, and it gets merged back to HEAD when done."

> **Dev:** "What about a cloud VM that can't bind-mount my local filesystem?"

> **Domain expert:** "That would be an **isolated sandbox provider**. It defaults to **merge-to-head** -- syncs code in, agent works, changes get merged back. You can also use `{ type: 'branch', branch: 'foo' }` to sync back to a named branch. But you can't use **head** -- there's no host directory to write to directly."

> **Dev:** "Can I write my own provider?"

> **Domain expert:** "Yes. Implement a function that returns a `SandboxProvider`. If your environment can mount a host directory, use the bind-mount factory -- Sandcastle handles worktrees and commit extraction for you. If not, use the isolated factory and implement `copyIn`, `copyFileOut`, and `extractCommits`. The **branch strategy** is configured on the provider at construction time."

### No-sandbox provider

> **Dev:** "I want to use `interactive()` without Docker -- I'm sitting right here, I can approve permissions myself."

> **Domain expert:** "Use the **no-sandbox provider**: `noSandbox()`. The **agent** runs directly on the **host** with no container. Sandcastle won't pass `--dangerously-skip-permissions` to the **agent provider**, so Claude Code's normal permission prompts stay active."

> **Dev:** "Can I still use a worktree with `noSandbox()`?"

> **Domain expert:** "Yes. All three **branch strategies** work. If you want the agent to work on a temp branch and merge back, pass `branchStrategy: { type: 'merge-to-head' }`. The worktree lifecycle is the same -- it's just not mounted into a container."

> **Dev:** "What about using `noSandbox()` with `run()` for an AFK job?"

> **Domain expert:** "That's not allowed -- `run()` doesn't accept a **no-sandbox provider**. This is enforced at the type level. AFK means unsupervised, so you need a real **sandbox** for isolation."

### Prompt system

> **Dev:** "I want to reuse the same **prompt** file for multiple issues in parallel. How do I pass the issue number in?"

> **Domain expert:** "Use **prompt arguments**. Put `{{ISSUE_NUMBER}}` in the **prompt** file, then pass `promptArgs: { ISSUE_NUMBER: 42 }` to `run()`. **Prompt argument substitution** replaces it before anything else runs."

> **Dev:** "What if I also have a **shell expression** that uses the issue number -- like `` !`gh issue view {{ISSUE_NUMBER}}` ``?"

> **Domain expert:** "That works. **Prompt argument substitution** runs first on the **host**, so `{{ISSUE_NUMBER}}` becomes `42` everywhere -- including inside **shell expressions**. Then **prompt expansion** evaluates the **shell expression** inside the **sandbox**."

> **Dev:** "What happens if I typo the key -- like `{{ISSUE_NUBMER}}`?"

> **Domain expert:** "**Prompt argument substitution** fails with an error. Every `{{KEY}}` in the **prompt** must have a matching **prompt argument**. The reverse is just a warning -- unused **prompt arguments** don't block execution."

> **Dev:** "My prompt has `{{ISSUE_NUMBER}}` but I forgot to pass it in `promptArgs`. What happens in interactive mode?"

> **Domain expert:** "Sandcastle scans the **prompt**, finds the missing `{{ISSUE_NUMBER}}`, and prompts you at the terminal to type it in. In `run()` it would just error -- there's nobody to ask."

### Agent providers & environment

> **Dev:** "What if I want to add support for OpenCode instead of Claude Code?"

> **Domain expert:** "Create a new **agent provider**. It declares which env vars it needs -- maybe `OPEN_CODE_API_KEY` instead of `ANTHROPIC_API_KEY`. And it provides its own Dockerfile template that installs the right binary."

> **Dev:** "How does Sandcastle know which **agent provider** to use?"

> **Domain expert:** "The `agent` option passed to `run()`, or the `--agent` CLI flag. Sandcastle loads env vars and passes them straight through to the **sandbox** -- the **agent** handles missing credentials on its own."

### Built-in prompt arguments

> **Dev:** "My reviewer agent diffs against `main`, but I'm working from a feature branch. The diff is huge."

> **Domain expert:** "Use the **built-in prompt argument** `{{TARGET_BRANCH}}` in your **prompt**. It resolves to the **host**'s active branch at `run()` time -- so if you kick off Sandcastle from `feature/auth`, the reviewer diffs against `feature/auth`, not `main`."

> **Dev:** "Can I override `{{TARGET_BRANCH}}` in `promptArgs`?"

> **Domain expert:** "No -- **built-in prompt arguments** can't be overridden. If you pass `TARGET_BRANCH` in `promptArgs`, **prompt argument substitution** fails with an error. Use a different key name if you need a custom value."

## Flagged ambiguities

- **"Worktree mode"** -- The old name for **branch strategy**. Use **branch strategy** -- it describes where changes land, not the mechanism.
- **"Provider"** -- Overloaded: both **agent provider** and **sandbox provider** exist. Always qualify -- never say just "provider" in isolation.
- **"Docker sandbox"** -- In this project, **sandbox** is our isolation concept, not Claude Code's built-in `docker sandbox` CLI feature.
- **"Container"** vs **"Sandbox"** -- "Container" is a Docker/Podman primitive; **sandbox** is our abstraction. Use **sandbox** for the concept, "container" only for provider implementation details.
- **"Local"** vs **"Host"** -- Use **host** for the developer's machine. "Local" is ambiguous (the **worktree** is also on a local filesystem).
- **"Run"** -- Can mean the JS `run()` function or a single **iteration**. Use **iteration** for one agent invocation; "run session" for a call to `run()`.
- **"Token"** vs **"Env var"** -- Sandcastle handles all environment variables generically. Use "env var" for the general concept; "token" only for auth credential values.
- **"Command"** -- Overloaded: hook commands, shell commands, CLI commands, **shell expressions**. Use **shell expression** for `` !`...` `` syntax; "hook" for lifecycle hooks; "CLI command" for `sandcastle init`, etc.
- **"Variable"** vs **"Argument"** -- **Prompt arguments** are host-side values substituted into `{{KEY}}` placeholders. Env vars are passed into the **sandbox** environment. Don't call prompt arguments "variables".
- **"File mode"** vs **"Log-to-file mode"** -- Use **log-to-file mode**. "File mode" is ambiguous. Similarly, avoid "stdout mode" for **terminal mode**.
- **"Base branch"** vs **"Target branch"** -- Use **target branch**. "Base branch" is ambiguous in Sandcastle's context.
- **"Built-in"** vs **"Default"** prompt arguments -- "Default" implies overridable. **Built-in prompt arguments** cannot be overridden. Use "built-in".
- **"No sandbox"** vs **"local"** vs **"none"** -- The provider type is `NoSandboxProvider`, the factory is `noSandbox()`, the tag is `"none"`. Say **no-sandbox provider** in prose.
- **"Workspace"** -- Retired term. Use **worktree** for the git worktree on the **host**, and **sandbox** for the isolation boundary. Don't say "workspace" in this project.
- **"Interactive mode"** -- Could mean `interactive()` (Sandcastle's function) or Claude Code's TUI. In this project, it means Sandcastle's `interactive()`. Don't confuse with **terminal mode**.
