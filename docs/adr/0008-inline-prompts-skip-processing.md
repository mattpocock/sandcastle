# Inline prompts pass through to the agent literally

Prompts passed as `prompt: "..."` (inline prompts) are delivered to the agent verbatim — no prompt argument substitution, no prompt expansion, no built-in `{{SOURCE_BRANCH}}` / `{{TARGET_BRANCH}}` injection. Only prompt templates sourced via `promptFile` go through the `{{KEY}}` and `` !`command` `` pipeline.

Motivation: issue #453. Callers that build inline prompts programmatically often embed arbitrary content (GitHub issue bodies, PR descriptions, forwarded transcripts) that may coincidentally contain `{{...}}`. Running the substitution scanner on that content produced hard failures like `Prompt argument "{{BRANCH}}" has no matching value in promptArgs`, forcing callers to duplicate Sandcastle's regex to pre-escape their own content.

## Considered Options

1. **Opt-out flag** (`run({ interpolate: false })`) — rejected. Adds a boolean users must remember; inline prompts always want the same behavior.
2. **Lenient mode when `promptArgs` is absent** — rejected. Subtle coupling: adding `promptArgs: {}` changes scanning behavior. The rule should depend on the prompt source, not adjacent options.
3. **Escape syntax for literal `{{`** — rejected. Still requires the caller to know which bytes need escaping in forwarded content.
4. **Rule: inline = literal, template = processed** (chosen). The distinction follows the source: if you constructed the string in JS, you own interpolation; if you wrote a template file, Sandcastle processes it.

## Consequences

- `run({ prompt, promptArgs })` is an error — `promptArgs` only applies to templates. Empty `promptArgs: {}` is treated as absent.
- Inline prompts that want branch context must interpolate in JS (`` `Work on ${branch}...` ``) rather than relying on built-in args.
- `interactive()` skips the "prompt user for missing `{{KEY}}`" flow for inline prompts.

## Amendment — `interactive()` removed (2026-10-30)

`interactive()` was removed by [ADR 0021](0021-remove-interactive.md), and with it the prompt-fill flow for missing `{{KEY}}`s. The inline-is-literal rule is unchanged.
