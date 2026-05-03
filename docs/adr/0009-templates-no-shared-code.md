# Templates do not share code

Each directory under `src/templates/<name>/` is a self-contained unit. Files inside it — `main.mts`, prompts, markdown, anything else — may only depend on the published `@ai-hero/sandcastle` package (the root export and its `./sandboxes/*` subpaths). Templates may not import from each other, from a `templates/_shared/` module, or from any internal Sandcastle source. Duplication between templates is expected and welcome.

Motivation: a template directory is the unit of distribution. `sandcastle init <template>` copies the directory verbatim into the user's `.sandcastle/`, and the result has to run with nothing but `@ai-hero/sandcastle` installed. A shared helper would either need to be inlined at copy time (complicating `init`) or promoted to a public export (growing the package's API surface to support template internals). Beyond the copy-time constraint, templates exist to demonstrate distinct orchestration shapes and are expected to drift apart over time; a shared helper becomes a junk drawer of flags as each template's needs diverge.

This ADR exists because the question recurs in PRs — e.g. a contributor proposing `import { extractPlanIssues } from "@ai-hero/sandcastle/utils"` to dedupe a `<plan>…</plan>` regex parse between `parallel-planner` and `parallel-planner-with-review`. The answer is: copy the helper into each template's `main.mts`.

## Considered Options

1. **Promote shared helpers to public exports** (`@ai-hero/sandcastle/utils`) — rejected. Grows the public API to support template internals, locks in helper signatures the wider ecosystem doesn't need, and couples templates to each other through the package.
2. **Internal `src/templates/_shared/` module bundled into `init` output** — rejected. Makes `init` a dependency-walking copy rather than a directory copy, and reintroduces the cross-template coupling that prevents free divergence.
3. **Prompt-include directive for shared markdown** (`{{include ../_shared/foo.md}}`) — rejected. Same coupling problem at the prompt layer; the existing duplication of `CODING_STANDARDS.md` between `sequential-reviewer` and `parallel-planner-with-review` is the intended shape.
4. **Each template directory is self-contained, imports only `@ai-hero/sandcastle`** (chosen). One-line rule, easy to apply on review, keeps `init` a pure directory copy, and lets each template evolve independently.

## Consequences

- New helpers used by more than one template are copied into each template's `main.mts`, not extracted.
- Shared markdown (e.g. coding standards) is duplicated per template, not referenced.
- Public exports are added for end-user use cases, never to satisfy a template's internal needs.
- `sandcastle init <template>` remains a verbatim copy of `src/templates/<name>/` — no dependency resolution, no inlining step.
