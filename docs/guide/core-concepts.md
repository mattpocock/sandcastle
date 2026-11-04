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

You choose the agent by passing an [agent provider](./glossary.md#agent-provider): a function, such as `claudeCode()` or `codex()`, that knows how to start that one kind of agent and read what it prints. The sandbox works the same way, through the [sandbox provider](./glossary.md#sandbox-provider) you pass as `sandbox`.

The agent works from a [prompt](./glossary.md#prompt): the instructions it gets each time it starts. Here `promptFile` reads them from a file in your repo, but a plain string works too.

One pass of the agent, from start to exit, is an [iteration](./glossary.md#iteration): Sandcastle starts it, lets it work on one piece of work, and collects the commits it made. A run takes one iteration unless you raise `maxIterations`, and `result.iterations` holds one entry for each.

Where those commits land is up to the [branch strategy](./glossary.md#branch-strategy). Some strategies give the agent a [worktree](./glossary.md#worktree): a second checkout of your repo, on its own branch, so the agent never touches the files you have open.

## Map of the docs

Each page below covers one term from the glossary, with the terms around it folded in.

- [Getting started](./getting-started.md): prerequisites and a quick start.
- [Sandbox providers](./sandbox-providers.md): which kind of sandbox to use (a container, your OS's own process sandbox, a cloud VM, or a [no-sandbox provider](./glossary.md#no-sandbox-provider), which runs the agent straight on your host with no sandbox at all), building and removing images, and writing your own provider.
- [Branch strategies](./branch-strategies.md): where the agent's commits land, `createWorktree()`, and which branch Sandcastle merges into.
- [Agent providers](./agent-providers.md): which agent runs, its options, and its `env`.
- [Agent sessions](./agent-sessions.md): capturing, resuming and forking the agent's conversation.
- [Iterations](./iterations.md): the loop, how the agent says it is done, and what happens when its process won't exit.
- [Structured output](./structured-output.md): getting a typed answer back from the agent, checked against a schema.
- [Prompts](./prompts.md): a prompt as a string or a file, filling in placeholders, and running shell commands inside it.
- [Hooks](./hooks.md): commands that run on the host or in the sandbox while it starts.
- [Init](./init.md): `sandcastle init`, the files it scaffolds, where the agent finds its work, and the Dockerfile.
- [Run logs](./run-logs.md): showing progress in the terminal or writing it to a log file, and receiving the agent's output as it runs.
- Reference: [`run()` and `createSandbox()`](./run.md), every option and result field, and the [CLI commands](./cli.md).
