Use `npm run typecheck` for type checking. Before you finish a change, run `npm test`, then the `verify` skill on the agent × sandbox combination it touches.

`tsc` is TypeScript 7 (the `@typescript/native` alias of `typescript@7`). The `typescript` package name is an alias of `@typescript/typescript6`, because TypeScript 7 has no JS API and tsup's declaration build still `require`s one. Don't import `typescript` in our own code, and drop the alias once tsup no longer needs it.

Check [./GLOSSARY.md](./GLOSSARY.md) for terminology questions.

For user-facing changes, add a changeset to `.changeset`. Check all changesets there first to see if there are duplicates. We use `@changesets/cli`, but you can create/edit the file manually. Make all bugfixes `patch`, all new features or breaking changes `minor` (since we're pre-1.0). Use `package.json#name` for the name.

When changing public-facing behavior, check the user docs in `docs/guide/` to see if they need updating.

## User docs

The user docs are the markdown pages in `docs/guide/`. [aihero.dev/sandcastle](https://www.aihero.dev/sandcastle) renders them as a docs site, and `README.md` links to them.

- One page per major term in `GLOSSARY.md`, at `docs/guide/<slug>.md`, with its related terms folded in. The file name is the page's URL: `docs/guide/prompts.md` is `aihero.dev/sandcastle/prompts`. The first line is the page's `# Title`, and its sections are `##` and below.
- A term page opens with its terms' definitions, one blockquote each, copied word for word from `GLOSSARY.md` (`> **Term**: definition`). Then a short runnable example, then the details, then a `## Related terms` list of links. When a definition changes in `GLOSSARY.md`, change it on the page too.
- The `toc.json` groups follow the glossary's groups. The start page (`getting-started`) and the `Reference` group (`run`, every `RunOptions` option and result field, and `cli`) are not term pages. Each option is explained on its term page, and listed once in the reference.
- `docs/guide/toc.json` orders and groups the pages for the sidebar. `start` is the page a new reader opens first. `groups` lists every other page as `{ "title": "...", "pages": ["slug", ...] }`, in sidebar order.
- To add a page, write `docs/guide/<slug>.md`, add its slug to a group in `toc.json`, and link it from the Documentation list in `README.md`. Renaming or removing a page touches the same three places.
- Link between pages with relative paths (`./prompts.md#built-in-prompt-arguments`), and to other repo files relative to the page (`../adr/0010-structured-output.md`).
- `tests/docs-guide.test.ts` fails when the three drift apart: a page missing from `toc.json` or `README.md`, a listed page with no file, a page without its `# Title`, a term page whose opening definitions are missing or differ from `GLOSSARY.md`, or a relative link to a file or a guide heading that does not exist.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `mattpocock/sandcastle`; external PRs are also a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels. Agent provider support is detailed here. See `docs/agents/triage.md`.

### Domain docs

Single-context layout: `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
