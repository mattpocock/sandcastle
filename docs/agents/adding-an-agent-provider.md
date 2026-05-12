# Adding an agent provider

This document is for contributors adding support for a new **agent** (e.g. Claude Code, Codex, gemini-cli) as a built-in **agent provider**. It covers:

1. [Evaluating a new agent](#evaluating-a-new-agent) — the questionnaire used to decide whether an agent's CLI can be supported.
2. [The `AgentProvider` interface](#the-agentprovider-interface) — what you implement.
3. [Scaffold integration](#scaffold-integration) — what `sandcastle init` needs to offer the agent.
4. [Implementation checklist](#implementation-checklist) — every file to touch.

For terminology (**agent**, **agent provider**, **sandbox**, etc.), see [`CONTEXT.md`](../../CONTEXT.md).

## Evaluating a new agent

Before implementing, confirm the agent's CLI satisfies the must-haves below. If a must-have is missing, the agent likely cannot be supported until its CLI changes.

### Must-have CLI capabilities

- **Non-interactive run mode.** A flag (often `--print`, `exec`, `run`) that takes a prompt, runs the agent to completion, and exits. Without this, Sandcastle cannot drive the agent unattended.
- **Prompt input via argv or stdin.** stdin is strongly preferred — Linux caps `argv` at ~128 KB, which large prompts blow past.
- **Auto-approval / bypass-permissions flag.** The agent runs inside a **sandbox**, so any "are you sure?" prompts will hang it. Examples: Claude Code's `--dangerously-skip-permissions`, Codex's `--dangerously-bypass-approvals-and-sandbox`.
- **Model selection.** A flag that picks the model (e.g. `--model`, `-m`).
- **Env-based authentication.** Auth via environment variables (API key) — no interactive login required at first run.
- **Exit codes reflect success/failure.** Non-zero on error so the orchestrator can detect failures.

### Must-have output capabilities

- **Streaming output.** The CLI must stream output to stdout as the agent runs; we surface it live in [`Display`](../../src/Display.ts).
- **Structured (JSON) stream events.** Required — line-delimited JSON (one event per line). This is what `parseStreamLine` in [`AgentProvider.ts`](../../src/AgentProvider.ts) consumes; without it, tool calls and partial text cannot render in the UI.

For a JSON stream, we want to extract:

- **Assistant text** — the agent's natural-language output, ideally as deltas.
- **Tool calls** — name + a single display arg (we currently show `Bash`, `WebSearch`, `WebFetch`, `Agent`; see `TOOL_ARG_FIELDS`).
- **Final result** — the agent's last message, used for orchestration.
- **Errors** — note whether the CLI emits errors on stdout vs. stderr. Codex and Pi emit auth/rate-limit errors as JSON events on stdout; we capture those as `result` events so they surface to the user.
- **Session ID.** A stable per-run identifier emitted in the stream output and accepted back by a resume CLI flag. Required — see [Resume support](#resume-support-required) below.

### Must-have resume capabilities

Resume support is a hard requirement for new **agent providers** ([ADR 0012](../adr/0012-agent-provider-owned-session-storage.md)). The agent's CLI must satisfy:

- **Resume-by-session-ID flag.** A flag that takes a previously emitted session ID and continues that session (e.g. `claude --resume <id>`, `codex exec resume <id>`, `pi --session <id>`, `opencode run --session <id>`).
- **Session-ID round-trip stability.** The session ID emitted in the stream during a fresh run is the same string the resume flag accepts back. If the CLI mints a new ID per invocation but only persists the file/row, resume cannot work — verify the round-trip empirically before starting implementation.
- **Persisted session storage.** The agent writes its conversation record somewhere addressable by session ID — a JSONL file, a SQLite row, etc. — so Sandcastle can transfer it between **host** and **sandbox**.

If any of these is missing, the agent likely cannot be supported until its CLI changes.

### Optional capabilities

These unlock extra Sandcastle features but are not required:

- **Per-iteration token usage.** Tokens reported in the session log (input, output, cache create, cache read). Today only Claude Code; powers the usage display.
- **Interactive mode.** A separate invocation form for human use (`interactive()`). If the agent has a TUI, expose it via `buildInteractiveArgs`.

### Scaffold prerequisites

For `sandcastle init` to offer the agent:

- A reproducible install command (npm package, install script, etc.) that works inside a Debian-based Docker image.
- A documented set of env vars for auth.
- A sensible default model string.

## The `AgentProvider` interface

Defined in [`src/AgentProvider.ts`](../../src/AgentProvider.ts).

```ts
interface AgentProvider {
  name: string;
  env: Record<string, string>;
  captureSessions: boolean;
  sessionStorage: {
    hostStore(cwd: string): SessionStore;
    sandboxStore(cwd: string, handle: BindMountSandboxHandle): SessionStore;
    transfer(from: SessionStore, to: SessionStore, id: string): Promise<void>;
  };
  buildPrintCommand(options: AgentCommandOptions): PrintCommand;
  buildInteractiveArgs?(options: AgentCommandOptions): string[];
  parseStreamLine(line: string): ParsedStreamEvent[];
  parseSessionUsage?(content: string): IterationUsage | undefined;
}
```

Field by field:

- `name` — short identifier (e.g. `"claude-code"`, `"codex"`). Used in logs and config.
- `env` — environment variables injected into the **sandbox** when this agent runs. Auth keys live here. Merged with the env resolver and **sandbox provider** env at launch.
- `captureSessions` — user-facing kill-switch. When `true` (default), Sandcastle records the agent's session log per **iteration** and is able to resume it. Expose this on the provider's `Options` interface so users can opt out.
- `sessionStorage` — provider-owned factories that describe where and how the agent's session record is persisted ([ADR 0012](../adr/0012-agent-provider-owned-session-storage.md)). The provider supplies `hostStore` (reads/writes session content on the **host**), `sandboxStore` (the same, inside the **sandbox** via the bind-mount handle), and `transfer` (copies a session between two stores, applying any format-specific content rewriting — e.g. Claude Code rewrites the `cwd` field in each JSONL entry from source-cwd to target-cwd). For file-backed agents (JSONL, single file per session), the stores wrap a directory + filename convention. For non-file backends (e.g. SQLite), the stores wrap whatever access primitive fits.
- `buildPrintCommand({ prompt, dangerouslySkipPermissions, resumeSession })` — returns the shell command to run the agent non-interactively. Return `{ command, stdin }` when piping the prompt via stdin (preferred for large prompts). When `resumeSession` is set, append the agent's native resume CLI flag.
- `buildInteractiveArgs(options)` — optional. Returns the argv array for `interactive()`. Omit if the agent has no TUI.
- `parseStreamLine(line)` — given one line of stdout, return zero or more `ParsedStreamEvent`s. Event types: `text`, `result`, `tool_call`, `session_id`. Return `[]` for lines you can't or don't need to parse. **Emitting `session_id` is required** — without it, Sandcastle cannot capture the session for resume.
- `parseSessionUsage(content)` — optional. Given the session log content, return token usage for the most recent iteration. Currently only Claude Code implements this.

### `SessionStore`

Defined in [`src/SessionStore.ts`](../../src/SessionStore.ts).

```ts
interface SessionStore {
  readonly cwd: string;
  exists(id: string): Promise<boolean>;
  sessionFilePath(id: string): string | undefined;
  readSession(id: string): Promise<string>;
  writeSession(id: string, content: string): Promise<void>;
}
```

- `exists(id)` — pre-flight check used by `run()` and `createWorktree()` to validate `resumeSession` before launching.
- `sessionFilePath(id)` — the on-disk path of the session, surfaced to callers via `OrchestrateResult.sessionFilePath`. Return `undefined` for non-file-backed stores (e.g. SQLite).
- `readSession(id)` / `writeSession(id, content)` — read/write the session content as an opaque string. For JSONL agents, this is the file contents. For SQLite-backed agents, serialise the relevant row(s) to a string the same store can round-trip back.

## Resume support (required)

Every new **agent provider** must wire resume end-to-end. The four pieces:

1. **`parseStreamLine` emits `session_id` events.** Identify the event in your agent's stream that carries the session ID and emit `{ type: "session_id", sessionId }`. Test this with a representative captured stream line.
2. **`buildPrintCommand` honours `resumeSession`.** When the option is set, append the agent's native resume CLI flag to the command. Verify the flag composes with `--print` / `--json` / `--model` and any other flags you pass.
3. **`captureSessions: true` by default.** Set this in the factory; expose `captureSessions?: boolean` on the provider's `Options` interface for users who want to opt out.
4. **`sessionStorage` sub-object populated.** Supply factories that read/write the agent's session record on **host** and inside the **sandbox**, plus a `transfer` op that copies between them. If the agent's format embeds the working directory (Claude Code's JSONL has a `cwd` field per entry), apply the rewrite inside `transfer`.

Before writing code, **verify session-ID round-trip stability empirically**: run the agent, capture the session ID it emits, then invoke the agent with the resume flag pointing at that ID. If the agent treats the ID as opaque and continues the conversation, you're good. If it mints a new ID and ignores the requested one, or if the ID emitted to the stream is different from the one persisted to disk, the agent's CLI cannot support resume as-is.

### Patterns to follow

- **Shell-escape every interpolated value** in `buildPrintCommand` using the `shellEscape` helper at the top of `AgentProvider.ts`.
- **Prefer stdin for the prompt** to dodge the argv size limit.
- **Be defensive when parsing JSON.** Wrap `JSON.parse` in try/catch and tolerate unknown event types — CLIs add fields over time.
- **Surface errors as `result` events** when the CLI emits them on stdout (see Codex/Pi). The Orchestrator's stderr-empty fallback uses these to show the user something useful.

## Scaffold integration

For the agent to appear in `sandcastle init`, add an entry to `AGENT_REGISTRY` in [`src/InitService.ts`](../../src/InitService.ts):

```ts
{
  name: "gemini",
  label: "Gemini",
  defaultModel: "gemini-2.5-pro",
  factoryImport: "gemini",          // matches the export from index.ts
  dockerfileTemplate: GEMINI_DOCKERFILE,
  envExample: `# Google AI API key
GOOGLE_API_KEY=`,
}
```

And a Dockerfile constant alongside the existing ones. Use `CLAUDE_CODE_DOCKERFILE` as a structural reference — keep the `usermod` block, the `{{BACKLOG_MANAGER_TOOLS}}` placeholder, the `USER agent` line, and the `ENTRYPOINT ["sleep", "infinity"]`. Only the install line should differ.

## Implementation checklist

For a new agent provider `foo`:

- [ ] Verify session-ID round-trip stability empirically (see [Resume support](#resume-support-required)).
- [ ] Factory `foo()` in [`src/AgentProvider.ts`](../../src/AgentProvider.ts), with options interface `FooOptions` (including `captureSessions?: boolean`).
- [ ] Stream-parsing helper `parseFooStreamLine` that emits `session_id` events alongside `text` / `result` / `tool_call`.
- [ ] `sessionStorage` sub-object on the factory's return value, with `hostStore`, `sandboxStore`, and `transfer` factories specific to `foo`'s on-disk (or SQLite, etc.) layout.
- [ ] `buildPrintCommand` honours `resumeSession` by appending `foo`'s native resume CLI flag.
- [ ] Tests in `src/AgentProvider.test.ts` covering `buildPrintCommand` (both fresh and resume forms), `buildInteractiveArgs`, and stream parsing — including session-ID extraction and error events on stdout if applicable.
- [ ] Tests covering `sessionStorage` round-trip: write, read, transfer host↔sandbox, content preserved (and rewritten correctly if `foo`'s format requires it).
- [ ] Public export from [`src/index.ts`](../../src/index.ts): the `foo` factory and the `FooOptions` type.
- [ ] `AGENT_REGISTRY` entry in [`src/InitService.ts`](../../src/InitService.ts).
- [ ] `FOO_DOCKERFILE` constant in `src/InitService.ts`.
- [ ] Changeset in `.changeset/` (patch, since pre-1.0). See [`CLAUDE.md`](../../CLAUDE.md).
- [ ] `README.md` update if the public-facing list of supported agents is mentioned there.
