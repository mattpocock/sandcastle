# Phase 1 — Backend Slice Dispatch

You are gpt-5.5 (Codex), dispatched by Claude (Opus 4.7) to build the backend half of Phase 1 of Sandcastle's UX expansion. Phase 0 is committed (`30c0ff6` engine widening + protocol, `dab6772` control-core, `3643505` desktop). This dispatch covers the _control-core + protocol additions_ that the Phase 1 frontend will consume; the frontend slice is a separate dispatch that follows.

Read these first (do not skip):

1. `docs/IMPLEMENTATION_PLAN.md` — single source of truth. **Phase 1 is §7 → "Phase 1 — Multi-repo registry, full primitives, planet/roster/operative read-only"**.
2. `packages/control-core/src/repos/RepoRegistry.ts` — existing single-repo class to expand.
3. `packages/control-core/src/projector/SnapshotProjector.ts` — currently fakes deck/operative; you will replace the synthetic emptyDeck and operative with real loaders.
4. `packages/protocol/src/{state,api}.ts` — existing types you'll add to.
5. `git log --oneline -6` — to understand the commit style.

## What "done" means for Phase 1 backend

Control-core boots, persists state, and answers the following without lying:

1. **Multi-repo registry** at `~/.sandcastle/repos.json`. Add/remove repos. The `--repo=` CLI arg becomes a "current repo" selector among registered repos (auto-register if not present). `repos.json` schema: `{ version: 1, repos: { id, root, addedAt, lastOpenedAt }[] }`.
2. **DeckLoader** reads `<repo>/.sandcastle/agents.md` (mode), `<repo>/.sandcastle/skills/*.md` (skills), `<repo>/.sandcastle/commands/*.md` (commands). Parse YAML frontmatter via `gray-matter` (already in npm; if not, add to control-core deps). The deck returned must conform to `protocol/state.ts:Deck`. Missing files → return a valid empty deck for that section, never throw. Invalid frontmatter → log a warning, skip that file, continue.
3. **TelemetryIndexer** computes basic git telemetry per repo: `ageDays` (first commit → now), `testCount` (count of files matching `**/*.{test,spec}.{ts,tsx,js,jsx}`), `branch` (current HEAD), `lastCommitAt` (HEAD commit timestamp). Return null for fields we don't compute yet (`coveragePct`, `ciGreenRate30d`, `openIssues`, `churnScore`). Cache results in SQLite under a new `repo_telemetry` table; refresh on demand. Cache TTL: 60s for now.
4. **OperativeStore** persists operative identity at `~/.sandcastle/operatives/<id>.json` and per-repo records at `<repo>/.sandcastle/state/operatives.<id>.json`. Seed the existing `pi-default` operative on first boot if no operatives exist. Identity merge happens in the projector: `operativesById` carries identity ∪ repoRecord for the current repo.
5. **Protocol additions** (additive only, do not break Phase 0):
   - `GET /repos` → `{ repos: RegisteredRepo[] }`
   - `POST /repos` body `{ root: string }` → registers a repo, validates it has `.sandcastle/`, returns the new RegisteredRepo
   - `DELETE /repos/:id`
   - `GET /repos/:id/deck` → returns `Deck`
   - `GET /repos/:id/telemetry` → returns telemetry block from §3 above
   - `GET /operatives` → `{ operatives: OperativeIdentity[] }`
   - `GET /operatives/:id` → identity ∪ repoRecord for the current repo, or 404
   - The current `GET /fleet` keeps working but its `planetsById[*].deck` and `planetsById[*].telemetry` now come from the real loaders.
6. **Auth** unchanged: bearer token from existing handshake covers all new routes.

## Hard rules (will be checked)

- **No public API change to `@ai-hero/sandcastle`.** `npm pack --dry-run` from repo root must still list 222 files.
- **No engine source changes.** Stay in `packages/protocol/`, `packages/control-core/`, and (only for additive zod schemas / types) the protocol package.
- **Additive on the wire.** Existing routes (`POST /runs`, `POST /runs/:id/cancel`, `GET /runs/:id`, `GET /fleet`, `GET /repo`) keep responding with the same shape Phase 0 desktop expects.
- **TypeScript strict.** `npm run typecheck` from repo root must be green.
- **Filesystem safety:** mkdir-p before write, atomic write (write to tmp + rename), never silently swallow errors except for "missing optional file" cases that have explicit doc comments saying so.
- **Windows host.** Use `path.resolve` / `path.join`, not POSIX assumptions. Test paths under both `C:\Users\miyam\...` and a temp dir.
- **No commits.** Leave the working tree dirty for review.
- **Workspace deps:** `"*"`, never `workspace:*`.
- **Don't add `--no-verify`-style hook bypasses anywhere.**

## Layout to create

```
packages/protocol/src/
  state.ts              # ADD: zRegisteredRepo (id, root, addedAt, lastOpenedAt) + zRepoTelemetry alias
  api.ts                # ADD: GET/POST/DELETE /repos, GET /repos/:id/deck, /telemetry, /operatives*

packages/control-core/src/
  repos/
    RepoRegistry.ts             # EXPAND: registerRepo / removeRepo / listRepos / getCurrentRepo / setCurrentRepo
    GlobalRepoStore.ts          # NEW: persists ~/.sandcastle/repos.json (atomic writes)
  deck/
    DeckLoader.ts               # NEW: parses .sandcastle/{agents.md,skills/,commands/} → Deck
  telemetry/
    TelemetryIndexer.ts         # NEW: git age / branch / last commit / test file count
    SqliteStore.ts              # EXPAND: add repo_telemetry table + upsert/get/clear methods
  operatives/
    OperativeStore.ts           # NEW: identity at ~/.sandcastle/operatives/<id>.json, repoRecord at <repo>/.sandcastle/state/operatives.<id>.json, atomic writes, seed pi-default on first boot
  projector/
    SnapshotProjector.ts        # MODIFY: use DeckLoader/TelemetryIndexer/OperativeStore instead of synthetic stubs
  server.ts                     # ADD new routes; existing routes unchanged
```

## Tests to write (must all pass)

```
packages/control-core/test/
  repos/RepoRegistry.test.ts        # registerRepo dedupes by root, removeRepo, listRepos sort order, .sandcastle/ validation
  repos/GlobalRepoStore.test.ts     # atomic write to ~/.sandcastle/repos.json (use a tmp HOME via env override)
  deck/DeckLoader.test.ts           # valid frontmatter, missing file = empty section, malformed frontmatter = skip + warn
  telemetry/TelemetryIndexer.test.ts # against a fixture git repo (git init + a few commits in tmp); ageDays / branch / lastCommit / testCount
  operatives/OperativeStore.test.ts # seed default, identity round-trip, repoRecord round-trip, missing repoRecord returns undefined
  server.repos.test.ts              # GET/POST/DELETE /repos with bearer auth; 401 without token
  server.deck.test.ts               # GET /repos/:id/deck on a fixture repo
  server.operatives.test.ts         # GET /operatives, GET /operatives/:id 200 + 404
```

Use the existing `test/helpers.ts` pattern. For the global-store tests, override `HOME` / `USERPROFILE` to point at a tmp dir created with `mkdtemp` and torn down in `afterEach`.

## Verification you must run

- [ ] `npm run typecheck` from repo root: green
- [ ] `npm test -w @sandcastle/control-core`: all green (the existing 11 + your new ones)
- [ ] `npm test -w @sandcastle/protocol`: all 18 still green
- [ ] `npm pack --dry-run` from repo root: 222 files
- [ ] Smoke: spawn `npx tsx packages/control-core/src/cli.ts --port=0 --repo="<this-repo>"`, then with the printed token:
  - `curl -H "Authorization: Bearer <t>" http://127.0.0.1:<p>/repos` → returns at least the current repo
  - `curl -H "Authorization: Bearer <t>" http://127.0.0.1:<p>/repos/<id>/deck` → returns a Deck shape
  - `curl -H "Authorization: Bearer <t>" http://127.0.0.1:<p>/operatives` → returns `pi-default`

If smoke fails with an environment block (network/EPERM), report it; do not fudge.

## Open questions you may resolve as you see fit

1. **Repo id** — content-hash of root path, or nanoid stored in repos.json? Use nanoid + persist; saves us from path-normalization headaches across OSes.
2. **gray-matter vs custom YAML** — gray-matter is fine; it's small and zero-dep at runtime that matters.
3. **TelemetryIndexer** running git commands — use `execFile`, never `exec`, with `cwd` and a 5s timeout. Don't shell out for testCount; use `node:fs` glob.
4. **Cache TTL** — 60s is a starting point; expose a `force=true` query param on `GET /repos/:id/telemetry` for the future "Refresh" button. Implement the param, default false.
5. **OperativeStore seeding** — only seed `pi-default` if `~/.sandcastle/operatives/` is empty. Don't overwrite.

## What is OUT of scope for this dispatch

- Frontend (separate dispatch): primitives library, 5 new screens
- QuestForge parser logic (Phase 3)
- Real telemetry sources (coverage, CI, issues, churn — Phase 4)
- XP ledger (Phase 4)
- RepoRunCoordinator and worktree concurrency fix (Phase 2)
- Any change to the renderer

## Deliverable

Working tree dirty with the new + modified files, **no commits**. Report:

1. File tree of what you added/modified
2. Verification results: typecheck + each test suite + npm pack count + smoke curl outputs (or block reason)
3. Any decisions that deviate from the spec, with reason
4. Any backend issues you spotted but did not fix (we'll triage)
