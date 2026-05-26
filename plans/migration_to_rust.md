# Migration Plan: TypeScript to Rust

## Overview & Goals
The goal is to provide a detailed, phased migration plan for porting Sandcastle from TypeScript to Rust. This ensures a smooth transition while maintaining parity with the current TypeScript implementation, breaking down the work into logical, small PRs.

## Scope
- **In Scope**:
    - Analysis of current TypeScript architecture (Orchestrator, Agents, Sandboxes).
    - Mapping TypeScript patterns (Effect, @effect/cli) to Rust equivalents (Tokio, Clap).
    - Defining a phased PR schedule.
    - Identifying key Rust crates for the migration.
- **Out of Scope**:
    - Actual implementation of the Rust code (in this planning phase).
    - Changes to the existing TypeScript codebase.

## Technical Design

### Current Implementation
- **Core Engine**: Built using `Effect` TS, providing a functional approach to dependency injection, error handling, and async workflows.
- **Sandboxes**: Pluggable providers (Docker, Podman, No-Sandbox) managed via interfaces.
- **Agents**: Logic for command building and output stream parsing for various AI models.
- **Lifecycle**: Complex lifecycle management involving git worktrees, file syncing, and interactive sessions.

### Key Decisions

#### 1. Async Runtime and Concurrency
**Choice**: `tokio`
**Rationale**: Sandcastle heavily relies on concurrent operations (streaming output, monitoring timeouts, managing multiple sandboxes). `tokio` is the industry standard for robust, high-performance async Rust.

#### 2. Error Handling
**Choice**: `thiserror` for library components, `anyhow` for the CLI.
**Rationale**: Provides a good balance between strongly-typed errors for core logic and flexible error reporting for the end-user.

#### 3. Container Interop
**Choice**: `bollard`
**Rationale**: A mature, well-maintained crate for interacting with the Docker and Podman APIs, replacing the current approach of wrapping CLI commands where possible.

#### 4. Dependency Management / Injection
**Choice**: Traits and State Structs.
**Rationale**: Idiomatic Rust uses traits and dependency injection via constructor-passing or `Arc<T>` shared state.

### Architecture Mapping

| TypeScript (Current) | Rust (Proposed) |
| :--- | :--- |
| `Effect` | `Tokio` + `Anyhow` |
| `@effect/cli` | `Clap` |
| `Docker / Podman` | `Bollard` |
| `Git CLI` | `git2-rs` / `std::process::Command` |
| `@clack/prompts` | `inquire` / `dialoguer` |

## Proposed PR Phasing

The migration will be divided into 6 phases:

### Phase 1: Foundation
- Project setup (Cargo.toml, workspace structure).
- Core traits and basic types (errors, common result types).
- Configuration management.

### Phase 2: Git & Filesystem
- Worktree management logic.
- File synchronization (sync-in/sync-out) implementation.
- Path utility functions.

### Phase 3: Sandbox Layer
- Sandbox trait definitions.
- `Bollard` integration for Docker/Podman providers.
- No-sandbox provider implementation.

### Phase 4: Agent Layer
- Agent provider traits.
- Command building logic for various agents (Claude Code, etc.).
- Stream parsing and event handling logic.

### Phase 5: Orchestration
- The main execution loop.
- Timeout and idle detection logic.
- Session management.

### Phase 6: CLI & Templates
- CLI command structure using `Clap`.
- Interactive prompts using `inquire` or `dialoguer`.
- Porting template logic and high-level patterns.
