# Structured output is orthogonal to the completion signal

`run()` accepts an optional `output: Output.object({ tag, schema })` (Standard Schema) that scans the agent's stdout for the configured XML tag and returns a typed, validated payload on `RunResult`. The signature is overloaded: passing `output` narrows the return type so `output: T` is non-optional.

Structured output is a separate domain concept from the **completion signal**. The completion signal (`<promise>COMPLETE</promise>`) is a pure termination marker carrying no payload; structured output is a payload mechanism that does not, on its own, terminate anything. A run can use either, both, or neither.

## Constraints

- **`maxIterations === 1` only.** `run()` throws at entry if `output` is set and `maxIterations !== 1`. The current iteration/completion-signal API is expected to split off `run()` in future; restricting structured output to single-shot runs from day one keeps those users out of that future blast radius. (See the deferred-work issue tracking the split.)
- **Caller owns the prompt-side instruction.** Sandcastle does not inject any text describing the expected tag or schema. `run()` throws at entry if the resolved prompt does not contain the configured opening tag — early protection against misconfiguration.
- **Throw on failure.** Missing tag, invalid JSON, or schema validation failure throws a `StructuredOutputError` carrying `tag`, `rawMatched`, `cause`, `commits`, `branch`, and `preservedWorktreePath?`. No auto-cleanup of worktree or branch — the caller decides recovery.
- **Last match wins** when the tag occurs multiple times in stdout. Self-correction by the agent is the realistic case, and end-first scanning matches how `Orchestrator.ts` already locates the completion signal.
- **Fence-aware extraction.** The contents of the tag are stripped of leading/trailing whitespace and unwrapped from an optional ` ```json ... ``` ` (or bare ` ``` ... ``` `) fence before `JSON.parse`. No other tolerance — invalid JSON throws.
- **`run()` only.** Not available on `interactive()` or `wt.interactive()`; type-level exclusion, no runtime guard needed.

## Considered Options

1. **Generalize the completion signal** to optionally carry a JSON payload (single concept, two modes) — rejected. Conflates "are we done?" with "what did the agent produce?". Forces awkward semantics later.
2. **New top-level `generate()` function** with its own slim result type — rejected. The constraint that structured output is `maxIterations === 1` only already implies "one-shot semantics"; a parallel function duplicates 90% of `RunOptions` and creates two entry points users must choose between. The eventual loop/iteration API split (deferred) is a cleaner moment to introduce a new function.
3. **Auto-inject prompt instructions** describing the tag (and optionally a JSON-Schema serialisation) — rejected. Prompts are caller-owned and ADR-0008 already protects inline prompts from preprocessing; the tag is a simple, learnable convention, and forcing the caller to write the instruction makes the contract explicit.
4. **Tolerant JSON parsing** (trailing commas, comments, single quotes via a JSONC-style parser) — rejected. Hides genuine model failures behind a forgiving parser, then breaks downstream at schema time. Loud is better.
5. **First-match-wins** or **throw on multiple matches** — rejected. Self-correction (agent drafts then revises) is benign and frequent; both alternatives punish it.
6. **Discriminated-union return** (`output: { ok: true; value } | { ok: false; error }`) instead of throwing — rejected. Inconsistent with the rest of `run()`'s error model and makes the happy-path type harder to consume.
7. **Plain object literal** (`output: { tag, schema }`) instead of an `Output.*` helper namespace — rejected. The helper namespace leaves room for `Output.string`, `Output.array`, etc., gives the value an internal brand the overload typing can discriminate on, and matches AI SDK precedent users will recognise.

## Consequences

- `Output` is exported from the package root with `Output.object({ tag, schema })` as the v1 entry. Future siblings (`Output.string`, `Output.array`) share the same XML-tag plumbing.
- `RunResult` gains a typed `output: T` field _only_ when the overloaded form is used; the non-output form is unchanged.
- Two new entry-time validations on `run()`: (1) `output` set with `maxIterations !== 1` throws; (2) `output` set with the tag absent from the resolved prompt throws.
- `StructuredOutputError` is a new public error type; callers can `instanceof`-narrow to recover.
- The completion signal mechanism in `Orchestrator.ts` is unchanged. Structured-output extraction is a separate pass over the same stdout.
