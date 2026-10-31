# Resume support requires filesystem-backed session storage

> OpenCode is resumable since [ADR 0022](./0022-opencode-resume-via-export-import.md), through its CLI's own `export` / `import`. The rule below still holds for other database-backed agents.

## Context

Per [ADR 0012](./0012-agent-provider-owned-session-storage.md), each **agent provider** owns its **agent session** storage — the location, key encoding, and content rewriting on host↔sandbox transfer. That ADR left the door open to non-file backends, suggesting a SQLite-backed provider could "serialise the relevant row(s) to a string the same store can round-trip back."

Implementing that for a real SQLite-backed agent (OpenCode) turns out to be a different and far heavier problem than file transfer. The conversation state lives _inside_ a local database file whose schema is private to the agent, may change between versions, is not addressable by a stable per-session path, and can hold rows for many sessions in one file. "Serialise the row(s) to a string" means reaching into another tool's database, understanding its schema, extracting a subgraph, and re-inserting it on the other side — coupling Sandcastle to an undocumented, versioned storage internal. By contrast, file-backed agents (Claude Code, Codex, Pi) persist one self-contained record per session on disk that we can copy verbatim and rewrite by line.

## Decision

Resumability is supported only for agents whose session record is **filesystem-backed** — a discrete file (or set of files) per session that Sandcastle can read, transfer, and write as opaque content, applying at most line-level rewriting.

If an agent's session state is only available in a local database (e.g. OpenCode's SQLite store), Sandcastle does **not** implement resume for it. Such a provider ships with `captureSessions: false` and no `sessionStorage` sub-object, so `RunResult.resume` is typed `never` for it — the existing ADR 0012 mechanism, with no special-casing.

This was confirmed feasible for Codex: its sessions are filesystem JSONL rollout files under `~/.codex/sessions/`, with SQLite used only as an index over those files, not as the source of truth — so Codex qualifies.

## Consequences

- Issue #566 (resume support for the OpenCode provider) is closed as won't-fix; OpenCode remains usable, just non-resumable.
- `docs/agents/adding-an-agent-provider.md` drops the "serialise the relevant row(s)" SQLite guidance and states the filesystem requirement as a must-have for resume.
- The "Persisted session storage" must-have in the new-agent questionnaire becomes a hard filesystem gate: a database row addressable only via the agent's own DB does not satisfy it.
- Reversible in principle — if a future agent's DB exposes a clean, documented per-session export/import path, this can be revisited — but the default stance is "filesystem or no resume."
