# CodeBuddy CLI as a Sandcastle Agent Provider

Research question: does Tencent's CodeBuddy CLI (the terminal agent — NOT the IDE plugin) have what Sandcastle needs for an `AgentProvider`, and what would the integration look like?

Method: npm registry metadata, official Tencent Cloud docs, the repo changelog on cnb.cool, and direct read-only inspection of the published tarball `@tencent-ai/codebuddy-code@2.181.0` (downloaded 2026-11-07, grepped — never executed). Bundle quotes below are string literals from `dist/codebuddy-headless.js` of that version.

**Verdict: integration is feasible and low-risk — the CLI is Claude-Code-shaped end to end.** The closest template is our `claudeCode` provider; the stream parser may be near-literal reuse. Open questions at the end are answerable only with a live run.

## 1. Product identity

- Package: `@tencent-ai/codebuddy-code` (v2.181.0 on 2026-11-07; ~1438 versions, published daily). npm names `codebuddy` / `codebuddy-code` are unrelated "Hello, World!" squatters — the scoped name is the real one. Source: `npm view @tencent-ai/codebuddy-code`.
- Binaries: `codebuddy`, `cbc`, `codebuddy-code` → `bin/codebuddy`; plus `cbc-prewarm`, `codebuddy-lowmem`. Requires Node 18+. Source: `package.json` of the tarball.
- Repo (docs + CHANGELOG only, no source): https://cnb.cool/codebuddy/codebuddy-code (MIT, bot-synced). Tarball is 65 MB compressed / 220 MB unpacked — a preinstalled sandbox image (like our Claude-Code Dockerfile) is the right shape; npm-installing it per-run would be heavy.
- Claude-Code compatibility is by design, not coincidence: the shipped `types/codebuddy-code.d.ts` header says the mods (function-hook) API is "as Claude Code declares it… Generated … from the declarations Claude Code 2.1.316 writes … Vendored for interface compatibility with the Claude Code function-hook API." (tarball, types/codebuddy-code.d.ts)

## 2. Print mode and permissions

Official CLI reference: https://intl.cloud.tencent.com/document/product/1316/84467 (fetched 2026-11-07). Headless usage guide: https://intl.cloud.tencent.com/document/product/1316/84566.

- `codebuddy -p "prompt"` runs print mode and exits. Stdin piping is documented (`cat logs.txt | codebuddy -p "analyze logs"`), so large prompts can go over stdin like our Claude provider — no Cursor-style argv limit.
- `--output-format <text|json|stream-json>`; `--input-format <text|stream-json>`; `--include-partial-messages` (requires print + stream-json); `--json-schema <schema>` for structured output validation. Bundle help text: `'Output format (only works with --print): "text" (default), "json" (single result), or "stream-json" (realtime streaming)'`.
- Permissions: `-y / --dangerously-skip-permissions` ("Skip permission prompts") and `--permission-mode <default|acceptEdits|auto|dontAsk|plan|bypassPermissions>` — same value set as Claude Code. Also `--allowedTools`, `--disallowedTools`, `--permission-prompt-tool`.
- The docs warn that in `-p` mode, file/command/network operations need an explicit permission policy or they are blocked — for Sandcastle AFK runs we pass `-y` exactly as we do for Claude.

## 3. stream-json protocol — verified from the bundle

The event schema is Claude Code's, extended. Literal shapes found in `dist/codebuddy-headless.js`:

- Init: `type:"system",subtype:"init",uuid:…,session_id:…,apiKeySource:…,cwd:…` — carries the session id the same way Claude does.
- Assistant: `type:"assistant",uuid,session_id,message:{id,content:[…],model,role:"assistant",stop_reason,…}` with content blocks `text`, `thinking`, and `tool_use {id,name,input}` — our `parseStreamJsonLine` + `parseClaudeAssistantContent` tool allowlist would work as-is.
- User/tool results: `type:"user",…,message:{content:[{type:"tool_result",tool_use_id,…,is_error}]}`.
- Result: `{type:"result",subtype:"success",is_error:!1,result:…}` / `{type:"result",subtype:"error_during_execution",is_error:!0,…}` and a `structured_output` field when `--json-schema` is used (matches our `extractStructuredOutput` flow).
- Usage: the four Claude-shaped fields `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` (aggregation literals in the bundle) — `parseClaudeContextWindow` maps onto this directly.
- CodeBuddy extras beyond Claude's schema: `system` subtypes `usage_update` (per-turn usage reporting, added v2.179.0), `task_progress`/`task_started`/`task_updated`/`task_notification`, `status`, `mcp_status`, `keepalive`, and `stream_event` for partial deltas. Unknown lines are ignored by our parsers, so these are harmless; `usage_update` may later be a cleaner context-window source than the last assistant line.
- Actively maintained: CHANGELOG (tarball + https://cnb.cool/codebuddy/codebuddy-code) shows stream-json work in 2.171–2.179 (interrupt handling, control requests like `reconnect_mcp`, "print 模式每轮 result 为该轮最后一帧" — the per-round result is that round's last frame, same last-write-wins semantics our Orchestrator assumes).

## 4. Model selection

- `--model <model>` takes full names or aliases. Aliases resolve Claude-style: `["haiku","sonnet","opus"]` in the bundle, with `haiku→lite`, `sonnet→default`, `opus→reasoning` variants.
- No `--effort`/`--thinking` CLI flag. Effort exists only as a field in the `--agents` JSON subagent format (`minimal/low/medium/high/xhigh/max`, per the CLI reference). Third-party backends take `reasoning_effort` rather than a `thinking` parameter (community analysis, https://github.com/simplast/workbuddy-api/blob/main/docs/codebuddy-thinking-analysis.md — secondary source, unverified).

## 5. Sessions on disk: resume and fork

- Config/data dir: `USER_DATA_DIR_NAME=".codebuddy"` (tarball) — default `~/.codebuddy`, overridable via `CODEBUDDY_HOME`; `CODEBUDDY_CONFIG_DIR` is also honored (CHANGELOG issue #152783: a nested CLI deleting host sessions via `CODEBUDDY_CONFIG_DIR`).
- Layout mirrors Claude: sessions live under a `projects/` directory whose subdirs are per-cwd encoded (`join(childDataDir,"projects",encoded(cwd))` in the bundle) — the same shape `SessionStore` already navigates for Claude.
- Flags: `-r, --resume [sessionId]`, `-c, --continue`, `--fork-session` ("When resuming, create a new session ID instead of reusing the original (use with --resume or --continue)" — bundle help text), and `--session-id <id>` for a fixed id. `--no-session-persistence` keeps sessions in memory. **`--fork-session` exists in the CLI even though the Tencent docs page does not list it** — fork support (ADR 0018) looks available, unlike cursor/copilot which forced `canFork: false`.
- Session persistence is on by default in headless runs (v2.166.0: SDK/ACP/headless launches "默认保留全部历史").

## 6. Auth and sandbox mounting

- Env vars present in the bundle: `CODEBUDDY_API_KEY`, `CODEBUDDY_AUTH_TOKEN`, `CODEBUDDY_BASE_URL`, `CODEBUDDY_HOST`, `CODEBUDDY_CUSTOM_HEADERS`, `CODEBUDDY_CREDENTIALS_IN_MEMORY`, `CODEBUDDY_API_KEY_HELPER_DISABLED` (and `apiKeyHelper` in the settings docs). An API-key header auth path for headless use therefore exists at the code level; docs only describe browser login ("首次使用需要进行身份认证") — unverified whether `CODEBUDDY_API_KEY` alone authenticates against the default Tencent endpoint without a prior login.
- Third-party / OpenAI-compatible models go through `~/.codebuddy/models.json` (`models` / `availableModels` with `baseUrl`, `apiKey`); if a model entry has no key, env/global credentials are used (v2.166.0 CHANGELOG). Official config docs: https://intl.cloud.tencent.com/zh/document/product/1300/80639 (fetched 2026-11-07).
- For the sandbox: mount or write `~/.codebuddy/models.json` + inject `CODEBUDDY_API_KEY` via the provider `env` — same pattern as our codex `auth.json` handling.

## 7. Interactive mode

The default invocation (no `-p`) is a TUI (`@lydell/node-pty` optional dep; ink/react). Documented interactive flags: `--model`, `--permission-mode`, `-c/--continue`, `-r/--resume`. Which flag seeds a prompt into the TUI without submitting is unverified — needs a live check (Claude takes the prompt as a positional arg; CodeBuddy's `-p` is print-mode only).

## 8. Integration assessment

Mapped onto `AgentProvider` (src/AgentProvider.ts):

| Requirement                       | Verdict                                                                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Print mode + prompt via stdin     | ✅ `-p` + stdin piping (docs)                                                                                         |
| Permission bypass                 | ✅ `-y/--dangerously-skip-permissions`, `--permission-mode`                                                           |
| JSONL stream parse                | ✅ Claude-compatible events; `parseStreamJsonLine` + `parseClaudeContextWindow` reusable; extras pass through ignored |
| Model flag                        | ✅ `--model`; no effort flag (omit, like omitting Claude's `--effort`)                                                |
| Filesystem sessions + resume/fork | ✅ `~/.codebuddy/projects/<encoded-cwd>/`, `-r`, `--fork-session`                                                     |
| Auth mountable                    | ✅ `CODEBUDDY_API_KEY`/`models.json` (live-verify API-key-only auth)                                                  |
| Interactive attach                | ⚠️ TUI exists; prompt-seeding flag unverified                                                                         |

Shape of the work: a `codebuddy` provider that is a near-copy of `claudeCode` — `buildPrintCommand` emits `codebuddy -p --output-format stream-json --model <m> -y` with the prompt on stdin, reuse the Claude stream parser (possibly gated behind a shared `parseClaudeCompatibleStreamLine`), a `makeCodebuddySessionStorage` modeled on `makeClaudeSessionStorage` pointing at `.codebuddy/projects`, and a sandbox Dockerfile preinstalling `@tencent-ai/codebuddy-code`. The main new code is the session JSONL cwd-rewriting (`transferClaudeSession` equivalent) if CodeBuddy's session file differs internally. Roughly the size of the copilot/cursor providers, likely less.

Open questions (need a live run):
1. Does `CODEBUDDY_API_KEY` alone authenticate headless runs, or is a first browser login mandatory? (Deal-breaker for sandbox use if the latter and no key path exists.)
2. Internal format of the session JSONL under `projects/` — does `transferClaudeSession`'s cwd rewrite apply, or does it need a CodeBuddy variant? Also whether subagent transcripts live in a sibling dir (Claude has `subagents/`).
3. Interactive prompt-seeding flag for `buildInteractiveArgs`.
4. Whether `--include-partial-messages`'s `stream_event` deltas are worth wiring into the `text` event stream for live display, or whether full assistant lines suffice (our Claude provider uses the full lines; parity is fine).
5. Behavior under our sandbox bind mounts (the CLI also ships its own `--sandbox` e2b/docker machinery — irrelevant for us, but check it stays inert).

## 9. Spike results — live run, 2026-11-07 (CLI v2.181.0 on this host)

All five open questions answered with a real `codebuddy -p --output-format stream-json -y` run in `/tmp/cb-spike`:

1. **Auth**: the existing interactive login works headless — print mode runs with no prompt. No `CODEBUDDY_API_KEY` needed when a login state exists. Default model resolved to `deepseek-v4.1-flash`.
2. **Stream events**: observed `system/init` (with `session_id`), `system/status`, `system/usage_update`, `assistant` (`thinking` block with zero/null usage, then `text` block with real usage `{input_tokens: 26092, output_tokens: 95, cache_creation_input_tokens: 0, cache_read_input_tokens: 2560}`), `result` (`subtype:"success"`, `is_error:false`, `result:"OK"`, `num_turns:3`, `duration_ms:2866`). Exactly the shapes parsed by the Claude-compatible parsers; extra `system` subtypes are ignored as unknown lines.
3. **Session JSONL**: written to `~/.codebuddy/projects/<encoded-cwd>/<session-id>.jsonl` (encoding: `/` → `-`, e.g. `tmp-cb-spike`). Every entry carries top-level `cwd` and `sessionId`; entry types seen: `message`, `file-history-snapshot`, `session-meta`. `rewriteEntryCwd`'s top-level `cwd` rewrite applies directly — `transferClaudeSession` is reusable; its Claude-specific `session_meta.payload.cwd` branch is a harmless no-op.
4. **Fork**: `codebuddy -p ... --resume <id> --fork-session -y` produced a new session id and a new JSONL; the parent file was byte-identical (size checked before/after). Fork support confirmed at the CLI level.
5. **Interactive args**: `Usage: codebuddy|cbc [options] [command] [prompt]` — the prompt is a positional argument, same as Claude's TUI.
6. **Endpoint resolution and the CODEBUDDY_IS_SANDBOX trap (live probes, 2026-11-08)**: the CLI authenticates a session from `~/.local/share/CodeBuddyExtension/Data/Public/auth/<extension-id>.info` (Bearer token, `/auth/domain` = www.codebuddy.cn for a CN account) and resolves the product environment from it — but only when `CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT` is set (any non-empty value observed working; without it a fresh HOME resolves the international endpoint www.codebuddy.ai and the CN session 401s). With that variable, the same auth file authenticates against copilot.tencent.com and model calls succeed. `CODEBUDDY_BASE_URL` is for third-party OpenAI-compatible endpoints, not for choosing Tencent platforms. **This corrects item 6's advice**: `CODEBUDDY_IS_SANDBOX=1` (the "isolated-sandbox full pass") switches the CLI to a sandboxed auth route that cannot use the session — with it set, the same session 401s against www.codebuddy.ai; inject it only for `CODEBUDDY_API_KEY` auth. The npm package is the international product line and cannot authenticate a CN session even with the variable; the native CN build (`codebuddy install stable`) can. The native binary also works from a fake HOME with just the two state dirs present, which is what makes the mount pattern viable.
7. **API-key auth (probe)**: with a fresh HOME and `CODEBUDDY_API_KEY` set to an invalid value, the CLI attempts ApiKey auth against `https://www.codebuddy.ai` and fails with `401 Authentication required` (`token-type:ApiKey`), advising to unset the var or set `CODEBUDDY_API_KEY_DISABLED=1` to fall back to `/login` — so a valid `CODEBUDDY_API_KEY` alone authenticates headless runs, no prior login needed. Note the CLI exits 0 on that failure, surfacing it as a `result` event with `is_error:true` (and an `errors[]` array) — the shared parser maps that to an `error` event, which the Orchestrator fails on regardless of exit code.

One behavioral difference discovered (not in the doc pages): `-y / --dangerously-skip-permissions` bypasses prompts for normal-risk tools but **HIGH/CRITICAL tools still ask** — unless `CODEBUDDY_IS_SANDBOX=1` is present in the process env, which upgrades `-y` to a full pass ("Isolated-sandbox full pass … high-risk", per `codebuddy --help`). Sandcastle must inject `CODEBUDDY_IS_SANDBOX=1` in the provider env for AFK runs, or the iteration hangs on the first HIGH/CRITICAL tool call.

8. **The full CN container recipe (live Docker run, 2026-11-08)**: the CLI caches the resolved product config in `~/.codebuddy/local_storage/entry_<md5>.info` blobs (gzip+base64 JSON, `endpoint` field) and syncs it from its OWN product line at startup — a container running the npm (international) build overwrites the cached CN config with the international one, which then breaks the host CLI too (401 against www.codebuddy.ai everywhere; the token was fine, the endpoint resolution was not). The working recipe: the native CN build inside the sandbox, `~/.local/share/CodeBuddyExtension` mounted read-only (auth; a writable mount lets a 401-triggered token refresh degrade the host state), `~/.codebuddy` read-write (session capture), and `ACC_PRODUCT_CONFIG_PATH` (the config file path env the product schema declares) pointed at a CN product config (`endpoint: https://copilot.tencent.com`) mounted read-only — without it every container start re-syncs the international config. The CN platform's free model is `hy4free`; the `hy4-free` spelling was accepted earlier on 2026-11-08 but began 400-ing the same day — only the dash-less alias resolves. Verified end to end: real run in Docker, one commit with the requested content, the free model in the session record, ledger CLEAN.

## Sources

- npm: https://www.npmjs.com/package/@tencent-ai/codebuddy-code (v2.181.0, tarball inspected 2026-11-07)
- CLI reference: https://intl.cloud.tencent.com/document/product/1316/84467
- Headless/tutorial: https://intl.cloud.tencent.com/document/product/1316/84566
- Config: https://intl.cloud.tencent.com/zh/document/product/1300/80639
- Repo + CHANGELOG: https://cnb.cool/codebuddy/codebuddy-code
- Tarball inspection: `@tencent-ai/codebuddy-code@2.181.0`, `dist/codebuddy-headless.js`, `types/codebuddy-code.d.ts`, `package.json` (local extract under /tmp/cb-extract, read-only)
- Secondary (unverified against first-party): https://github.com/BloopAI/vibe-kanban/pull/1791 (ACP-mode executor), https://github.com/simplast/workbuddy-api/blob/main/docs/codebuddy-thinking-analysis.md (reasoning_effort), https://github.com/nexu-io/open-design/blob/main/docs/agent-adapters.md (stream-json adapter)
