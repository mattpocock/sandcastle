# Configurable `sandcastle` namespace prefix

Sandcastle does not make the `sandcastle` / `.sandcastle` naming prefix configurable (e.g. a `namespace` option on `run()` / `createSandbox()` / `createWorktree()`).

## Why this is out of scope

The prefix is an internal convention, not a public contract: it names temp branches (`sandcastle/<ts>`), worktree directories, and the `.sandcastle/` working area for logs and patches. Making it configurable means threading a `namespace` value through branch naming, worktree and parent directory layout, log/patch path construction, and every sandbox provider — a broad change across the codebase for a cosmetic gain.

The problems a custom prefix would solve are already handled:

- **Collision avoidance** — generated branch and directory names are already timestamped, so concurrent runs don't clash regardless of prefix.
- **Isolation between projects** — runs are anchored to a host repo directory; separate projects already get separate `.sandcastle/` areas. A user who wants harder isolation can run in a separate clone or working copy.

The marginal benefit of a renamable prefix doesn't justify the permanent surface area and the extra option on every entry point.

## Prior requests

- #553 — "Add `namespace` option to customize the `sandcastle` prefix" (closes #552)
- #961 — "Add a configurable `stateDir` option" (relocate only the `.sandcastle/` working area via a new option on `run()` / `interactive()` / `createSandbox()` / `createWorktree()`)
