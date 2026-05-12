# `.resume()` is exactly one iteration

A `.resume()` call on a `RunResult` always performs exactly one **iteration**. It does not accept a `maxIterations` greater than 1, and it does not loop internally. Callers that want multi-step continuation chain `.resume()` calls themselves.

This mirrors today's constraint that `resumeSession` is incompatible with `maxIterations > 1` (`src/run.ts:321`).

Motivation: each iteration produces its own **agent session** — its own JSONL, its own session ID. "Resume from session X and run 5 iterations" is therefore semantically ambiguous: iteration 2 could resume session X (the original) or the new session that iteration 1 just produced. Neither answer is universally correct, and there is no third coherent option without redesigning the iteration/session model.

## Considered Options

1. **Lift the constraint and chain session IDs across iterations** — rejected. Requires the orchestrator to capture the session ID from each iteration and feed it to the next, and forces a non-obvious choice on which session subsequent iterations should resume from. A real design problem in its own right; out of scope for `.resume()`'s "helper over current behavior" framing.
2. **`.resume()` defaults to `maxIterations: 1` but allows callers to pass higher values, raising the same error today's `resumeSession` raises** — rejected as user-hostile. The error tells the user something is wrong without a clear path forward.
3. **`.resume()` is exactly one iteration; `maxIterations` is not part of its option object** (chosen). Locks the constraint into the API shape rather than the validation layer. Multi-step workflows are expressed by chaining `.resume()` calls, which makes the session boundary at each step explicit.

## Consequences

- `.resume()` does not accept a `maxIterations` option. Callers wanting iteration loops use `run()` (which supports `maxIterations`) or chain `.resume()` calls in their own loop.
- The existing `resumeSession + maxIterations > 1` runtime check in `run.ts` stays — `.resume()` is sugar over that path, and the constraint there is upheld for the same reason.
- Adding multi-iteration resume later would be a feature addition (probably its own option, with explicit semantics on which session each iteration resumes from), not a constraint relaxation.
