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
A work item from the **issue tracker** that the **agent** selects and works on during an **iteration**.
_Avoid_: "job", "work item", "ticket"

**Completion signal**:
The `<promise>COMPLETE</promise>` marker in the **agent**'s output indicating all actionable tasks are finished. A pure termination signal -- carries no payload. Distinct from **structured output**.
_Avoid_: "done flag", "exit signal", conflating with **structured output**

**Hanging process**:
An **agent** invocation that has emitted its **completion signal** but whose underlying process has not exited (typically because a spawned child -- a `gh`/git subprocess or long-lived MCP server -- inherited the exec's stdout pipe and is keeping it open). The signal is visible in the buffered stream; only EOF is missing. Resolved by the **completion timeout** rather than waiting out the full **idle timeout**. Distinct from a genuinely stuck **agent**, which has produced no output at all.
_Avoid_: "stuck agent" (implies stuck _mid-work_, not done-but-not-exited), "zombie process", "lingering process", "hung sandbox"

**Completion timeout**:
A silence-based grace window that takes over from the **idle timeout** once a **completion signal** is detected in the **agent**'s output. Reset by every subsequent output line so trailing data (token-usage events, terminal `result` events, **structured output** tags emitted after the signal) is still captured. On expiry the run resolves **successfully** with a warning that the process is hanging -- in contrast to **idle timeout** expiry, which fails the run. Configured via `completionTimeoutSeconds`; default 60 seconds. Independent of `idleTimeoutSeconds` -- they cover different phases.
_Avoid_: "grace period" (too generic), "post-completion timeout", "completion grace window", "drain timeout"

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

**Issue tracker**:
A pluggable source of **tasks** for the **agent**, selected during **init** (e.g. GitHub Issues, Beads). Used loosely -- Beads is a dependency-aware task tracker rather than a literal issue tracker, but "issue tracker" is the umbrella term.
_Avoid_: "backlog manager" (retired name), "task source"

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

**Session resume**:
Continuing an **agent session** by appending new turns to the same session record -- the session ID is unchanged and the prior record is mutated in place. Exposed as `RunResult.resume()`.
_Avoid_: "continue", "follow-up"

**Session fork**:
Branching an **agent session** into a new record with a new session ID, leaving the parent record byte-for-byte unchanged. Uses the **agent**'s native fork flag (`claude --fork-session`, `codex exec fork`). Exposed as `RunResult.fork()`. Isolates the session only -- not the **source branch** or **sandbox**.
_Avoid_: "branch" (overloaded with git branches), "copy session"

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
A single provider-observable item in the **agent**'s output stream -- currently `text`, `toolCall`, `result`, or `sessionId` -- surfaced to the caller of `run()` so the stream can be forwarded to an external observability system. Available only in **log-to-file mode** via the `onAgentStreamEvent` callback on the `logging` option. Each event carries its `iteration` number and a `timestamp`.
_Avoid_: "log event" (the log file contains more than just agent output), "display entry" (internal UI type)
