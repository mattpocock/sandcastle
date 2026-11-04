# v1 session records leave from inside the sandbox

Status: accepted for the v1 pre-release line.

## Context

Retros need every run's transcript. A remote orchestrator detaches from an hour-long run and never sees the agent's session file, and 0.x's answer, copying session files into the host's own agent directories, changes host state because of what ran in a sandbox. A transcript should reach storage (S3, say) with no storage credential in the sandbox, and secrets the agent saw must not leave with it.

## Decision

- **A session's `record` option** names its sinks. When the session ends, the session supervisor builds a `SessionRecord` (`type: "sandcastle.session-record"`, `version: 1`): its name, agent, model, session id, times, exit reason, usage, the caller's `labels`, a small versioned stream of events (`eventsVersion: 1`: what `events` shows, timestamped), and the agent's native transcript, base64, as the main payload. Only Claude Code's transcript is read for now; other agents' records carry no `native`.
- **Sinks that run in the sandbox, held or detached:** `upload` PUTs the record (JSON) to a URL the caller gives, such as an S3 presigned PUT, so the sandbox needs no storage key; `webhook` POSTs it as a Standard Webhook signed like the finish report, with the record's id as `webhook-id`. Both go through the finish report's delivery code (retries with backoff, `Retry-After`, 410 stops), for at most 60 seconds and never past the kill time, because the finish report waits for them.
- **Sinks that run on the host, while the handle is held:** `directory` writes `<path>/<sandboxId>/<name>.json` and the native file beside it; `onRecord` is called with the record. The supervisor sends the record back on the session's reply stream before `ended`, and the session resolves only once these are done; a failing one rejects the session's result with its error. After a detach they don't run.
- **The upload URL and the webhook secret travel sealed** to the supervisor's in-memory key, like the finish report's secret (ADR 0028): a presigned URL is a credential.
- **Redaction is data**: literal `values` and `envVars` names, whose values as the session saw them (its own env, then the sandbox's) are masked as `[REDACTED]`, longest first, in the native transcript and the events, inside the sandbox before anything leaves it. Not regular expressions: they are easy to get wrong in a way that leaks, and literals cover the known secrets a caller holds.
- **Records go before the finish report.** Recording is part of a session's end, so the finish report, built once every carried-on session has ended, comes after the records it points to. Each session report carries a `record` pointer: the record's id, and for each in-sandbox sink its URL without the query string (which may hold a credential) and how delivery went (`delivered`, `gone`, `gave-up`).
- **Nothing is written to the host's agent directories** on the v1 path.

## Considered options

- **Regex redaction, and a switch to mask every env value.** Rejected: a regex can't be checked for leaks by reading it, and masking every env value masks paths and common words.
- **The upload body as the raw transcript.** Rejected for now: the record carries the labels and events a reader needs to find and skim it; the transcript is one field away.
- **Retrying sinks until the kill time.** Rejected: a receiver that's down would hold the finish report hostage.

## Consequences

- One request per sink; a very long transcript is one body. An S3 presigned PUT takes up to 5 GB; a webhook receiver's body limit may not.
- Sub-agent transcripts, a `turns` count, sandbox-wide `records` defaults on `createSandbox` and a record verifier helper are left for later.
