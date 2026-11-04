# v1 testing entry point: a fake provider on real temp dirs and real processes

Status: proposed, for the v1 pre-release line (`@ai-hero/sandcastle/v1/testing`). Accepted for v1 pre-releases by the coordinator on 2026-11-04; Matt's review is required before 1.0.0.

## Context

v1 replaces the bind-mount/isolated/no-sandbox split with one Promise-based provider contract and one `createSandbox({ provider, env, timeLimitMinutes })`. Everything later in v1 (the session supervisor, detach, finish reports, session records, bundled tasks) needs a provider to be tested on, and so do users testing their own orchestrators and finish-report receivers without a cloud account or a model.

Until now the test doubles (`testIsolated()`, `testBindMount()`) were internal files, excluded from coverage and unreachable through the package. The coding standards allow exactly one test-motivated public surface: a test helpers entry point. This record is its design review, held before it is built, because anything a user imports from it is hard to take back.

## Decision

Ship `@ai-hero/sandcastle/v1/testing` (moving to `@ai-hero/sandcastle/testing` when v1 takes over the root) with one export in this change:

```ts
fakeSandbox(options?: {
  rootDir?: string; // where sandbox dirs go; default a shared dir under os.tmpdir()
}): FakeSandboxProvider;

interface FakeSandboxProvider
  extends SandboxProvider<FakeSandboxNative, true>, AsyncDisposable {
  pathOf(sandboxId: string): string; // <rootDir>/<sandboxId>, whether or not it still exists
  closeAll(): Promise<void>;         // close every sandbox this provider made
}

interface FakeSandboxNative { readonly directory: string }
```

It is built with the public `createSandboxProvider`, the same contract a provider author uses, so it can't reach anything a third-party provider can't.

- **Real, not simulated.** Each sandbox is a directory `<rootDir>/<sandboxId>/` with `work/` (the `workingDirectory`), `home/` and `tmp/`; this layout is part of the API. `exec` runs a real child process (`sh -c`) in its own process group; `readTextFile`/`writeTextFile` are real file I/O, relative paths resolving against `work/`. Later changes run the real session supervisor bundle inside it.
- **Contained.** A file path that resolves outside the sandbox's directory is rejected. `HOME` is `home/` and `TMPDIR` is `tmp/`.
- **Exactly the env given.** A command sees the host's `PATH` (so `sh` finds tools), then the sandbox's `env`, then its per-command `env`, then `HOME` and `TMPDIR`: the caller's `PATH` wins over the host's, the fake's `HOME` and `TMPDIR` always win. Nothing else from the host process's env reaches it, so a test can assert what reaches a command, and agent CLIs and skills installers never write into the developer's real home.
- **A kill time it reports and enforces.** `killTime` is creation plus `timeLimitMinutes`, which accepts fractions, so a test asks for a seconds-long life the same way a user asks for an hour. At `killTime` the fake kills every process and removes the sandbox, like a vendor TTL.
- **State on disk.** Each sandbox keeps its env, kill time and running process groups in files inside its own directory, so `get(sandboxId)` works from a fresh `fakeSandbox()` instance, or another process, with the same `rootDir`, and resolves `undefined` once the directory is gone. The kill time is enforced by a detached reaper process per sandbox, so it holds even if the process that made the sandbox crashes or exits.
- **Detachable.** It carries the contract's detach capability: detached work runs on as host processes, outliving the handle.
- **`close()`** kills every process group the sandbox started and removes its directory. Idempotent. `closeAll()` (and `await using` on the provider) closes every sandbox the provider made, for `afterEach`. A caller-supplied `rootDir` itself is never deleted.
- **`sudo` is accepted and ignored**: everything runs as the current user. Documented on the export.
- **POSIX only.** It needs `sh` and process groups. Its tests skip on Windows; a Windows-native fake can follow if users ask.

## Considered options

- **An in-memory fake** (a virtual file map, scripted command results). Rejected: it can't run the real supervisor or real agent CLIs, so it would test a model of Sandcastle instead of Sandcastle, and every later change needs real processes.
- **Promoting `testIsolated()`.** Rejected: it implements the 0.x contract that v1 replaces.
- **Inheriting the host env.** Rejected: tests couldn't assert on env, and a real `HOME` lets an agent or skills installer clobber the developer's own config.
- **Options for injecting failures** (`failCreate`, `failExec`). Left out: a user can wrap any provider with `createSandboxProvider` to inject failures.
- **A `killAfterMs` option** to shorten the kill time. Dropped: fractional `timeLimitMinutes` does the same through the normal path.
- **A fresh temp root per instance.** Rejected: reattach from another instance or process couldn't find the sandbox.

## Deferred

- **`fakeAgent`**, the agent that replays recorded streams. It is the input to sessions, whose agent descriptor the supervisor change designs (an agent must be serialisable to cross into the sandbox). Shipping it before that would fix its shape blind. It lands with sessions, with its own short review, before the detached-session tests; whether recorded fixtures ship inside the package is a separate one-way door for that review.
- **The detach deadline margin.** The detach change computes its default deadline from `killTime`; with a seconds-long time limit a fixed margin would put the deadline in the past, so that change scales the margin down or makes it settable. Resolved in [ADR 0028](0028-v1-detach-deadline-and-finish-report.md): the margin is 5 minutes or a quarter of the time limit, whichever is shorter.
- A non-POSIX fake.

## Consequences

- Everything in v1 is tested through the same public seam a user has; no `@internal` hooks.
- The fake is public API. Changing `fakeSandbox`'s options, the directory layout, `pathOf` or `FakeSandboxNative` after v1 ships is a breaking change, so they stay this small.
- Tests that use the fake don't run on the Windows CI job.

## Review (first pass)

An independent review approved the direction (real dirs, real processes, built on the public `createSandboxProvider`, closed env, no failure-injection options) with six changes, all adopted above: file-backed state with a shared `rootDir`; `closeAll()`, with the requested sweep of expired sandboxes done instead by a per-sandbox reaper process that enforces the kill time even after a crash; the deadline margin left to the detach change; containment with a private `TMPDIR`; a pinned shape; no `killAfterMs`.

## Addendum: `fakeAgent` (added with sessions)

```ts
fakeAgent(script: {
  format?: AgentName;        // whose stream format; default "claude-code"
  lines: readonly string[];  // raw stream lines, printed in order
  exitCode?: number;         // default 0
  hang?: boolean;            // keep running after the last line; default false
}): AgentProvider;
```

- **Same shape as a real agent.** It returns the same `AgentProvider` value `claudeCode()` does, a descriptor the session supervisor rebuilds inside the sandbox, with the script attached. The supervisor runs the real agent's command line and stream parser; only the binary is swapped for the bundle replaying the script. So timeouts, structured output and parsing are tested for real.
- **Claude Code's resume, faithfully.** In `claude-code` format it writes the session file where Claude Code would (under the sandbox user's home, keyed by working directory), and a `--resume <id>` that can't find its file fails as the CLI does. `continueSession` therefore works only in the same sandbox and directory, as with the real agent.
- **Inline lines only; no named fixtures.** Recorded fixtures shipping inside the package is a one-way door with no user asking for it yet. Users pass lines (read from their own recordings).
- **Not added:** per-line delays, scripted tool effects, different replies per turn. A test that needs them can run two sessions, or use `hang`.
