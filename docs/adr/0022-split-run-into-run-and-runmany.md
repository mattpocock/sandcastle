# Split `run()` into one-shot `run()` and looping `runMany()`

Resolves the deferred design tracked in issue #562 (grill session 2026-05-29). `run()` used to carry two jobs: a one-shot agent invocation (optionally with structured output) and an iterate-until-signal-or-cap loop. They now have separate entry points:

- **`run()`** — exactly one **iteration**. No `maxIterations`, no `completionSignal`. Returns a slim, flat `RunResult` (`sessionId`, `sessionFilePath`, `usage`, `stdout`, `commits`, `branch`, `logFilePath`, `preservedWorktreePath`, `output?`, `resume`, `fork`). Accepts `output` and `resumeSession`.
- **`runMany()`** — the pre-split loop, unchanged: `maxIterations` (default `1`), `completionSignal` (default `<promise>COMPLETE</promise>`), `completionTimeoutSeconds`. Returns the fat `RunManyResult` (`iterations[]`, `completionSignal?`, …). Does not accept `output` or `resumeSession`.

The split is mirrored on `createSandbox()` (`sandbox.run()` / `sandbox.runMany()`) and `createWorktree()` (`wt.run()` / `wt.runMany()`). `interactive()` and `wt.interactive()` are untouched.

## Decisions

1. **Neither wraps the other.** Both are thin adapters over the internal `orchestrate()` Effect — `iterations: 1` and no signal vs. `iterations: N` and the signal. `run()` flattens the single `IterationResult` onto its result; `runMany()` returns the orchestrator result essentially as-is.
2. **`output` and `resumeSession` are structurally `run()`-only.** The old `output + maxIterations !== 1` and `resumeSession + maxIterations > 1` runtime guards are deleted: the combinations are now unrepresentable in the types. This retroactively justifies [ADR 0010](0010-structured-output.md)'s `maxIterations === 1` forcing function.
3. **`.resume()` / `.fork()` live on both result types and always return a one-shot `RunResult`**, continuing the last captured session (iteration N's, for `runMany()`). This is [ADR 0011](0011-resume-is-one-iteration.md) made structural: resume is always `run`-shaped regardless of what produced the result.
4. **`run()` has no completion signal**, so it neither reports one nor expects prompts to emit one. Templates that use one-shot `run()` drop the `<promise>COMPLETE</promise>` instruction. Hang protection for `run()` moves to the output closing tag — see [ADR 0021](0021-run-completion-timeout-on-output-closing-tag.md).
5. **`runMany()`'s `maxIterations` defaults to `1`**, as `run()`'s did. Chosen so migration is a mechanical rename: any pre-split `run({ maxIterations, completionSignal, … })` call becomes `runMany({ … })` with identical behaviour, including calls that relied on the default.
6. **Hard cut, pre-1.0.** Shipped as a breaking `minor`, no deprecation window. To stop an untyped (JS / spread / `as any`) looping call from silently degrading into a one-shot run, `run()` throws a migration error when it receives `maxIterations` or `completionSignal`, and `runMany()` throws on `output` or `resumeSession`. These are migration aids, not constraints the types fail to express.

## Considered options

- **`runMany()` wraps `run()` in a loop** (or vice versa) — rejected in #562: the shared primitive already exists one level down (`orchestrate()`, whose `withSandbox` is per-iteration), and wrapping would either re-implement the loop or force the slim result to carry loop bookkeeping.
- **`runMany()` requires `maxIterations`, or defaults it above 1** — rejected: it turns the migration from a rename into a rename-plus-edit for calls that relied on the default.
- **Keep `run({ maxIterations })` working with a deprecation warning** — rejected: pre-1.0, and keeping it means `run()`'s result type can't be flattened.
- **Name it `runLoop()`** — maintainer preferred `runMany()`.

## Consequences

- Every looping caller must rename `run` → `runMany` (and `sandbox.run` / `wt.run` likewise). Every one-shot caller that read `result.iterations[0].x` reads `result.x`.
- `StructuredOutputError`'s `sessionId` / `sessionFilePath` now come from the flat result.
- `run()`'s log no longer prints "Max iterations" or "without completion signal"; it prints `Run complete.`
