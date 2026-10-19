---
"@ai-hero/sandcastle": minor
---

**BREAKING:** `run()` is now one-shot, and the iteration loop moves to a new `runMany()` (#562).

- `run()` runs the agent exactly once. It no longer accepts `maxIterations` or `completionSignal`, and returns a flat result: `sessionId`, `sessionFilePath`, `usage`, `stdout`, `commits`, `branch`, `output?`, `resume`, `fork` — no `iterations[]`, no `completionSignal`. Structured `output` and `resumeSession` are `run()`-only.
- `runMany()` is the old looping `run()`, unchanged: `maxIterations` (default `1`), `completionSignal` (default `<promise>COMPLETE</promise>`), `completionTimeoutSeconds`, and a result with `iterations[]` + `completionSignal`. Its `.resume()` / `.fork()` return a one-shot `RunResult`.
- The same split applies to `createSandbox()` (`sandbox.run()` / `sandbox.runMany()`) and `createWorktree()` (`wt.run()` / `wt.runMany()`).
- Hang protection (completion timeout): `runMany()` still arms it on the completion signal. `run()` with `output` now arms it on the output's closing tag (e.g. `</plan>`). `run()` without `output`, `sandbox.run()` and `wt.run()` have no completion marker — if you relied on `<promise>COMPLETE</promise>` to force-complete a hanging one-shot agent, call `runMany()` instead (it defaults to one iteration).
- `run()` throws if passed `maxIterations` / `completionSignal`, and `runMany()` throws if passed `output` / `resumeSession`, so untyped callers fail loudly instead of silently changing behaviour.
- Templates updated: looping phases use `runMany()`; one-shot prompts no longer ask the agent to emit `<promise>COMPLETE</promise>`.

Migration — any call that loops is a rename; one-shot calls read session fields off the top level:

```diff
- import { run } from "@ai-hero/sandcastle";
- const r = await run({ agent, sandbox, promptFile, maxIterations: 10 });
+ import { runMany } from "@ai-hero/sandcastle";
+ const r = await runMany({ agent, sandbox, promptFile, maxIterations: 10 });
  console.log(r.iterations.length, r.completionSignal);

- const implement = await sandbox.run({ agent, promptFile, maxIterations: 100 });
+ const implement = await sandbox.runMany({ agent, promptFile, maxIterations: 100 });

  const plan = await run({ agent, sandbox, prompt, output });
- const sessionId = plan.iterations.at(-1)?.sessionId;
+ const sessionId = plan.sessionId;
```
