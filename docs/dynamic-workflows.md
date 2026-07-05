# Dynamic Workflows

Dynamic workflows are TypeScript-first orchestration files for running several Sandcastle agent calls as one durable run. They are meant for autonomous agents and CI-style control surfaces, not for a human wizard.

A workflow file default-exports a `WorkflowDefinition` with three parts:

```ts
export default {
  meta: { name: "my-workflow" },
  defaults: {
    provider: "codex",
    model: "gpt-5.5",
    sandbox: "docker",
    maxConcurrency: 3,
    maxAgents: 10,
    branchPrefix: "sandcastle/workflow",
  },
  async run(ctx) {
    await ctx.phase("work");
    return ctx.agent.run("Do the bounded task", { label: "bounded-task" });
  },
};
```

## When to use a workflow

Use a dynamic workflow when the task needs more structure than one agent prompt:

- fan out independent agent reviews and reduce them into one report;
- run adversarial or second-opinion review loops;
- preserve resumable journal state across long agent runs;
- expose a repeatable agent-operated runbook with bounded concurrency and agent caps.

Do not use a workflow when one `run()` call is enough, when the job needs interactive human decisions every few minutes, or when the desired action would auto-merge, push, deploy, publish, buy, or message external parties without an explicit host policy allowing it.

## Workflow context

The runtime injects a restricted `ctx` object:

| Field          | Purpose                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| `ctx.args`     | Parsed JSON args from `workflow run --args`.                                                                 |
| `ctx.agent`    | Run one Sandcastle-backed agent call and return a structured envelope.                                       |
| `ctx.parallel` | Run local thunks or agent calls under the workflow scheduler.                                                |
| `ctx.pipeline` | Run ordered local workflow stages.                                                                           |
| `ctx.phase`    | Set the current phase and emit phase events.                                                                 |
| `ctx.log`      | Emit structured workflow log events.                                                                         |
| `ctx.validate` | Validate JSON-like values against a JSON Schema subset.                                                      |
| `ctx.quality`  | Helper stdlib for retry, dry loops, judge panels, verification agents, completeness checks, and checkpoints. |
| `ctx.workflow` | Current run metadata plus cooperative stop hook.                                                             |
| `ctx.budget`   | Agent count, max-agent cap, concurrency, and remaining-agent helpers.                                        |

Workflow source files may use type-only imports, but runtime imports, dynamic imports, `require`, direct filesystem access, process access, network globals, `eval`, and `Function` are blocked by the loader.

## Branch and worktree policy

Every mutating `ctx.agent()` call gets a deterministic branch name:

```text
<branchPrefix>/<run-id>/<call-index>-<label-slug>
```

The workflow file declares desired defaults, but the host enforces hard ceilings for provider, model, sandbox, concurrency, max agents, and skill allowlists. Direct-to-HEAD workflow execution is not part of the dynamic workflow safety model.

## Run directory layout

Runs are stored under:

```text
.sandcastle/runs/<run-id>/
```

Important files:

- `state.json` — current run status, phase, counters, result/error metadata;
- `events.jsonl` — workflow events such as phases, logs, agents, pause/stop, and replay;
- `journal.jsonl` — deterministic agent call identities and replay metadata;
- `source.workflow.ts` — captured workflow source;
- `result.json` — final workflow result when available;
- `control.json` — cooperative stop/pause requests;
- `agents/<call-id>/` — prompt, stdout, result, and run artifacts for each agent call.

## CLI

Validate without running agents:

```bash
sandcastle workflow validate examples/workflows/fan-out-reduce.workflow.ts --json
```

Run with JSON args and machine-readable output:

```bash
sandcastle workflow run examples/workflows/fan-out-reduce.workflow.ts \
  --args '{"items":["api","worker","docs"]}' \
  --json
```

Override host policy for a run when needed:

```bash
sandcastle workflow run examples/workflows/codebase-audit.workflow.ts \
  --provider codex \
  --model gpt-5.5 \
  --sandbox docker \
  --concurrency 3 \
  --max-agents 10 \
  --branch-prefix sandcastle/workflow \
  --json
```

Request cooperative control:

```bash
sandcastle workflow stop <run-id> --json
sandcastle workflow pause <run-id> --json
```

`stop` durably records `stopping` in `state.json` when the state exists, aborts active agent work when practical, rejects queued work, waits for active scheduler work to settle, then records `stopped`. `pause` rejects queued work and waits for active scheduled work to settle before recording `paused`; it does not forcibly kill active work.

## Resume semantics

Resume reuses successful deterministic agent calls from an earlier run:

```ts
await runWorkflow({
  sourceFile: "examples/workflows/fan-out-reduce.workflow.ts",
  resume: { fromRunId: "20260705-010000-fan-out-reduce-a1b2c3d4" },
});
```

Replay only happens while the next call index and stable call hash match a prior succeeded journal entry. A changed source hash, prompt, phase, label, provider/model/sandbox options, selected skills, schema, timeout, retry, or completion signal disables replay from that call onward. Replayed calls emit `agent_replayed` events and journal entries with `status: "skipped"`.

## Examples

- `examples/workflows/fan-out-reduce.workflow.ts` — review several independent items in parallel, then reduce findings.
- `examples/workflows/adversarial-review.workflow.ts` — compare adversarial perspectives and verify the response plan.
- `examples/workflows/codebase-audit.workflow.ts` — audit codebase areas with retry and skill selection.

## Safety model

Dynamic workflows are intentionally conservative:

- no auto-merge, push, deploy, publish, purchase, or outbound messaging unless a host policy and prompt explicitly allow it;
- no separate workflow config file — the workflow source declares intent and the host enforces policy;
- workflow validation is machine-readable and repair-friendly;
- dirty worktrees are preserved rather than silently overwritten;
- run artifacts are kept for audit and replay;
- generated or model-authored workflow files should pass `workflow validate --json` before `workflow run`.
