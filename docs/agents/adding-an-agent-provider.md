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
- **Filesystem-backed session storage.** The agent writes its conversation record to files addressable by session ID (for example JSONL rollout files) so Sandcastle can transfer them between **host** and **sandbox**. Agents whose session state only exists in a local database are not resumable ([ADR 0016](../adr/0016-resume-requires-filesystem-backed-sessions.md)), unless the CLI itself can export one session to a file and import it back, as OpenCode's can ([ADR 0022](../adr/0022-opencode-resume-via-export-import.md)).

If any of these is missing, the agent likely cannot be supported until its CLI changes.

### Optional capabilities

These unlock extra Sandcastle features but are not required:

- **Per-iteration token usage.** Token counts (input, output, cache create, cache read) surfaced either in the session log (parsed via `parseSessionUsage`, e.g. Claude Code) or in a stream event (emitted as a `usage` `ParsedStreamEvent`, e.g. Codex's `turn.completed`). Powers the usage display. Stream-sourced usage works even when session capture is off.
- **Per-call context size.** The input tokens (cache included) of each model call, emitted as one `context_window` `ParsedStreamEvent` per call. The Orchestrator keeps the last one per iteration and prints it as `Context window: NNNk`. Never emit a total summed over a turn or session ([ADR 0023](../adr/0023-context-window-is-the-last-model-call.md)). If the stream has no per-call figure but the session log does, implement `parseSessionContextWindow` instead (e.g. Codex). If neither has one, emit nothing (e.g. Cursor).
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
  sessionStorage?: AgentSessionStorage;
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
- `sessionStorage` — provider-owned object that describes where and how the agent's session record is persisted ([ADR 0012](../adr/0012-agent-provider-owned-session-storage.md)). See [`AgentSessionStorage`](#agentsessionstorage) below. Omit for providers that do not support resume.
- `buildPrintCommand({ prompt, dangerouslySkipPermissions, resumeSession })` — returns the shell command to run the agent non-interactively. Return `{ command, stdin }` when piping the prompt via stdin (preferred for large prompts). When `resumeSession` is set, append the agent's native resume CLI flag.
- `buildInteractiveArgs(options)` — optional. Returns the argv array for `interactive()`. Omit if the agent has no TUI.
- `parseStreamLine(line)` — given one line of stdout, return zero or more `ParsedStreamEvent`s. Event types: `text`, `context_window`, `result`, `tool_call`, `session_id`, `usage`, `error`. Return `[]` for lines you can't or don't need to parse. **Emitting `session_id` is required** — without it, Sandcastle cannot capture the session for resume. Emit `usage` if the stream carries token counts (e.g. Codex's `turn.completed`); it feeds the usage display without needing session capture. Emit `error` when the agent reports a failure in its own stream (an API rejection, a failed turn): the Orchestrator fails the run with its message even if the agent exits 0.
- `parseSessionUsage(content)` — optional. Given the session log content, return token usage for the most recent iteration. Currently only Claude Code implements this.
- `parseSessionContextWindow(content)` — optional. Given the session log content, return the last model call's context window (`{ tokens, limit? }`). Overrides the stream's `context_window` events. Currently only Codex implements this.

### `AgentSessionStorage`

Defined in [`src/AgentProvider.ts`](../../src/AgentProvider.ts).

```ts
interface AgentSessionStorage {
  captureToHost(args: {
    hostCwd: string;
    sandboxCwd: string;
    sessionId: string;
    handle: BindMountSandboxHandle;
  }): Promise<void>;
  resumeIntoSandbox(args: {
    hostCwd: string;
    sandboxCwd: string;
    sessionId: string;
    handle: BindMountSandboxHandle;
  }): Promise<void>;
  readHostSession(cwd: string, sessionId: string): Promise<string | undefined>;
  existsOnHost(cwd: string, sessionId: string): Promise<boolean>;
  hostSessionFilePath(cwd: string, sessionId: string): string | undefined;
  findByIdOnHost(sessionId: string): Promise<HostSessionLookup>;
}
```

- `captureToHost` — transfer a session JSONL from the **sandbox** into the **host** store, applying any format-specific content rewriting (e.g. Claude Code rewrites the `cwd` field in each JSONL entry from sandbox-cwd to host-cwd). The session JSONL transfer helpers `transferClaudeSession` / `transferCodexSession` in [`src/SessionStore.ts`](../../src/SessionStore.ts) are pure string functions you can call from here.
- `resumeIntoSandbox` — the reverse: transfer a session JSONL from the host store into the sandbox before resuming.
- `readHostSession` — read a captured session JSONL from the host. Returns `undefined` when no session with that id exists. Used to parse per-iteration token usage.
- `existsOnHost` — pre-flight check used by `run()` and `createWorktree()` to validate `resumeSession` before launching.
- `hostSessionFilePath` — the on-disk path of the session, surfaced to callers via `OrchestrateResult.sessionFilePath`. Synchronous: file-backed stores that can derive the path from `(cwd, sessionId)` return it directly; otherwise return the path cached by `captureToHost`. Future SQLite-backed stores would return `undefined`.
- `findByIdOnHost` — locate a session on the **host** by its unique id, independent of cwd encoding. Used by the no-sandbox resume precheck, where the agent runs on the **host** and writes the session in place under a cwd-derived directory Sandcastle cannot reliably reconstruct.

## Resume support (required)

Every new **agent provider** must wire resume end-to-end. The four pieces:

1. **`parseStreamLine` emits `session_id` events.** Identify the event in your agent's stream that carries the session ID and emit `{ type: "session_id", sessionId }`. Test this with a representative captured stream line.
2. **`buildPrintCommand` honours `resumeSession`.** When the option is set, append the agent's native resume CLI flag to the command. Verify the flag composes with `--print` / `--json` / `--model` and any other flags you pass.
3. **`captureSessions: true` by default.** Set this in the factory; expose `captureSessions?: boolean` on the provider's `Options` interface for users who want to opt out.
4. **`sessionStorage` sub-object populated.** Implement `captureToHost` (sandbox → host) and `resumeIntoSandbox` (host → sandbox) for the agent's on-disk layout, plus the read/lookup ops described above. If the agent's format embeds the working directory (Claude Code's JSONL has a `cwd` field per entry), apply the rewrite inside `captureToHost` / `resumeIntoSandbox` — `transferClaudeSession` / `transferCodexSession` in `SessionStore.ts` are reusable pure-string helpers.

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

And a Dockerfile constant alongside the existing ones. Use `CLAUDE_CODE_DOCKERFILE` as a structural reference — keep the `usermod` block, the `{{ISSUE_TRACKER_TOOLS}}` placeholder, the `USER agent` line, and the `ENTRYPOINT ["sleep", "infinity"]`. Only the install line should differ.

## Implementation checklist

For a new agent provider `foo`:

- [ ] Verify session-ID round-trip stability empirically (see [Resume support](#resume-support-required)).
- [ ] Factory `foo()` in [`src/AgentProvider.ts`](../../src/AgentProvider.ts), with options interface `FooOptions` (including `captureSessions?: boolean`).
- [ ] Stream-parsing helper `parseFooStreamLine` that emits `session_id` events alongside `text` / `result` / `tool_call`.
- [ ] `sessionStorage` sub-object on the factory's return value, implementing `captureToHost`, `resumeIntoSandbox`, `readHostSession`, `existsOnHost`, `hostSessionFilePath`, and `findByIdOnHost` for `foo`'s on-disk layout.
- [ ] `buildPrintCommand` honours `resumeSession` by appending `foo`'s native resume CLI flag.
- [ ] Tests in `src/AgentProvider.test.ts` covering `buildPrintCommand` (both fresh and resume forms), `buildInteractiveArgs`, and stream parsing — including session-ID extraction and error events on stdout if applicable.
- [ ] Tests covering `sessionStorage` round-trip: capture host↔sandbox, content preserved (and rewritten correctly if `foo`'s format requires it).
- [ ] Public export from [`src/index.ts`](../../src/index.ts): the `foo` factory and the `FooOptions` type.
- [ ] `AGENT_REGISTRY` entry in [`src/InitService.ts`](../../src/InitService.ts).
- [ ] `FOO_DOCKERFILE` constant in `src/InitService.ts`.
- [ ] Changeset in `.changeset/` (patch, since pre-1.0). See [`CLAUDE.md`](../../CLAUDE.md).
- [ ] `README.md` update if the public-facing list of supported agents is mentioned there.
