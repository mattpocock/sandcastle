# Agent sessions

> **Agent session**: The **agent**'s persisted conversation record. Storage shape and location are owned by the **agent provider** -- Claude Code writes a `<session-id>.jsonl` under `~/.claude/projects/<encoded-cwd>/`; other agents use their own conventions (e.g. `~/.codex/sessions/`, `~/.pi/agent/sessions/`, OpenCode's SQLite store, which Sandcastle moves as `opencode export` JSON). Resumable when the **agent provider** declares session-storage support; the resume mechanism is the agent's native flag (e.g. `claude --resume`, `codex exec resume`, `pi --session`, `opencode run --session`).

> **Session resume**: Continuing an **agent session** by appending new turns to the same session record -- the session ID is unchanged and the prior record is mutated in place. Exposed as `RunResult.resume()`.

> **Session fork**: Branching an **agent session** into a new record with a new session ID, leaving the parent record byte-for-byte unchanged. Uses the **agent**'s native fork flag (`claude --fork-session`, `codex exec fork`). Exposed as `RunResult.fork()`. Isolates the session only -- not the **source branch** or **sandbox**. An **agent provider** whose CLI resumes but has no fork flag declares `canFork: false`, and `.fork()` throws `ForkNotSupportedError` for it (ADR 0021).

Sandcastle captures the agent session after each iteration. Continue it with `resume()` on the result:

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

After each resumable provider iteration, Sandcastle automatically captures the agent's session file from the sandbox to the host. Claude Code sessions are stored under `~/.claude/projects/<encoded-path>/<session-id>.jsonl`; Codex sessions are stored under `~/.codex/sessions/YYYY/MM/DD/rollout-*-<session-id>.jsonl`; Pi sessions are stored under `~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<session-id>.jsonl`; Copilot sessions are stored under `~/.copilot/session-state/<session-id>/events.jsonl`; Cursor chats are stored under `~/.cursor/chats/<md5-of-cwd>/<chat-id>/store.db` (an SQLite file, copied byte for byte). OpenCode keeps sessions in its SQLite database, so Sandcastle runs `opencode export <id>` in the sandbox and stores the JSON under `~/.local/share/opencode/sandcastle-sessions/<session-id>.json` ([ADR 0022](../adr/0022-opencode-resume-via-export-import.md)). Any provider-specific `cwd` fields are rewritten to match the host repo root, so the provider's native resume command works.

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

| Agent provider | Resume                        | Fork                                  |
| -------------- | ----------------------------- | ------------------------------------- |
| `claudeCode`   | `claude --resume <id>`        | `claude --resume <id> --fork-session` |
| `codex`        | `codex exec resume <id>`      | `codex exec fork <id>`                |
| `pi`           | `pi --session <id>`           | `pi --fork <id>`                      |
| `opencode`     | `opencode run --session <id>` | `opencode run --session <id> --fork`  |
| `copilot`      | `copilot --resume=<id>`       | No: throws `ForkNotSupportedError`    |
| `cursor`       | `agent --resume=<id>`         | No: throws `ForkNotSupportedError`    |

Before the sandbox starts, Sandcastle validates that the session file exists on the host and transfers it into the sandbox with `cwd` fields rewritten to match the sandbox-side path. Claude Code receives `--resume <id>`; Codex receives `codex exec resume <id>` with the prompt piped over stdin; Pi receives `--session <id>`; Copilot and Cursor receive `--resume=<id>`. OpenCode's session is first loaded with `opencode import`, then OpenCode receives `--session <id>`.

Constraints:

- `resumeSession` is incompatible with `maxIterations > 1` (throws before sandbox creation).
- The provider's host session file must exist (throws before sandbox creation).
- Only iteration 1 receives the resume flag; subsequent iterations (if any) start fresh.
- Providers without resume support reject `resumeSession`.
- `.resume()` and `.fork()` don't inherit the first run's `output` or `promptArgs`. To get structured output from the follow-up, pass `output` again, and put its tag in the follow-up prompt.

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

**Fork is session-only.** `--fork-session` and `codex exec fork` isolate the agent session JSONL — they do **not** isolate the branch, worktree, or sandbox. Safe concurrent fan-out (`Promise.all([r.fork(a), r.fork(b)])`) requires the caller to give each child a distinct `branch` via `branchStrategy: { type: "branch", branch: "..." }`. The default `head` and `merge-to-head` strategies are **not** safe for concurrent forks: `head` shares the host working directory across all children, and `merge-to-head` races `git merge` against the same HEAD. See [ADR 0018](../adr/0018-fork-is-session-only.md).

`fork` is present only on results from providers with `sessionStorage` — hence the optional-chaining call. The same single-iteration and session-file constraints as `.resume()` apply. A provider whose CLI resumes but has no fork flag (Copilot, Cursor) throws a `ForkNotSupportedError` naming it before any sandbox starts; match it on `error._tag === "ForkNotSupportedError"` and call `.resume()` instead ([ADR 0021](../adr/0021-resume-without-fork.md)).

## Related terms

- [Agent providers](./agent-providers.md): `captureSessions` on each provider
- [Structured output](./structured-output.md): `maxRetries`, which resumes the session to fix bad output
- [Branch strategies](./branch-strategies.md): giving each fork its own branch
- [Iterations](./iterations.md): only the first iteration resumes
- [`run()` reference](./run.md#iterationresult): `sessionId` and `sessionFilePath` on each iteration
