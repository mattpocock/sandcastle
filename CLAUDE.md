Use `npm run typecheck` for type checking. Before you finish a change, run `npm test`, then the `verify` skill on the agent × sandbox combination it touches.

`tsc` is TypeScript 7 (the `@typescript/native` alias of `typescript@7`). The `typescript` package name is an alias of `@typescript/typescript6`, because TypeScript 7 has no JS API and tsup's declaration build still `require`s one. Don't import `typescript` in our own code, and drop the alias once tsup no longer needs it.

Check [./GLOSSARY.md](./GLOSSARY.md) for terminology questions.

For user-facing changes, add a changeset to `.changeset`. Check all changesets there first to see if there are duplicates. We use `@changesets/cli`, but you can create/edit the file manually. Make all bugfixes `patch`, all new features or breaking changes `minor` (since we're pre-1.0). Use `package.json#name` for the name.

When changing public-facing behavior, check the user docs in `docs/guide/` to see if they need updating.

## User docs

The user docs are the markdown pages in `docs/guide/`. [aihero.dev/sandcastle](https://www.aihero.dev/sandcastle) renders them as a docs site, and `README.md` links to them.

- One page per major term in `GLOSSARY.md`, at `docs/guide/<slug>.md`, with its related terms folded in. The file name is the page's URL: `docs/guide/prompts.md` is `aihero.dev/sandcastle/prompts`. The first line is the page's `# Title`, and its sections are `##` and below.
- A term page opens with a short runnable example, then the details, then a `## Related terms` list of links. It does not repeat definitions: those live on one page.
- `docs/guide/glossary.md` (last in the `Reference` group) defines each user-facing term for readers, one `## Term` entry each, in alphabetical order. It is hand-written, not copied: `GLOSSARY.md` stays the agents' source, and each entry's name must be a term `GLOSSARY.md` defines. When a term is added, renamed or changes meaning in `GLOSSARY.md`, update its entry.
- On every other guide page, the first mention of each glossary term links to its entry (`[worktrees](./glossary.md#worktree)`). A mention is the entry's name, whole word, case-insensitive, plural allowed (`-s`, `-es`, `-y` to `-ies`), outside code, headings and other links; a hyphen joins words, so `no-sandbox` is not a mention of `sandbox`, and a longer term wins, so `agent provider` is not a mention of `agent`. If a word is a mention by these rules but means something else (an interactive "prompt"), reword it.
- The `toc.json` groups follow `GLOSSARY.md`'s groups. The start page (`getting-started`) and the `Reference` group (`run`, every `RunOptions` option and result field, `cli`, and `glossary`) are not term pages. Each option is explained on its term page, and listed once in the reference.
- `docs/guide/toc.json` orders and groups the pages for the sidebar. `start` is the page a new reader opens first. `groups` lists every other page as `{ "title": "...", "pages": ["slug", ...] }`, in sidebar order.
- To add a page, write `docs/guide/<slug>.md`, add its slug to a group in `toc.json`, and link it from the Documentation list in `README.md`. Renaming or removing a page touches the same three places.
- Link between pages with relative paths (`./prompts.md#built-in-prompt-arguments`), and to other repo files relative to the page (`../adr/0010-structured-output.md`).
- `tests/docs-guide.test.ts` fails when the three drift apart: a page missing from `toc.json` or `README.md`, a listed page with no file, a page without its `# Title`, a glossary entry whose name `GLOSSARY.md` does not define, a `glossary.md#…` link anywhere in `docs/` or the README to an entry that does not exist, a first mention of a glossary term that is not linked, or a relative link to a file or a guide heading that does not exist.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `mattpocock/sandcastle`; external PRs are also a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels. Agent provider support is detailed here. See `docs/agents/triage.md`.

### Domain docs

Single-context layout: `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
