Use `npm run typecheck` for type checking. Before you finish a change, run `npm test`, then the `verify` skill on the agent × sandbox combination it touches.

`tsc` is TypeScript 7 (the `@typescript/native` alias of `typescript@7`). The `typescript` package name is an alias of `@typescript/typescript6`, because TypeScript 7 has no JS API and tsup's declaration build still `require`s one. Don't import `typescript` in our own code, and drop the alias once tsup no longer needs it.

Check [./CONTEXT.md](./CONTEXT.md) for terminology questions.

For user-facing changes, add a changeset to `.changeset`. Check all changesets there first to see if there are duplicates. We use `@changesets/cli`, but you can create/edit the file manually. Make all bugfixes `patch`, all new features or breaking changes `minor` (since we're pre-1.0). Use `package.json#name` for the name.

When changing public-facing behavior, check the user docs in `docs/guide/` to see if they need updating.

## User docs

The user docs are the markdown pages in `docs/guide/`. [aihero.dev/sandcastle](https://www.aihero.dev/sandcastle) renders them as a docs site, and `README.md` links to them.

- One page per topic, at `docs/guide/<slug>.md`. The file name is the page's URL: `docs/guide/prompts.md` is `aihero.dev/sandcastle/prompts`. The first line is the page's `# Title`, and its sections are `##` and below.
- `docs/guide/toc.json` orders and groups the pages for the sidebar. `start` is the page a new reader opens first. `groups` lists every other page as `{ "title": "...", "pages": ["slug", ...] }`, in sidebar order.
- To add a page, write `docs/guide/<slug>.md`, add its slug to a group in `toc.json`, and link it from the Documentation list in `README.md`. Renaming or removing a page touches the same three places.
- Link between pages with relative paths (`./prompts.md#structured-output`), and to other repo files relative to the page (`../adr/0010-structured-output.md`).
- `docs/guide/toc.test.ts` fails when the three drift apart: a page missing from `toc.json` or `README.md`, a listed page with no file, a page without its `# Title`, or a relative link to a file that does not exist.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `mattpocock/sandcastle`; external PRs are also a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels. Agent provider support is detailed here. See `docs/agents/triage.md`.

### Domain docs

Single-context layout: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
