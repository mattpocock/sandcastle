# v1 reattach and status: read the supervisor's files

Status: accepted for the v1 pre-release line.

## Context

A remote orchestrator detaches ([ADR 0028](0028-v1-detach-deadline-and-finish-report.md)) and its function returns. Later, often from a fresh process, it needs to look at the run: what is still running, when the deadline is, whether the finish report went out, and the report itself when it never arrived. The supervisor exits once its detached work is reported, so a live supervisor can't be what answers.

## Decision

- **`reattachSandbox({ provider, sandboxId, env? })`** gets the sandbox through the provider's `get` (the detach capability's; `daytona()` ignores its `create` options) and returns the same `DetachableSandbox` handle `createSandbox` does. It rejects with `SandboxUnavailableError` when the provider says the sandbox is gone; any other failure is the provider's own error, so "ended" and "unknown" differ. It resolves `undefined` when the sandbox is there but has no supervisor status file: its supervisor's files are gone, or Sandcastle never started one in it.
- **The supervisor keeps a status file**, `status.json` in its directory, rewritten whole (temp file, rename) whenever its work changes: the running sessions, the ended ones with their records' delivery, the last detach (id, when, deadline by the sandbox's clock, destination) and the finish report's delivery state (`not-finished`, `delivering`, `delivered`, `gone`, `gave-up`, `no-destination`), and whether the supervisor is `running` or `exited`. Each change is on disk before the reply that follows it, so `status()` never lags what a caller was just told.
- **`status({ logLines? })`** reads that file, the finish report from `reports/<detachId>.json` and the tail of `supervisor.log`, through the provider's file reads. It needs no live supervisor, so it works on a held handle, after a detach, and on a handle reattached after the supervisor exited. It has no "finished" flag: with a destination, the delivered report stays the finish signal.
- **An exited supervisor still gives a handle.** Story: delivery gave up, the orchestrator never heard back, and a fresh `reattachSandbox` must still read the report. The handle's sessions then reject; `exec`, files, `status()` and `close()` work.
- **Env is passed again, not stored.** Sandcastle doesn't keep the env a sandbox was created with: it's the caller's secrets, and a file of them in the sandbox would outlive their use. `reattachSandbox`'s `env` goes under each `exec` call's own env. The fake provider reads its env back from its own state anyway; Daytona can't, so a reattached Daytona handle's commands get only what's passed. Sessions are unaffected: they run under the supervisor, which kept the env it started with.

## Considered options

- **Ask the live supervisor for status.** Rejected: it has exited by the time an undelivered report matters most.
- **`undefined` once the supervisor has exited.** Rejected: an undelivered report would then be readable only through `native`.
- **Store the create env in the sandbox for reattach.** Rejected: secrets at rest. Easy to add later behind an option if callers want it.

## Consequences

- `status()` costs a few file reads through the provider (three on Daytona's file API).
- The deadline and `detachedAt` in `status()` are by the sandbox's clock; the receipt's deadline is by the host's.
- `close()` on a reattached handle ends the sandbox and its detached work: a handle meant only for looking shouldn't be `await using`-ed.
- 2026-11-04: the supervisor exits right after its finish report is delivered, and a reattach in that window could read `running` from `status.json`, then wait out the client's 15 s connect retries for a supervisor that was gone. That's exactly when an orchestrator reattaches to `close()` the sandbox. The client now reads `status.json` again before each connect attempt and gives up as soon as it says `exited`, so the reattach falls back to the exited supervisor's handle within one retry. Chosen over having the supervisor write `exited` before it stops listening: that alone still leaves a reattach that read `running` a moment earlier waiting the full 15 s.
- 2026-11-05: `reattachSandbox` no longer says hello to a running supervisor up front: the link is made on first use (a session, a detach, `close()`), and a supervisor that doesn't answer then is taken as exited, as before. The hello starts the supervisor's client, a Node process that loads the whole bundle, and on a sandbox busy with the agent's own work (a test suite on every core) that took 35 s or more on Daytona, so a reattach only to look through `status()` or `follow()` waited that long, or long enough that a 90 s follow printed nothing. Those two read files and never needed it. Chosen over writing the supervisor's public key into `status.json` to skip the hello: the key would then come from a file any session can write.
