# Adding a backlog manager

This document is for contributors adding support for a new **backlog manager** (e.g. GitHub Issues, Beads, Jira, GitLab) to `sandcastle init`. It covers:

1. [Evaluating a new backlog manager](#evaluating-a-new-backlog-manager) — the questionnaire used to decide whether a backlog manager can be supported.
2. [The `BacklogManagerEntry` shape](#the-backlogmanagerentry-shape) — what you fill in.
3. [Scaffold integration](#scaffold-integration) — how the entry plugs into `sandcastle init`.
4. [Implementation checklist](#implementation-checklist) — every file to touch.

For terminology (**backlog manager**, **task**, **template argument**, etc.), see [`CONTEXT.md`](../../CONTEXT.md).

## What a backlog manager integration actually is

Sandcastle does not embed any backlog manager itself. A backlog-manager entry is a **scaffold template**: when a user picks it during `sandcastle init`, we substitute three CLI commands (`LIST_TASKS_COMMAND`, `VIEW_TASK_COMMAND`, `CLOSE_TASK_COMMAND`) into the generated prompt files, and we drop a Dockerfile snippet that installs the relevant CLI into the **sandbox**.

The generated project then runs those commands itself — Sandcastle is not in the loop at runtime.

This means the requirements below are about what the **CLI** can do unattended inside a Debian-based container, not about what the backlog manager can do as a product.

## Evaluating a new backlog manager

Before implementing, confirm the backlog manager satisfies the must-haves below. If a must-have is missing, the integration likely cannot be supported until upstream changes.

### Must-have CLI capabilities

- **Official / first-party CLI.** We will not ship a third-party CLI as the default integration. Reason: the scaffold prints these commands directly into user prompts and installs the CLI into every generated **sandbox** — recommending an unofficial tool puts users on a maintenance path we don't control.
- **Non-interactive auth via env var.** The CLI must authenticate from an environment variable (typically a personal access token) without an interactive login. The token name goes into `.env.example`.
- **Non-interactive list command.** A single command that prints open tasks, ideally filterable by some "ready" signal (label, status, query). This becomes `LIST_TASKS_COMMAND`.
- **Non-interactive view command.** A command that prints a single task by ID, including its description and (ideally) comments. This becomes `VIEW_TASK_COMMAND`.
- **Non-interactive close command.** A command that closes a task by ID, ideally accepting a closing comment. This becomes `CLOSE_TASK_COMMAND`.
- **Installable inside a Debian container.** The install must be reproducible from a Dockerfile `RUN` line — apt package, official install script, single static binary, etc. No GUI installer, no per-user OAuth dance.
- **Stable exit codes.** Non-zero on error so the agent loop can detect failures.

### Strongly preferred

- **Structured (JSON) output for list.** Lets the prompt parse rather than scrape. GitHub's `gh issue list --json …` and Beads' `bd ready --json` both meet this.
- **Filter/label support on list.** Some way to scope to "tasks ready for the agent" rather than the whole backlog.

### Not sufficient on its own

- **MCP server only.** An MCP server is not a substitute for a CLI here. The scaffold's job is to produce shell commands the generated project runs at task time; MCP servers run inside an agent host, not as standalone shell commands. An MCP server may complement a CLI, but it cannot replace one for this integration.
- **Third-party / community CLIs.** See the must-have above. If the only available CLI is community-maintained, raise it on an issue before doing the work — we may decide to wait, or to support it under a clearly-marked opt-in flag, but it should not be the default.

### Scaffold prerequisites

For `sandcastle init` to offer the backlog manager:

- A Dockerfile snippet that installs the CLI as root (before any `USER` switch in the agent provider's Dockerfile).
- A token env var to surface in `.env.example`, or an empty string if no auth is required (Beads is the local-only example).
- Concrete `LIST_TASKS_COMMAND`, `VIEW_TASK_COMMAND`, `CLOSE_TASK_COMMAND` strings. Use `<ID>` as the placeholder for a task ID in the view/close commands — the generated prompts substitute it.

## The `BacklogManagerEntry` shape

Defined in [`src/InitService.ts`](../../src/InitService.ts).

```ts
interface BacklogManagerEntry {
  readonly name: string;
  readonly label: string;
  readonly templateArgs: {
    readonly LIST_TASKS_COMMAND: string;
    readonly VIEW_TASK_COMMAND: string;
    readonly CLOSE_TASK_COMMAND: string;
    readonly BACKLOG_MANAGER_TOOLS: string;
  };
  readonly envExample: string;
}
```

Field by field:

- `name` — short identifier (e.g. `"github-issues"`, `"beads"`). Used as the CLI choice value.
- `label` — human-readable label shown in the `init` picker.
- `templateArgs.LIST_TASKS_COMMAND` — shell command that prints open tasks. Prefer JSON output.
- `templateArgs.VIEW_TASK_COMMAND` — shell command that prints one task by ID. Use `<ID>` as the literal placeholder.
- `templateArgs.CLOSE_TASK_COMMAND` — shell command that closes a task by ID. Use `<ID>` as the literal placeholder.
- `templateArgs.BACKLOG_MANAGER_TOOLS` — Dockerfile snippet that installs the CLI. Substituted into the agent provider's Dockerfile at the `{{BACKLOG_MANAGER_TOOLS}}` placeholder, which sits before the `USER agent` line, so commands run as root.
- `envExample` — lines appended to `.env.example`. Empty string if no auth is required.

## Scaffold integration

Add an entry to `BACKLOG_MANAGER_REGISTRY` in [`src/InitService.ts`](../../src/InitService.ts), alongside `github-issues` and `beads`:

```ts
{
  name: "gitlab",
  label: "GitLab Issues",
  templateArgs: {
    LIST_TASKS_COMMAND: `glab issue list --opened --output json`,
    VIEW_TASK_COMMAND: "glab issue view <ID>",
    CLOSE_TASK_COMMAND: `glab issue close <ID>`,
    BACKLOG_MANAGER_TOOLS: GLAB_TOOLS,
  },
  envExample: `# GitLab personal access token
GITLAB_TOKEN=`,
}
```

And a Dockerfile-snippet constant alongside `GITHUB_CLI_TOOLS` and `BEADS_TOOLS`. Keep it to a single `RUN` block where reasonable; clean apt lists; do not switch user.

## Implementation checklist

For a new backlog manager `foo`:

- [ ] `BACKLOG_MANAGER_REGISTRY` entry in [`src/InitService.ts`](../../src/InitService.ts).
- [ ] `FOO_TOOLS` Dockerfile-snippet constant in `src/InitService.ts`.
- [ ] Tests in `src/InitService.test.ts` covering: entry is listed by `listBacklogManagers`, `getBacklogManager("foo")` returns the entry with the expected `templateArgs`, `.env.example` includes the token line, generated prompts contain the substituted commands.
- [ ] Changeset in `.changeset/` (patch, since pre-1.0). See [`CLAUDE.md`](../../CLAUDE.md).
- [ ] `README.md` update if the public-facing list of supported backlog managers is mentioned there.
