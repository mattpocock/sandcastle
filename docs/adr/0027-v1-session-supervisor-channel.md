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

The secret must not sit in a request file, even briefly: sessions run as the same user. The supervisor makes a key pair in memory at start and returns the public half in its `hello` reply, which the host keeps; the host seals the secret to it and sends the sealed value in the detach request. Only the supervisor's memory can open it. Built as [ADR 0028](0028-v1-detach-deadline-and-finish-report.md) records (the public half travels in the hello rather than a file, which a session could replace).

## Considered options

- **One long-lived exec with stdin as the control channel.** Rejected: Daytona's streamed exec has no stdin.
- **A supervisor process per session, its stdout the stream.** Rejected: detach needs one process that owns every session and knows when the last one ends.
- **Polling request and reply files.** Rejected: slower and needs its own cleanup; the exec stream already gives real-time output.

## Consequences

- Each call costs a file write and an exec round trip. Fine for sessions; `exec` itself still goes straight to the provider.
- The sandbox needs Node.js (already a v1 requirement).
- Agents are named by id plus options (`claudeCode(model, options)` records a descriptor), because a function can't cross into the sandbox; custom agent providers can't run in v1.

## Trust model (2026-11-04): open, to decide before 1.0.0

The control socket is unauthenticated. Any process running as the sandbox user, the agent included, can connect to it and send any request the host can: `session`, `kill`, `shutdown`, `detach`. So an agent can stop its own or a sibling session, shut the supervisor down, or detach the sandbox with a destination and secret of its own choosing. It can't read a finish-report secret the host sealed (only the supervisor's memory opens one), but it can make the run end early or report somewhere else. Request files and the supervisor's directory are as open to it.

This is left open for the maintainer to decide before 1.0.0. The options:

- **Status quo: the agent is trusted within its sandbox.** The sandbox is the boundary; anything that runs in it, the agent included, may steer the work in it. Cheapest, and consistent with the agent already holding the sandbox's env and files. Must be written down for users as such.
- **A per-start token held only by the host channel.** The supervisor makes a random token at start and returns it in the `hello` reply only once; every later request must carry it. The host's request files would then hold it, so it is only as private as those files and the window before the client deletes them (a session could race to read one), and `hello` must refuse a second caller.
- **Socket ownership and permissions.** Run the supervisor as a different user from the agent, with the socket and its directory readable only by that user and the host's exec. Strongest, but needs every provider to run commands as a second user (or `sudo`), which v1 doesn't ask of them.
