# Coder provider uses the `coder` CLI, not the REST API

## Context

The `coder()` sandbox provider needs to: provision/attach to a Coder workspace, wait for it to become reachable, exec commands, copy files, and tear down. Three implementation strategies were considered:

1. **Pure REST API + custom tunnel client.** Coder publishes an OpenAPI surface, but command exec and file transfer go over an SSH session **tunneled through the Coder control plane** (websocket relay or DERP) — not plain TCP SSH. A vanilla SSH client (`ssh2`) cannot connect; we would have to reimplement Coder's tunnel protocol.
2. **Hybrid: REST for state, CLI for exec.** Use REST for typed access to status / parameter schemas / `/watch` events, and `coder ssh` for the tunnel.
3. **Pure `coder` CLI.** Shell out for everything, mirroring `src/sandboxes/docker.ts`'s `spawn(...)` style.

Empirical verification of the CLI surface confirmed:

- `coder create` and `coder start` block by default until the workspace is `running` AND the workspace agent is `connected` — exit code is the readiness signal.
- `coder list -o json` returns full state (`latest_build.status`, `rich_parameter_values`, agents per resource).
- `coder list --all -o json` can be used to resolve a Coder workspace ID to `owner/name`; plain `--search <uuid>` did not return ID matches in the verified CLI.
- `coder ssh <ws>` auto-allocates a PTY when stdin is a TTY, and `coder ssh <ws>.<agent>` selects a specific workspace agent.
- `coder ssh <ws> -- <cmd>` streams stdout in real time; this satisfies `IsolatedSandboxHandle.exec`'s mandatory line-by-line streaming contract.
- `coder login --token` and `CODER_URL`/`CODER_SESSION_TOKEN` cover non-interactive auth.
- `coder whoami -o json` is a fast preflight that catches both "binary missing" (ENOENT) and "auth invalid" (non-zero exit) in one call, and returns user/org/URL we can put into error messages.

The "gaps" the CLI does not cover (parameter schema introspection, `/watch-ws` SSE, `/usage` heartbeat) turn out to be unnecessary for our needs: we don't validate parameters client-side (Coder rejects with clear errors), `coder create` already blocks on readiness, and SSH activity itself bumps `last_used_at` while commands are in flight, so between-call dormancy heartbeating is not required for v1.

## Decision

Implement the `coder()` provider as a thin shell over the `coder` CLI:

- Every operation uses `spawn("coder", [...])`.
- `coder` binary on `$PATH` is a hard runtime requirement.
- A single `coder whoami -o json` preflight on each `create()` call doubles as binary check + auth check + diagnostic context capture; failures are wrapped in a typed error.
- `--output json` is treated as a stable contract for the fields we depend on (`id`, `name`, `latest_build.status`, `rich_parameter_values`, agent name and `directory`).
- File copy uses OpenSSH `ssh` streams with a per-command `ProxyCommand=coder ssh --stdio ...` so transfer still goes through the Coder CLI tunnel without mutating the user's SSH config. Direct `coder ssh -- sh -c ...` remains used for non-stdin command execution and setup commands.
- **Stdin-bearing `exec()` calls also go through the OpenSSH `ProxyCommand` path.** `coder ssh <ws> -- <cmd>` does not propagate stdin EOF to the remote process — `claude --print -p -` and similar commands hang waiting for input the host already sent. OpenSSH propagates EOF correctly. Detected during dogfood runs against `dev.coder.com`; verified that `echo X | coder ssh <ws> -- cat` hangs indefinitely while the same pipeline through `ssh ... ProxyCommand=coder ssh --stdio ...` exits cleanly. Env vars on this path are inlined as a `KEY='value' sh -c '<cmd>'` shell prefix because OpenSSH has no `--env` flag.
- After workspace agents report `connected` we still issue an `coder ssh -- printf ready` readiness probe (`waitForSshReady`) before the first real `coder ssh` call. Coder prebuild claims can briefly report the new agent as `connected` while the prior prebuild agent is still shutting down, and the next `coder ssh` lands on the disconnecting agent and fails with `error: agent is shutting down`. The probe loops until the round-trip succeeds (default budget 60s; each retry is 2s).
- `interactiveExec` shells out to `coder ssh <ws>.<agent>` and forwards caller-provided stdio streams directly; the verified CLI has no `--force-tty` flag, so real TTY descriptors are passed through for Coder's automatic PTY detection.

Rejected alternatives:

- **Pure REST + custom tunnel.** Reimplementing Coder's SSH tunnel protocol is a large, ongoing maintenance burden tied to a fast-moving upstream. Marginal benefit (no `coder` binary) does not justify the cost.
- **Hybrid REST + CLI.** Two code paths to keep aligned, two auth surfaces (header + env var), and the REST-only capabilities (parameter schema, `/watch-ws`, `/usage`) are not needed for v1. If a real need surfaces later, REST calls can be added internally without changing the public API.

## Consequences

- Hard runtime dependency on the `coder` binary. Documented in the README; failure mode is a clear typed error from the preflight, not a mid-run `ENOENT`.
- No new npm peer dependency (Vercel and Daytona are peer-dep'd; Coder is not, because there is no first-party JS SDK on npm and the CLI fills the role).
- The provider is small — a few hundred lines of `spawn` orchestration, comparable to `src/sandboxes/docker.ts`.
- If Coder breaks `--output json` field shapes in a future release, our parsing of `coder list -o json` and `coder whoami -o json` may need updating. We pin to widely-used fields and avoid speculative ones; in practice these fields are used by Coder's own automation tooling.
- Adding REST-backed features later (e.g. dormancy heartbeat via `POST /workspaces/{id}/usage`) is non-breaking — they would be internal background concerns invisible to `CoderOptions`.
