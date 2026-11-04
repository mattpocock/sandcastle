# Glossary

The words these docs use, one entry each, in alphabetical order. Each guide page links a term to its entry the first time it mentions it.

## Agent

The AI coding tool Sandcastle runs for you, such as Claude Code or Codex. It runs inside a [sandbox](#sandbox), and you can swap one agent for another. See [Core concepts](./core-concepts.md).

First explained in [Getting started](./getting-started.md).

## Agent provider

The function that tells Sandcastle how to run one kind of [agent](#agent): `claudeCode()`, `codex()`, `pi()` and the rest. You pass it to `run()` as the `agent` option. See [Agent providers](./agent-providers.md).

First explained in [Core concepts](./core-concepts.md).

## Agent session

The agent's own record of a conversation, which Sandcastle captures after each [iteration](#iteration). The [agent provider](#agent-provider) decides where it lives, for example `~/.claude/projects/` for Claude Code. You can [resume](#session-resume) or [fork](#session-fork) it. See [Agent sessions](./agent-sessions.md).

First explained in [Agent sessions](./agent-sessions.md).

## Agent stream event

One item from the agent's output as it runs: a `text` chunk or a `toolCall`, with its iteration number and a timestamp. Pass an `onAgentStreamEvent` callback to the `logging` option to receive them, in [log-to-file mode](#log-to-file-mode) only. See [Run logs](./run-logs.md).

First explained in [Run logs](./run-logs.md).

## Bind-mount sandbox provider

A [sandbox provider](#sandbox-provider) that mounts your repo from the [host](#host) straight into the [sandbox](#sandbox), so the agent edits the real files. Docker, Podman and the [native sandbox providers](#native-sandbox-provider) work this way. See [Sandbox providers](./sandbox-providers.md).

## Branch (branch strategy)

The [branch strategy](#branch-strategy) that puts the agent's commits on a branch you name, in a [worktree](#worktree): `{ type: "branch", branch: "agent/fix-42" }`. See [Branch strategies](./branch-strategies.md).

## Branch strategy

How the agent's commits relate to your branches: [head](#head-branch-strategy), [merge-to-head](#merge-to-head-branch-strategy) or [branch](#branch-branch-strategy). You choose one per run; leave it out and the kind of [sandbox provider](#sandbox-provider) picks one. See [Branch strategies](./branch-strategies.md).

First explained in [Getting started](./getting-started.md).

## Build-image

The CLI command that rebuilds a provider's container image, such as `sandcastle docker build-image`. See [Sandbox providers](./sandbox-providers.md#build-image-and-remove-image).

First explained in [Sandbox providers](./sandbox-providers.md).

## Built-in prompt argument

A [prompt argument](#prompt-argument) Sandcastle fills in for you, such as `{{SOURCE_BRANCH}}`, so you don't pass it in `promptArgs`. See [Prompts](./prompts.md#built-in-prompt-arguments).

First explained in [Prompts](./prompts.md).

## Completion signal

The `<promise>COMPLETE</promise>` marker an agent prints to say there is nothing left to do. Sandcastle stops running [iterations](#iteration) when it sees it. It carries no data: for that, use [structured output](#structured-output). See [Iterations](./iterations.md).

First explained in [Prompts](./prompts.md).

## Completion timeout

How long Sandcastle waits, once it has seen the [completion signal](#completion-signal), for the agent's process to exit. Each new line of output restarts the wait, so trailing output is still captured. If it runs out, the run still succeeds, with a warning about a [hanging process](#hanging-process). Set it with `completionTimeoutSeconds` (default 60). See [Iterations](./iterations.md).

First explained in [Iterations](./iterations.md).

## Config directory

The `.sandcastle/` directory in your repo, which [init](#init) creates. It holds the main file that calls `run()`, the prompt, a Dockerfile for Docker, and the `.env` for your tokens. See [Init](./init.md#config-directory-sandcastle).

First explained in [Sandbox providers](./sandbox-providers.md).

## Hanging process

An agent that has printed its [completion signal](#completion-signal) but whose process has not exited, usually because a child process it started still holds its output open. Sandcastle ends the wait after the [completion timeout](#completion-timeout). See [Iterations](./iterations.md).

First explained in [Iterations](./iterations.md).

## Head (branch strategy)

The [branch strategy](#branch-strategy) where the agent works directly in your working directory on the [host](#host), with no [worktree](#worktree) and no extra branch. See [Branch strategies](./branch-strategies.md).

## Host

Your machine: where Sandcastle runs and your real git repo lives, as opposed to the [sandbox](#sandbox). See [Core concepts](./core-concepts.md).

First explained in [Getting started](./getting-started.md).

## Host hook

A hook that runs a shell command on the [host](#host), not inside the [sandbox](#sandbox): `{ command: string }`. See [Hooks](./hooks.md).

First explained in [Hooks](./hooks.md).

## Init

`sandcastle init`, the command that sets up the [config directory](#config-directory) in your repo. See [Init](./init.md).

First explained in [Getting started](./getting-started.md).

## Inline prompt

A [prompt](#prompt) you pass as a string with the `prompt` option. Sandcastle passes it to the agent as written: no [prompt arguments](#prompt-argument) and no [shell expressions](#shell-expression). See [Prompts](./prompts.md).

First explained in [Prompts](./prompts.md).

## Isolated sandbox provider

A [sandbox provider](#sandbox-provider) whose [sandbox](#sandbox) has its own filesystem, such as Vercel or Daytona. Sandcastle copies your code in and brings the agent's commits back out. See [Sandbox providers](./sandbox-providers.md).

## Issue tracker

Where the agent finds its [tasks](#task), chosen during [init](#init): GitHub Issues or Beads, for example. See [Init](./init.md).

First explained in [Init](./init.md).

## Iteration

One run of the [agent](#agent) inside the [sandbox](#sandbox), making at most one commit for one [task](#task). `maxIterations` sets how many a run may take. See [Iterations](./iterations.md).

First explained in [Core concepts](./core-concepts.md).

## Log-to-file mode

The display mode where Sandcastle writes progress and agent output to a [run log](#run-log) instead of the terminal. See [Run logs](./run-logs.md).

First explained in [Run logs](./run-logs.md).

## Merge-to-head (branch strategy)

The [branch strategy](#branch-strategy) where Sandcastle gives the agent a temporary branch in a [worktree](#worktree), then merges its commits back into your current branch. See [Branch strategies](./branch-strategies.md).

## Native sandbox provider

A [bind-mount sandbox provider](#bind-mount-sandbox-provider) that uses your operating system's own process sandbox (Bubblewrap on Linux, Seatbelt on macOS) instead of a container, so the agent uses the tools already on your [host](#host). See [Sandbox providers](./sandbox-providers.md).

## No-sandbox provider

`noSandbox()`, the [sandbox provider](#sandbox-provider) that creates no [sandbox](#sandbox) at all: the agent runs directly on your [host](#host). See [Sandbox providers](./sandbox-providers.md).

First explained in [Core concepts](./core-concepts.md).

## Output schema

The validator, such as a Zod schema, that you pass to `Output.object()` to parse and check [structured output](#structured-output). See [Structured output](./structured-output.md).

First explained in [Structured output](./structured-output.md).

## Prompt

The instructions the [agent](#agent) gets at the start of each [iteration](#iteration): an [inline prompt](#inline-prompt) or a [prompt template](#prompt-template). See [Prompts](./prompts.md).

First explained in [Core concepts](./core-concepts.md).

## Prompt argument

A value you pass in `promptArgs` to fill a `{{KEY}}` placeholder in a [prompt template](#prompt-template). See [Prompts](./prompts.md).

First explained in [Prompts](./prompts.md).

## Prompt argument substitution

The step that replaces each `{{KEY}}` in a [prompt template](#prompt-template) with its [prompt argument](#prompt-argument), each time the prompt is used. See [Prompts](./prompts.md).

First explained in [Prompts](./prompts.md).

## Prompt expansion

The step that runs each [shell expression](#shell-expression) in a [prompt template](#prompt-template) and puts its output in its place. See [Prompts](./prompts.md).

## Prompt template

A [prompt](#prompt) read from a file with the `promptFile` option. It can hold `{{KEY}}` placeholders and `` !`command` `` [shell expressions](#shell-expression), which Sandcastle fills in before the agent sees it. See [Prompts](./prompts.md).

First explained in [Prompts](./prompts.md).

## Remove-image

The CLI command that removes a provider's container image, such as `sandcastle docker remove-image`. See [Sandbox providers](./sandbox-providers.md#build-image-and-remove-image).

First explained in [Sandbox providers](./sandbox-providers.md).

## Run log

The log file Sandcastle writes to `.sandcastle/logs/` in [log-to-file mode](#log-to-file-mode). See [Run logs](./run-logs.md).

First explained in [Run logs](./run-logs.md).

## Sandbox

The boundary around the [agent](#agent): a container, a VM or an OS process sandbox that limits what it can reach. See [Core concepts](./core-concepts.md).

First explained in [Getting started](./getting-started.md).

## Sandbox hook

A hook that runs a shell command inside the [sandbox](#sandbox), optionally with `sudo`: `{ command: string; sudo?: boolean }`. See [Hooks](./hooks.md).

First explained in [Hooks](./hooks.md).

## Sandbox provider

The function that creates and manages a [sandbox](#sandbox), such as `docker()` or `bwrap()`. You pass it to `run()` as the `sandbox` option. See [Sandbox providers](./sandbox-providers.md).

First explained in [Getting started](./getting-started.md).

## Session fork

Starting a new [agent session](#agent-session) from an existing one, with a new session ID, leaving the original untouched. Call `fork()` on a run's result. It copies the session only, not the branch or the [sandbox](#sandbox). See [Agent sessions](./agent-sessions.md#session-fork).

## Session resume

Continuing an [agent session](#agent-session) by adding new turns to the same record, under the same session ID. Call `resume()` on a run's result. See [Agent sessions](./agent-sessions.md#session-resume).

## Shell expression

A `` !`command` `` marker in a [prompt template](#prompt-template). Sandcastle runs the command inside the [sandbox](#sandbox) and replaces the marker with its output. A marker inside an HTML comment never runs. See [Prompts](./prompts.md).

First explained in [Prompts](./prompts.md).

## Source branch

The branch the agent works on. The [branch strategy](#branch-strategy) decides which one it is. See [Branch strategies](./branch-strategies.md#source-and-target-branches).

First explained in [Branch strategies](./branch-strategies.md).

## Structured output

A typed JSON answer the agent prints inside an XML tag you choose, which Sandcastle checks against your [output schema](#output-schema) and returns on `result.output`. Your prompt has to ask for the tag. See [Structured output](./structured-output.md).

First explained in [Structured output](./structured-output.md).

## Target branch

The branch you had checked out when you called `run()`: the one Sandcastle merges into with [merge-to-head](#merge-to-head-branch-strategy). See [Branch strategies](./branch-strategies.md#source-and-target-branches).

First explained in [Branch strategies](./branch-strategies.md).

## Task

A piece of work from the [issue tracker](#issue-tracker) that the agent picks up and works on during an [iteration](#iteration). See [Init](./init.md).

First explained in [Init](./init.md).

## Template argument

A `{{KEY}}` placeholder in a file [init](#init) scaffolds, such as the Dockerfile or the prompt, which init fills in from your choices. See [Init](./init.md#template-arguments).

First explained in [Init](./init.md).

## Template argument substitution

The step during [init](#init) that replaces each [template argument](#template-argument) with its value. See [Init](./init.md#template-arguments).

## Terminal mode

The display mode where Sandcastle shows progress in the terminal, with spinners and status messages. See [Run logs](./run-logs.md).

First explained in [Run logs](./run-logs.md).

## Worktree

A git worktree Sandcastle creates in `.sandcastle/worktrees/` on your [host](#host) for the [merge-to-head](#merge-to-head-branch-strategy) and [branch](#branch-branch-strategy) strategies. A bind-mount provider mounts it into the [sandbox](#sandbox); an isolated provider syncs it in and pulls the commits back to it. Create one yourself with `createWorktree()`. See [Branch strategies](./branch-strategies.md).

First explained in [Core concepts](./core-concepts.md).
