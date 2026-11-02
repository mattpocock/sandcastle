# Core concepts

Sandcastle runs on the [host](./glossary.md#host), creates a [sandbox](./glossary.md#sandbox), and invokes an [agent](./glossary.md#agent) inside it. One `run()` call does all three:

```typescript
import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const result = await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  promptFile: ".sandcastle/prompt.md",
});

console.log(result.iterations.length); // number of iterations executed
console.log(result.iterations); // per-iteration results with optional sessionId
console.log(result.commits); // array of { sha } for commits created
console.log(result.branch); // target branch name
```

## Map of the docs

Each page below covers one term from the glossary, with the terms around it folded in.

- [Getting started](./getting-started.md): prerequisites and a quick start.
- [Sandbox providers](./sandbox-providers.md): how the sandbox is created. Bind-mount, native, isolated and [no-sandbox providers](./glossary.md#no-sandbox-provider), building and removing images, and writing your own provider.
- [Branch strategies](./branch-strategies.md): where the agent's commits land. Head, merge-to-head and branch, [worktrees](./glossary.md#worktree) and `createWorktree()`, source and [target branches](./glossary.md#target-branch).
- [Agent providers](./agent-providers.md): which agent runs, its options, and its `env`.
- [Agent sessions](./agent-sessions.md): capturing, resuming and forking the agent's conversation.
- [Iterations](./iterations.md): the [iteration](./glossary.md#iteration) loop, the [completion signal](./glossary.md#completion-signal), and the [completion timeout](./glossary.md#completion-timeout) for a [hanging process](./glossary.md#hanging-process).
- [Structured output](./structured-output.md): a typed payload from the agent, checked against an [output schema](./glossary.md#output-schema).
- [Prompts](./prompts.md): [inline prompts](./glossary.md#inline-prompt) and [prompt templates](./glossary.md#prompt-template), [prompt arguments](./glossary.md#prompt-argument), [built-in prompt arguments](./glossary.md#built-in-prompt-argument), and [shell expressions](./glossary.md#shell-expression).
- [Hooks](./hooks.md): commands that run on the host or in the sandbox while it starts.
- [Init](./init.md): `sandcastle init`, the [config directory](./glossary.md#config-directory), [issue trackers](./glossary.md#issue-tracker), templates and the Dockerfile.
- [Run logs](./run-logs.md): [log-to-file mode](./glossary.md#log-to-file-mode), [terminal mode](./glossary.md#terminal-mode), and [agent stream events](./glossary.md#agent-stream-event).
- Reference: [`run()` and `createSandbox()`](./run.md), every option and result field, and the [CLI commands](./cli.md).
