# Sandcastle Architecture Overview

Sandcastle is a TypeScript toolkit that orchestrates AI coding agents inside isolated sandbox environments, managing the lifecycle of sandboxes, branches, prompts, and iterations.

## High-Level Architecture

The architecture is built around three main pillars: **Orchestration**, **Agents**, and **Sandboxes**. These are decoupled using interfaces and managed through a functional effect system.

### 1. Core Components

- **Orchestrator (`src/Orchestrator.ts`)**: The central engine that manages the execution loop. It handles the lifecycle of an "iteration" (a single agent invocation), monitors for completion signals, and manages timeouts and idle detection.
- **Agent Provider (`src/AgentProvider.ts`)**: A pluggable abstraction for AI coding tools. It defines the command-line interface for the agent and provides logic to parse the agent's output stream (extracting text, tool calls, and session IDs).
- **Sandbox Provider (`src/SandboxProvider.ts`)**: A pluggable abstraction for execution environments. It handles the underlying infrastructure (Docker, Podman, Vercel, etc.), providing a consistent interface for executing commands and managing files.
- **Sandbox Lifecycle (`src/SandboxLifecycle.ts`)**: Manages the "plumbing" around the sandbox, including git worktree creation, file synchronization (sync-in/sync-out), and branch management strategies.

### 2. Execution Flow

When a user calls `run()` or uses the CLI, the following flow occurs:

1.  **Context Resolution**: Resolves the host repository directory, environment variables, and the prompt (from a file or inline string).
2.  **Configuration**: Selects the **Branch Strategy** (Head, Merge-to-Head, or Named Branch) and the **Sandbox Provider**.
3.  **Environment Preparation**:
    -   If necessary, a new **Git Worktree** is created in `.sandcastle/worktrees/` to isolate the agent's changes.
    -   Host files are copied or mounted into the sandbox.
4.  **Sandbox Initialization**: The sandbox is started, and initial setup (git configuration, branch checkout) is performed inside the environment.
5.  **Iteration Loop**:
    -   The **Agent Invoker** calls the agent inside the sandbox with the resolved prompt.
    -   Output is streamed back to the host and displayed or logged.
    -   The loop continues until the `maxIterations` limit is reached or the agent emits a **Completion Signal**.
6.  **Teardown & Merging**:
    -   If using an isolated sandbox, changes are synced back to the host.
    -   If using `merge-to-head`, the temporary branch is merged back to the host's HEAD.
    -   The sandbox is destroyed, and the worktree is cleaned up (or preserved if errors occurred).

### 3. Branching Strategies

Sandcastle supports several ways to manage how the agent's work affects the repository:

-   **Head**: The agent works directly on the host's current branch (bind-mount only).
-   **Merge-to-Head**: The agent works on a temporary branch in a separate worktree, and changes are merged back to the host's HEAD upon success.
-   **Branch**: The agent works on an explicitly named branch.

### 4. Project Structure

-   `src/`: Main source code.
    -   `sandboxes/`: Concrete implementations of sandbox providers.
    -   `templates/`: Pre-defined orchestration patterns (loops, reviewers, etc.).
    -   `main.ts` & `cli.ts`: CLI entry points and command definitions.
    -   `run.ts` & `interactive.ts`: High-level library entry points.
-   `docs/`: Extensive documentation, ADRs (Architectural Decision Records), and agent guides.
-   `documents/`: High-level architectural overviews and other project-level documents.

### 5. Technology Stack

-   **TypeScript**: Core language.
-   **Effect**: Used for dependency injection, error handling, and managing complex asynchronous workflows.
-   **@effect/cli**: Powers the command-line interface.
-   **@clack/prompts**: Provides the interactive terminal UI.
-   **Vitest**: Test runner for unit and integration tests.
-   **Docker / Podman / Daytona / Vercel**: Supported sandbox backends.

## Key Design Principles

-   **Isolation**: Every agent run is ideally isolated in a sandbox and a git worktree to protect the host environment.
-   **Extensibility**: New agents and sandbox providers can be added by implementing the respective provider interfaces.
-   **Observability**: Supports detailed logging to files or interactive stdout, with the ability to stream agent events to external systems.
-   **Robustness**: Uses Effect's resource management (Scope) to ensure that sandboxes and temporary files are cleaned up even in the event of failure.
