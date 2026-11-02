# Agent sessions

Sandcastle captures the [agent session](./glossary.md#agent-session), the [agent](./glossary.md#agent)'s own record of the conversation, after each [iteration](./glossary.md#iteration). Continue it with `resume()` on the result:

```typescript
import { run, codex } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const first = await run({
  agent: codex("gpt-5.4"),
  sandbox: docker(),
  prompt: "Draft a plan",
});

console.log(first.iterations[0]?.sessionId); // the captured session's id

const second = await first.resume?.("Now implement the plan");
```

## Session capture

After each resumable provider iteration, Sandcastle automatically captures the agent's session file from the [sandbox](./glossary.md#sandbox) to the [host](./glossary.md#host). Claude Code sessions are stored under `~/.claude/projects/<encoded-path>/<session-id>.jsonl`; Codex sessions are stored under `~/.codex/sessions/YYYY/MM/DD/rollout-*-<session-id>.jsonl`; Pi sessions are stored under `~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<session-id>.jsonl`; Copilot sessions are stored under `~/.copilot/session-state/<session-id>/events.jsonl`; Cursor chats are stored under `~/.cursor/chats/<md5-of-cwd>/<chat-id>/store.db` (an SQLite file, copied byte for byte). OpenCode keeps sessions in its SQLite database, so Sandcastle runs `opencode export <id>` in the sandbox and stores the JSON under `~/.local/share/opencode/sandcastle-sessions/<session-id>.json`. Any provider-specific `cwd` fields are rewritten to match the host repo root, so the provider's native resume command works.

For Claude Code, any `Agent`-tool or `Workflow`-tool subagent transcripts written under `<session-id>/subagents/agent-*.jsonl` are captured alongside the main session. Subagent capture is best-effort: a failure on an individual transcript logs a warning and lets siblings and the main session through. Main-session capture failure still fails the run (see below).

Session capture is enabled by default for `claudeCode()`, `codex()`, `pi()`, `copilot()`, `cursor()`, and `opencode()` and can be opted out via `captureSessions: false`. Providers without `sessionStorage` do not attempt capture. Capture failure fails the run.

## Session resume

Pass `resumeSession` to `run()` to continue a prior Claude Code, Codex, Pi, Copilot, Cursor, or OpenCode conversation inside a new sandbox:

```typescript
const result = await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  prompt: "Continue where you left off",
  resumeSession: "abc-123-def",
});
```

You can also continue the last captured session from a result:

```typescript
const first = await run({
  agent: codex("gpt-5.4"),
  sandbox: docker(),
  prompt: "Draft a plan",
});

const second = await first.resume?.("Now implement the plan");
```

`resume` is present only on results from resumable providers — hence the optional-chaining call. Which providers resume and fork:

| [Agent provider](./glossary.md#agent-provider) | Resume                        | Fork                                  |
| ---------------------------------------------- | ----------------------------- | ------------------------------------- |
| `claudeCode`                                   | `claude --resume <id>`        | `claude --resume <id> --fork-session` |
| `codex`                                        | `codex exec resume <id>`      | `codex exec fork <id>`                |
| `pi`                                           | `pi --session <id>`           | `pi --fork <id>`                      |
| `opencode`                                     | `opencode run --session <id>` | `opencode run --session <id> --fork`  |
| `copilot`                                      | `copilot --resume=<id>`       | No: throws `ForkNotSupportedError`    |
| `cursor`                                       | `agent --resume=<id>`         | No: throws `ForkNotSupportedError`    |

Before the sandbox starts, Sandcastle validates that the session file exists on the host and transfers it into the sandbox with `cwd` fields rewritten to match the sandbox-side path. Claude Code receives `--resume <id>`; Codex receives `codex exec resume <id>` with the [prompt](./glossary.md#prompt) piped over stdin; Pi receives `--session <id>`; Copilot and Cursor receive `--resume=<id>`. OpenCode's session is first loaded with `opencode import`, then OpenCode receives `--session <id>`.

Constraints:

- `resumeSession` is incompatible with `maxIterations > 1` (throws before sandbox creation).
- The provider's host session file must exist (throws before sandbox creation).
- Only iteration 1 receives the resume flag; subsequent iterations (if any) start fresh.
- Providers without resume support reject `resumeSession`.
- `.resume()` and `.fork()` don't inherit the first run's `output` or `promptArgs`. To parse `output` from the follow-up, pass `output` again, and put its tag in the follow-up prompt.

## Session fork

`RunResult.fork(prompt, options?)` is the sibling of `.resume()`: it continues from the last captured session but leaves the parent session JSONL untouched and writes the child under a new session id. The mechanism is the agent's native fork flag — `claude --resume <id> --fork-session` for Claude Code, `codex exec fork <id>` for Codex, `pi --fork <id>` for Pi, `opencode run --session <id> --fork` for OpenCode.

Fork enables fan-out workflows where a single parent run is the starting point for several independent children:

```typescript
const parent = await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  prompt: "Read the codebase and summarise the data model",
});

const [reviewA, reviewB] = await Promise.all([
  parent.fork?.("Review the migration plan", {
    branchStrategy: { type: "branch", branch: "review-a" },
  }),
  parent.fork?.("Audit the auth layer", {
    branchStrategy: { type: "branch", branch: "review-b" },
  }),
]);
```

**Fork is session-only.** `--fork-session` and `codex exec fork` isolate the agent session JSONL — they do **not** isolate the branch, [worktree](./glossary.md#worktree), or sandbox. Safe concurrent fan-out (`Promise.all([r.fork(a), r.fork(b)])`) requires the caller to give each child a distinct `branch` via `branchStrategy: { type: "branch", branch: "..." }`. The default `head` and `merge-to-head` strategies are **not** safe for concurrent forks: `head` shares the host working directory across all children, and `merge-to-head` races `git merge` against the same HEAD.

`fork` is present only on results from providers with `sessionStorage` — hence the optional-chaining call. The same single-iteration and session-file constraints as `.resume()` apply. A provider whose CLI resumes but has no fork flag (Copilot, Cursor) throws a `ForkNotSupportedError` naming it before any sandbox starts; match it on `error._tag === "ForkNotSupportedError"` and call `.resume()` instead.

## Related terms

- [Agent providers](./agent-providers.md): `captureSessions` on each provider
- [Structured output](./structured-output.md): `maxRetries`, which resumes the session to fix bad output
- [Branch strategies](./branch-strategies.md): giving each fork its own branch
- [Iterations](./iterations.md): only the first iteration resumes
- [`run()` reference](./run.md#iterationresult): `sessionId` and `sessionFilePath` on each iteration
