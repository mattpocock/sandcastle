# Core concepts

> **Sandcastle**: The TypeScript CLI tool that orchestrates an **agent** inside a **sandbox**.

> **Sandbox**: The isolation boundary around the **agent** -- a container, VM, or similar environment that constrains the **agent**'s access.

> **Host**: The developer's machine where Sandcastle runs and the real git repo lives.

> **Agent**: The AI coding tool invoked inside the **sandbox** (e.g. Claude Code, Codex).

Sandcastle runs on the host, creates a sandbox, and invokes an agent inside it. One `run()` call does all three:

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
- [Sandbox providers](./sandbox-providers.md): how the sandbox is created. Bind-mount, native, isolated and no-sandbox providers, building and removing images, and writing your own provider.
- [Branch strategies](./branch-strategies.md): where the agent's commits land. Head, merge-to-head and branch, worktrees and `createWorktree()`, source and target branches.
- [Agent providers](./agent-providers.md): which agent runs, its options, and its `env`.
- [Agent sessions](./agent-sessions.md): capturing, resuming and forking the agent's conversation.
- [Iterations](./iterations.md): the iteration loop, the completion signal, and the completion timeout for a hanging process.
- [Structured output](./structured-output.md): a typed payload from the agent, checked against an output schema.
- [Prompts](./prompts.md): inline prompts and prompt templates, prompt arguments, built-in prompt arguments, and shell expressions.
- [Hooks](./hooks.md): commands that run on the host or in the sandbox while it starts.
- [Init](./init.md): `sandcastle init`, the config directory, issue trackers, templates and the Dockerfile.
- [Run logs](./run-logs.md): log-to-file mode, terminal mode, and agent stream events.
- Reference: [`run()` and `createSandbox()`](./run.md), every option and result field, and the [CLI commands](./cli.md).
