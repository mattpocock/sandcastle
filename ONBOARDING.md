# Sandcastle Onboarding Guide

## What Is This?

Sandcastle is a TypeScript CLI and library for running AI coding agents inside isolated Docker containers. You point it at a prompt, pick an agent (Claude Code, Codex, or Pi), and Sandcastle handles the plumbing: creating a git worktree, spinning up a Docker container, bind-mounting the worktree in, running the agent, collecting commits, and merging them back.

It solves the problem of safely parallelizing multiple AI agents against the same repo without them stepping on each other's files or your working tree.

---

## Developer Experience

Install Sandcastle, scaffold a `.sandcastle/` directory, and run an agent in three commands:

```bash
npm install @ai-hero/sandcastle
npx sandcastle init
npx tsx .sandcastle/main.ts
```

The primary programmatic API is `run()` for one-shot agent invocations and `createSandbox()` for multi-step workflows (implement-then-review, for example). Both return commit SHAs and agent output when done.

Four templates ship with `sandcastle init`: `blank`, `simple-loop`, `sequential-reviewer`, and `parallel-planner`. Each scaffolds a ready-to-use prompt and `main.ts`.

See the [README](README.md) for the full API reference.

---

## How Is It Organized?

### Architecture

```
Developer machine (host)
        |
        |  run() or CLI
        v
+------------------+
| Sandcastle       |
| (Node.js)        |
|  Orchestrator    |
|  WorktreeManager |
|  SandboxFactory  |
+--------+---------+
         |
         |  docker exec (streaming)
         v
+------------------+
| Docker container |
| (sandbox)        |
|  Agent (Claude,  |
|  Codex, or Pi)   |
+--------+---------+
         |
         |  bind-mount (read/write)
         v
+------------------+
| Git worktree     |
| (.sandcastle/    |
|  worktrees/<id>) |
+------------------+
```

The agent writes directly to the host filesystem through the bind-mount. No sync-in or sync-out step exists.

### Directory Structure

```
sandcastle/
  src/
    cli.ts              # CLI entry (init, build-image, etc.)
    main.ts             # CLI bootstrap
    run.ts              # run() public API
    createSandbox.ts    # createSandbox() public API
    Orchestrator.ts     # Iteration loop
    SandboxFactory.ts   # Docker container lifecycle
    SandboxLifecycle.ts # Git setup, hooks, merge-back
    WorktreeManager.ts  # Worktree create/prune/remove
    AgentProvider.ts    # Agent adapters (Claude, Codex, Pi)
    Display.ts          # Terminal vs file output
    EnvResolver.ts      # .env loading
    PromptResolver.ts   # Prompt file loading
    PromptPreprocessor.ts   # !`command` expansion
    PromptArgumentSubstitution.ts  # {{KEY}} replacement
    templates/          # Init scaffolding templates
    tui/                # Ink-based terminal dashboard
  docs/                 # Fumadocs documentation site
  .sandcastle/          # Dog-food config (Sandcastle on itself)
```

### Module Connections

| Module                              | Responsibility                                                          |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `src/run.ts`                        | Public `run()` — resolves config, builds layers, calls orchestrator     |
| `src/createSandbox.ts`              | Public `createSandbox()` — persistent sandbox for multi-run workflows   |
| `src/Orchestrator.ts`               | Drives the iteration loop: invoke agent, parse output, check signals    |
| `src/SandboxFactory.ts`             | Creates Docker containers, manages worktree lifecycle per iteration     |
| `src/SandboxLifecycle.ts`           | Git setup inside sandbox, hook execution, commit collection, merge-back |
| `src/WorktreeManager.ts`            | Git worktree CRUD and stale worktree pruning                            |
| `src/AgentProvider.ts`              | Builds agent CLI commands and parses their streaming JSON output        |
| `src/PromptPreprocessor.ts`         | Evaluates `` !`command` `` shell expressions inside the sandbox         |
| `src/PromptArgumentSubstitution.ts` | Replaces `{{KEY}}` placeholders with prompt argument values             |
| `src/Display.ts`                    | Renders progress via Clack (terminal mode) or writes to log files       |
| `src/EnvResolver.ts`                | Loads env vars from `.sandcastle/.env` and `process.env`                |

`run()` and `createSandbox()` both flow through the Orchestrator, which uses SandboxFactory to acquire a sandbox, then SandboxLifecycle to set up git and run hooks before invoking the agent.

### External Dependencies

| Dependency        | What it's used for                                 | Configured via                  |
| ----------------- | -------------------------------------------------- | ------------------------------- |
| Docker            | Container runtime for sandboxes                    | Must be installed on host       |
| Git               | Worktree management, commits                       | Must be installed on host       |
| GitHub CLI (`gh`) | Issue fetching in prompts                          | Installed in sandbox Dockerfile |
| Effect            | Functional effect system for error handling and DI | `package.json` dependency       |
| Clack             | Terminal UI (spinners, prompts)                    | `package.json` dependency       |
| Ink/React         | TUI dashboard rendering                            | `package.json` dependency       |

---

## Key Concepts and Abstractions

| Concept           | What it means in this codebase                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| Sandbox           | An isolated Docker container with a worktree bind-mounted as the workspace                                |
| Host              | The developer's machine where Sandcastle runs and the real git repo lives                                 |
| Agent             | The AI coding tool invoked inside the sandbox (Claude Code, Codex, or Pi)                                 |
| Iteration         | A single invocation of the agent inside the sandbox                                                       |
| Completion signal | `<promise>COMPLETE</promise>` marker the agent emits to stop the loop early                               |
| Worktree          | A git worktree at `.sandcastle/worktrees/`, bind-mounted into the container                               |
| Source branch     | The branch the agent works on inside the worktree                                                         |
| Target branch     | The host's active branch at `run()` time — merge destination                                              |
| Prompt argument   | A `{{KEY}}` placeholder substituted before the prompt reaches the agent                                   |
| Shell expression  | A `` !`command` `` marker evaluated inside the sandbox before each iteration                              |
| Agent provider    | Adapter that builds CLI commands and parses streaming output for a specific agent                         |
| Effect service    | Dependency injection via Effect's `Context.Tag` pattern — used for `Display`, `Sandbox`, `SandboxFactory` |
| Log-to-file mode  | Default: writes progress to `.sandcastle/logs/` instead of terminal                                       |
| Terminal mode     | Interactive Clack UI with spinners and styled output                                                      |

See [UBIQUITOUS_LANGUAGE.md](UBIQUITOUS_LANGUAGE.md) for the full glossary.

---

## Primary Flows

### Programmatic `run()` Flow

```
run(options)
  |
  v
src/run.ts
  resolves prompt, env, worktree mode, logging
  |
  v
src/PromptArgumentSubstitution.ts
  replaces {{KEY}} placeholders on the host
  |
  v
src/Orchestrator.ts
  starts iteration loop (1..maxIterations)
  |
  v
src/SandboxFactory.ts
  creates worktree + Docker container
  (acquireUseRelease pattern)
  |
  v
src/SandboxLifecycle.ts
  configures git, runs onSandboxReady hooks
  |
  v
src/PromptPreprocessor.ts
  evaluates !`command` expressions in sandbox
  |
  v
src/AgentProvider.ts
  builds CLI command, streams JSON output
  |
  v
src/Orchestrator.ts
  checks for completion signal
  |
  v
src/SandboxLifecycle.ts
  collects commits, merges temp branch back
  |
  v
RunResult { iterationsRun, commits, stdout }
```

### CLI `sandcastle init` Flow

1. `src/main.ts` bootstraps the CLI with Effect
2. `src/cli.ts` parses arguments, dispatches to `InitService`
3. `src/InitService.ts` prompts for agent/template, scaffolds `.sandcastle/`, builds Docker image

---

## Developer Guide

### Setup

```bash
git clone <repo-url>
cd sandcastle
npm install
```

### Build, Test, Typecheck

```bash
npm run build       # Build with tsgo
npm test            # Run tests with Vitest
npm run typecheck   # Type-check with tsgo
npm run format      # Format with Prettier
```

### Common Change Patterns

- **Add a new agent provider**: Create a factory function in `src/AgentProvider.ts` following the pattern of `claudeCode()`, `pi()`, or `codex()`. Implement `buildPrintCommand`, `buildInteractiveArgs`, and `parseStreamLine`.
- **Add a new CLI command**: Add the command definition in `src/cli.ts` using `@effect/cli`.
- **Add a new template**: Create a directory under `src/templates/` with `template.json`, `prompt.md`, and `main.ts`. The template is automatically discovered by `sandcastle init`.
- **Modify sandbox behavior**: `SandboxFactory.ts` handles container lifecycle, `SandboxLifecycle.ts` handles git setup and merge-back.

### Key Files to Start With

| Area            | File                      | Why                                               |
| --------------- | ------------------------- | ------------------------------------------------- |
| Public API      | `src/run.ts`              | All config resolution and the `run()` entry point |
| Public API      | `src/createSandbox.ts`    | Multi-run sandbox lifecycle                       |
| Core loop       | `src/Orchestrator.ts`     | The iteration loop that drives agents             |
| Container mgmt  | `src/SandboxFactory.ts`   | Docker + worktree acquisition/release             |
| Git integration | `src/SandboxLifecycle.ts` | Hook execution, commit collection, merge          |
| Agent adapters  | `src/AgentProvider.ts`    | How agents are invoked and their output parsed    |
| CLI             | `src/cli.ts`              | All CLI commands and argument parsing             |

### Practical Tips

- The codebase uses Effect heavily for dependency injection and error handling. Services are injected via `Context.Tag` and composed with `Layer`. Read `src/run.ts` to see how layers are assembled.
- Tests use `@effect/vitest` and a local sandbox implementation (`src/testSandbox.ts`) to avoid Docker in CI.
- The `postbuild` script copies `src/templates/` into `dist/templates/` since `tsgo` doesn't handle non-TS files.
- When adding changesets, use `patch` level (pre-1.0) and `@ai-hero/sandcastle` as the package name.
