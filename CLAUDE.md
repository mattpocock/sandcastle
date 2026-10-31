Use `npm run typecheck` for type checking. Before you finish a change, run `npm test`, then the `verify` skill on the agent × sandbox combination it touches.

`tsc` is TypeScript 7 (the `@typescript/native` alias of `typescript@7`). The `typescript` package name is an alias of `@typescript/typescript6`, because TypeScript 7 has no JS API and tsup's declaration build still `require`s one. Don't import `typescript` in our own code, and drop the alias once tsup no longer needs it.

Check [./CONTEXT.md](./CONTEXT.md) for terminology questions.

For user-facing changes, add a changeset to `.changeset`. Check all changesets there first to see if there are duplicates. We use `@changesets/cli`, but you can create/edit the file manually. Make all bugfixes `patch`, all new features or breaking changes `minor` (since we're pre-1.0). Use `package.json#name` for the name.

When changing public-facing behavior, check `README.md` to see if the documentation needs updating.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `mattpocock/sandcastle`; external PRs are also a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels. Agent provider support is detailed here. See `docs/agents/triage.md`.

### Domain docs

Single-context layout: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
