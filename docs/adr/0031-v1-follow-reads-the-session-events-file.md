# v1 follow: poll a redacted events file through the provider's file reads

Status: accepted for the v1 pre-release line.

## Context

An orchestrator or agent watching a detached run wants to see what the agent is doing while it does it, and to know when it's done, ideally as one loop it can wait on. Until now a session's events left the sandbox only in its record, once the session ended ([ADR 0029](0029-v1-session-records-leave-from-inside-the-sandbox.md)); `status()` ([ADR 0030](0030-v1-reattach-and-status-read-the-supervisors-files.md)) says what's running, not what it's doing. The watcher is often a fresh process holding a reattached handle, the supervisor may have exited, and the provider may be any one that can detach.

## Decision

- **The supervisor appends each session's events to a file**, `sessions/<id>.events.jsonl` in its directory: one event per line, the normalised events `spawnSession`'s `events` show plus the time the supervisor saw each (the record's `RecordedEvent`). Each event is masked with the session's record redaction before it's written, so the file never holds a value the record would mask. A session that asked for no record has nothing to mask, like its raw log beside it.
- **The file is closed before the session shows as ended in `status.json`**, and `status.json` now carries each session's id. So a reader that sees the session ended, then reads the file, has every event.
- **`follow({ session?, from? })` on a detachable handle** returns an async iterable of those events. It reads `status.json`, then the events file, through the provider's `readTextFile`, yields the complete lines past where its last read stopped, and repeats every 500 ms until the session has ended (or the supervisor has exited), yielding what's left first. It needs no live supervisor, so it works on a held handle, after `detach()`, and on a reattached handle with the supervisor gone. `session` picks the latest session by that name, default the only one; `from` skips events an earlier follow already yielded. It rejects with `SandboxUnavailableError` once the sandbox has ended.

## Considered options

- **Poll file reads (chosen).** Every provider that can detach already reads files, and `status()` relies on it; Daytona's file API is enough. Costs a status read plus a file read per poll, and up to half a second of lag.
- **`exec` a `tail -f` and stream its stdout.** Lower latency, but it rests on streamed exec, which varies by provider (Daytona's streamed exec has no stdin EOF and no env), and a dropped stream needs the same offset bookkeeping anyway.
- **Ask the live supervisor for an event stream.** Rejected for the same reason as for `status()`: the supervisor has exited by the time a watcher reattaches after a run, and a channel into the sandbox per watcher is more surface than a file read.
- **Follow the raw per-session log** (`sessions/<id>.log`). Rejected: it's the agent's unredacted stdout in its own format, so the host would have to parse each agent's stream and could show a value the record masks.

## Consequences

- Each poll reads the whole events file: the provider contract has no ranged read. Events are short (text and tool-call arguments, no transcript), so this is fine for v1; a ranged `readTextFile` could replace it later without changing `follow()`.
- `from` counts events, not bytes: a watcher that dropped resumes by how many it saw.
- The events file stays in the sandbox until it ends, like the raw log.
- Redaction of followed events is the record's, applied per event as the agent goes, so a secret split across two events is not masked; the record has the same limit.
