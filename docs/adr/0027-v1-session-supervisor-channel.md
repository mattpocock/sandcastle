# v1 session supervisor: a daemon in the sandbox, reached by request files and a short-lived client

Status: accepted for the v1 pre-release line.

## Context

v1 runs every agent session inside the sandbox under one **session supervisor**: a single-file Node program built with the package (`dist/supervisor.js`) and copied in by `createSandbox`. It parses the agent's stream, enforces the idle and completion timeouts, extracts structured output and writes logs, so the same code serves a session the host holds and, later, one that carries on after a detach.

The host must talk to it in both directions while it holds the handle, on every provider. Providers differ: Daytona's streamed exec has no stdin and no per-command env. Later, detach must hand the supervisor a finish-report secret that never touches a file, env var or log.

## Decision

- `createSandbox` checks for `node`, writes the bundle to `$HOME/.sandcastle/supervisor/<sandboxId>/supervisor.mjs`, and starts it there as a daemon: detached through the provider's detach capability when it has one (so letting go of the handle never drops it), else as a held exec. A failure closes the sandbox and rejects with `CreateSandboxError`.
- The daemon listens on a Unix socket in its directory, bound by a relative path so a deep home directory can't exceed the socket path limit.
- **Host to supervisor:** the host writes a request as a JSON file into the supervisor's directory, then execs `node supervisor.mjs call <file>`. The client reads and deletes the file, sends it over the socket and prints the replies.
- **Supervisor to host:** one JSON reply per line on that exec's stdout, which every provider streams. A session's replies say when the agent has started, each event, and how it ended; the exec ends when the session does.
- So the channel needs from a provider only file writes and exec with streamed stdout: no stdin, no per-command env. A session's env travels in its request file, which exists until the client starts.
- `close()` asks the supervisor to stop its sessions and exit before the provider ends the sandbox.

### For detach (later)

The secret must not sit in a request file, even briefly: sessions run as the same user. The plan: the supervisor makes a key pair in memory at start and publishes the public half in its directory; the host seals the secret to it and sends the sealed value in the detach request. Only the supervisor's memory can open it.

## Considered options

- **One long-lived exec with stdin as the control channel.** Rejected: Daytona's streamed exec has no stdin.
- **A supervisor process per session, its stdout the stream.** Rejected: detach needs one process that owns every session and knows when the last one ends.
- **Polling request and reply files.** Rejected: slower and needs its own cleanup; the exec stream already gives real-time output.

## Consequences

- Each call costs a file write and an exec round trip. Fine for sessions; `exec` itself still goes straight to the provider.
- The sandbox needs Node.js (already a v1 requirement).
- Agents are named by id plus options (`claudeCode(model, options)` records a descriptor), because a function can't cross into the sandbox; custom agent providers can't run in v1.
