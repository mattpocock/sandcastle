# OpenCode resumes through `opencode export` / `opencode import`

[ADR 0016](./0016-resume-requires-filesystem-backed-sessions.md) made OpenCode non-resumable: its sessions live in a private SQLite database (`~/.local/share/opencode/opencode.db`), and moving rows between two copies of it means coupling Sandcastle to an undocumented, versioned schema. It left one door open: "if a future agent's DB exposes a clean, documented per-session export/import path, this can be revisited". OpenCode's CLI now has that path, and this ADR walks through it.

## Context

Checked with OpenCode 1.19.5 in the sandbox image, 2026-10-31:

- `opencode export <id>` prints one session as JSON (`{ info, messages }`) on stdout, and exits 1 with `Session not found` for an unknown id.
- `opencode import <file>` loads that JSON. It keeps the session id, and it re-homes the session to the importing directory: `info.directory` and `info.projectID` become the current repo's. Importing the same file twice succeeds.
- After an import into a fresh container, in a different repo, `opencode run --session <id>` continued the conversation (the agent repeated a token from the first run), and `opencode run --session <id> --fork` gave a new session id while the parent's message count stayed the same.

## Decision

OpenCode gets `sessionStorage`, with the session moved as its export JSON:

- **Capture:** after a run, `opencode export <id> > /tmp/<id>.json` runs in the sandbox repo, and the file is copied to `~/.local/share/opencode/sandcastle-sessions/<id>.json` on the host.
- **Resume:** before a resume, that file is copied into the sandbox and `opencode import` runs in the sandbox repo. Then `opencode run --session <id>` continues it, and `--session <id> --fork` forks it.
- No rewrite: the import re-homes the session itself.
- In a no-sandbox run OpenCode reads its own database, which Sandcastle can't query by id. The precheck only checks that the database exists, and OpenCode reports an unknown id itself.

## Considered Options

1. **Copy `opencode.db` whole.** Rejected. It holds every session of every project, so copying it out leaks unrelated sessions into the host store, and copying it in overwrites the sandbox's. It also locks Sandcastle to the file's WAL state at copy time.
2. **Read and write the session's rows with SQLite.** Rejected for ADR 0016's reason: it couples Sandcastle to a private schema that changes between versions.
3. **`opencode export` / `opencode import`** (chosen). It is the CLI's own documented interchange format, so OpenCode owns the schema on both ends. It costs two extra commands per transfer.

## Consequences

- ADR 0016's rule still stands for any other database-backed agent. The test is the same one it set: a documented per-session export and import in the agent's own CLI.
- The host keeps OpenCode sessions as export JSON, not in the host's `opencode.db`. `opencode import ~/.local/share/opencode/sandcastle-sessions/<id>.json` brings one into a host OpenCode.
- If a future OpenCode changes the export format, its own import still reads its own export. A version mismatch between the host's and the sandbox's OpenCode is not a concern, because both ends run in the sandbox image.
