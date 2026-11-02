# Iterations

> **Iteration**: A single invocation of the **agent** inside the **sandbox**, producing at most one commit against one **task**.

> **Completion signal**: The `<promise>COMPLETE</promise>` marker in the **agent**'s output indicating all actionable tasks are finished. A pure termination signal -- carries no payload. Distinct from **structured output**.

> **Completion timeout**: A silence-based grace window that takes over from the **idle timeout** once a **completion signal** is detected in the **agent**'s output. Reset by every subsequent output line so trailing data (token-usage events, terminal `result` events, **structured output** tags emitted after the signal) is still captured. On expiry the run resolves **successfully** with a warning that the process is hanging -- in contrast to **idle timeout** expiry, which fails the run. Configured via `completionTimeoutSeconds`; default 60 seconds. Independent of `idleTimeoutSeconds` -- they cover different phases.

> **Hanging process**: An **agent** invocation that has emitted its **completion signal** but whose underlying process has not exited (typically because a spawned child -- a `gh`/git subprocess or long-lived MCP server -- inherited the exec's stdout pipe and is keeping it open). The signal is visible in the buffered stream; only EOF is missing. Resolved by the **completion timeout** rather than waiting out the full **idle timeout**. Distinct from a genuinely stuck **agent**, which has produced no output at all.

`maxIterations` sets how many iterations `run()` may run (default `1`). The loop stops sooner when the agent emits the completion signal:

```typescript
import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const result = await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  promptFile: ".sandcastle/prompt.md",
  maxIterations: 5,
});

console.log(result.iterations.length); // number of iterations executed
console.log(result.completionSignal); // matched signal string, or undefined if none fired
```

## Early termination with `<promise>COMPLETE</promise>`

When the agent outputs `<promise>COMPLETE</promise>`, the orchestrator stops the iteration loop early. This is a convention you document in your prompt for the agent to follow — the engine never injects it.

This is useful for task-based workflows where the agent should stop once it has finished, rather than running all remaining iterations.

You can override the default signal by passing `completionSignal` to `run()`. It accepts a single string or an array of strings:

```ts
await run({
  // ...
  completionSignal: "DONE",
});

// Or pass multiple signals — the loop stops on the first match:
await run({
  // ...
  completionSignal: ["TASK_COMPLETE", "TASK_ABORTED"],
});
```

Tell the agent to output your chosen string(s) in the prompt, and the orchestrator will stop when it detects any of them. The matched signal is returned as `result.completionSignal`.

## Hanging processes after the completion signal

The agent process is expected to exit shortly after emitting the completion signal. When a child it spawned — a `gh`/git subprocess, a long-lived MCP server, etc. — inherits the agent's stdout pipe and keeps it open, the parent process can linger long past its logical end. Sandcastle would otherwise wait for the full `idleTimeoutSeconds` and fail with `AgentIdleTimeoutError`, throwing away the commits the agent already made.

Instead, once the completion signal is observed in the output buffer, Sandcastle swaps in a short **completion timeout** (default 60 s). When it expires, the run resolves successfully with a warning that the process was hanging; `result.commits` and `result.completionSignal` are populated as if the process had exited cleanly. The timer resets on every subsequent output line, so trailing data emitted after the signal — token-usage events, terminal `result` events, a structured-output `<tag>` — is still captured.

A clean process exit always wins the race, so healthy runs gain zero added latency. The completion timeout only matters when the process hangs.

Tune the window with `completionTimeoutSeconds`:

```ts
await run({
  // ...
  completionTimeoutSeconds: 30, // shorter grace window
});
```

This is independent of `idleTimeoutSeconds`. They cover different phases: `idleTimeoutSeconds` runs **before** any signal is seen (genuinely stuck agent → fail); `completionTimeoutSeconds` runs **after** the signal is seen (hanging process → succeed with warning). See [ADR 0019](../adr/0019-completion-timeout-for-hanging-process.md).

## Related terms

- [Prompts](./prompts.md): the prompt each iteration starts with
- [Init](./init.md): the issue tracker that iterations take tasks from
- [Structured output](./structured-output.md): the other way for an agent to report back, independent of the completion signal
- [Agent sessions](./agent-sessions.md): each iteration's session
- [`run()` reference](./run.md#iterationresult): `IterationResult`, `IterationUsage` and `ContextWindow`
