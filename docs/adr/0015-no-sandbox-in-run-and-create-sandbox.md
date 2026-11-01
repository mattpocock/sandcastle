# Allow `noSandbox()` in `run()` and `createSandbox()`

## Context

`noSandbox()` runs the agent directly on the **host** with no container. Previously the `SandboxProvider` union deliberately excluded `NoSandboxProvider`, so only `interactive()` accepted it — `run()` and `createSandbox()` rejected it at the type level. The intent was to prevent unsupervised (AFK) execution from escaping isolation, since `run()` is the AFK entry point.

In practice, subscription-billed Claude users (and anyone running Sandcastle inside an already-isolated environment — containerized CI, VM, sandbox host) had no path to AFK orchestration. The workaround was to fork `noSandbox` and flip the type tag, which every such user re-invented. With the API-key-only sandbox path tracked in #191 marked wontfix, the type-level gate was forcing a workaround rather than preventing a mistake.

## Decision

Drop the type-level restriction. `SandboxProvider` now includes `NoSandboxProvider` alongside `BindMountSandboxProvider` and `IsolatedSandboxProvider`, so `run()`, `createSandbox()`, and `interactive()` all accept it. The opt-in is the `noSandbox()` import itself — no extra `allowAfk` flag.

All three **branch strategies** remain supported with `noSandbox()`: **head** (agent works directly in `hostRepoDir`, no worktree), **merge-to-head**, and **branch** (worktree created on host, agent runs against it without a container).

Rejected alternatives:

- **Keep the type-level guard, add `noSandbox({ allowAfk: true })` as an explicit unlock.** The issue (#507) proposed this. Rejected because the `noSandbox()` import is already the opt-in — the user has to reach for a provider that the README and GLOSSARY.md both describe as host-execution-only. A second flag on top adds ceremony without preventing the mistake it claims to prevent: anyone wiring `noSandbox()` into `run()` will pass the flag the type error tells them to pass.
- **Reject `head` strategy with `noSandbox()` in `run()`, force a worktree.** Rejected because worktree-as-isolation-boundary is a partial protection at best — the agent already has full host access via `noSandbox()`. Forcing a worktree adds a copy step without changing the trust model. Callers who want a worktree pass `branchStrategy: { type: "merge-to-head" }` explicitly.

## Consequences

- Pre-1.0, shipped as a `patch` changeset.
- `AnySandboxProvider` is deprecated as an alias for `SandboxProvider` — the distinction it encoded no longer exists.
- Trust model is explicit: importing `noSandbox()` is the opt-in. Sandcastle does not add a runtime guard against AFK-on-host; the caller owns the risk.
- The **agent provider** still does not receive `dangerouslySkipPermissions: true` with `noSandbox()` — that behaviour is unchanged from the `interactive()`-only path.
