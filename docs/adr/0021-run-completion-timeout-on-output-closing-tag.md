# One-shot `run()` arms the completion timeout on the output closing tag

Amends [ADR 0019](0019-completion-timeout-for-hanging-process.md), which armed the **completion timeout** on the **completion signal**. After the `run()`/`runMany()` split ([ADR 0022](0022-split-run-into-run-and-runmany.md)), a **one-shot run** has no completion signal, so 0019's trigger no longer exists for it. We now arm the grace window on a per-entry-point **completion marker**:

| Entry point                                           | Completion marker                                        |
| ----------------------------------------------------- | -------------------------------------------------------- |
| `runMany()` / `sandbox.runMany()` / `wt.runMany()`    | The completion signal — unchanged from ADR 0019          |
| `run()` with `output`                                 | The closing tag of the output block (`</${output.tag}>`) |
| `run()` without `output`, `sandbox.run()`, `wt.run()` | **None**                                                 |

Mechanically the orchestrator gains a `completionTimeoutTriggers` option (defaulting to the completion signals); `run()` passes `completionSignal: []` and `completionTimeoutTriggers: [`</tag>`]` (or `[]`). The scan, the silence-based reset and the success-with-warning outcome are exactly ADR 0019's.

## Why the closing tag

It is the one in-band, already-caller-configured marker that means "the agent has produced what this run exists to produce". Once `</tag>` is in the buffer the structured-output payload is complete — 0019's concern that a payload might trail the marker disappears, because the marker _is_ the end of the payload. A process still holding stdout open after that is, by definition, a **hanging process**. It also replaces a workaround: this repo's own `runWithExtraction` set `completionSignal: "</tag>"` on its extraction `run()` purely to get hang protection.

## Considered alternatives

- **Keep watching for `<promise>COMPLETE</promise>` in one-shot `run()`.** Rejected (maintainer's call): it reintroduces the completion signal into the one-shot API that the split removes, and keeps telling one-shot agents to emit a marker nothing else listens for.
- **Opening tag (`<tag>`) as the marker.** Rejected: the payload is still streaming; a long JSON body with a slow token rate could be cut off.
- **A new trigger for `run()` without `output`** (terminal stream event, process-tree inspection, explicit kill). Rejected for now — ADR 0019 already explains why no reliable cross-provider terminal event exists. Out of scope.

## Consequences

- **Known gap:** a one-shot `run()` without `output` (and every `sandbox.run()` / `wt.run()`, which don't support `output`) has **no hang protection**. A hanging process rides the full idle timeout and fails with `AgentIdleTimeoutError`, discarding the run's result — exactly the pre-0019 behaviour. Callers who need protection there can call `runMany()` (one iteration by default) and have the prompt emit the completion signal. `completionTimeoutSeconds` is therefore not offered on `sandbox.run()` / `wt.run()`.
- If an agent mentions the literal closing tag mid-work (e.g. quoting the prompt) and then goes silent for longer than the window, the run is force-completed early. The same risk existed for the completion signal under 0019; the reset-on-output behaviour bounds it to genuinely silent periods.
- With `output.maxRetries`, every retry is itself a `run()` with `output`, so retries are protected the same way.
