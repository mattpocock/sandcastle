# Agent providers own their session storage end-to-end

**Agent session** storage -- where the **agent**'s persisted conversation record lives, how it is keyed, and how its content is rewritten when transferred between **host** and **sandbox** -- is owned by the **agent provider**, not by a shared seam.

Each `AgentProvider` exposes an optional `sessionStorage` sub-object:

```ts
readonly sessionStorage?: {
  hostStore(cwd: string): SessionStore;
  sandboxStore(cwd: string, handle: BindMountSandboxHandle): SessionStore;
  transfer(from: SessionStore, to: SessionStore, id: string): Promise<void>;
};
```

`captureSessions: boolean` is retained as a separate user-facing kill-switch. `supportsResume` is derived: `provider.sessionStorage !== undefined`. The `SessionPaths` Effect `Context.Tag` and its `sessionPathsLayer` / `defaultSessionPathsLayer` are removed; defaults bake into provider factories, and overrides are passed via provider options (e.g. `claudeCode(model, { sessionStorage: { hostDir, sandboxDir } })`).

Motivation: storage varies on three axes that no single shared abstraction captures cleanly. Location varies (`~/.claude/projects/` vs `~/.codex/sessions/` vs `~/.pi/agent/sessions/` vs OpenCode SQLite). Key/path encoding varies (Claude encodes cwd as a hyphenated directory name; others may key flat by id, or by SQL row). Content rewriting on transfer varies (Claude rewrites `cwd` fields in JSONL entries; codex/pi may have a different field or none; OpenCode rewrites SQL columns). Today's `SessionPaths` carries only the directory pair, which means `transferSession`'s rewrite logic is hardcoded for Claude's JSONL format. Adding a non-Claude provider would force either a per-provider switch in central code or a series of escape hatches. Pushing the entire storage responsibility behind the provider makes adding a provider purely additive.

## Considered Options

1. **Paths-only abstraction** -- generalise today's `SessionPaths` to per-provider `{ hostDir, sandboxDir, encodePath? }`, keep `transferSession` central. Rejected: the Claude-specific `cwd`-rewrite leaks into the generic transfer code, and OpenCode's SQLite has no path concept at all.
2. **Hybrid (paths + optional rewrite hook)** -- paths plus an `rewriteSessionContent` callback on `AgentProvider`. Rejected for the same OpenCode misfit; still file-shaped at the core.
3. **Full provider-owned `SessionStore` factory** (chosen) -- each provider supplies its own store factories and transfer op. Heavier per-provider implementation surface, mitigated by extracting a `fileBasedSessionStore` helper on second use (when codex lands). Today, `claudeCode` inlines its store logic.

## Consequences

- `AgentProvider`'s shape grows by one optional sub-object. Providers without resume support omit it; the conditional/derived `supportsResume` then makes `RunResult.resume` typed `never` for those providers (compile error rather than runtime throw).
- `SessionStore`'s interface drops `sessionFilePath(id): string` in favour of `exists(id): Promise<boolean>` for pre-flight checks. `sessionFilePath(id): string | undefined` is retained on the host store as a user-facing field surfaced via `OrchestrateResult.sessionFilePath` -- file-backed stores return a real path, future SQLite-backed stores return `undefined`.
- `SessionPaths`, `sessionPathsLayer`, `defaultSessionPathsLayer` are removed from `src/SessionPaths.ts` and from the public exports. Callers (`Orchestrator.ts`, `run.ts`, `createSandbox.ts`, `createWorktree.ts`) read `provider.sessionStorage` directly off the run options instead of pulling paths from Effect context. Patch changeset, since pre-1.0.
- The free `transferSession` function in `SessionStore.ts` is removed (or kept unexported as a low-level "read content, optionally rewrite, write content" primitive). The Claude-specific `cwd`-rewrite logic moves into `claudeCode`'s `sessionStorage.transfer`.
- No `fileBasedSessionStore` helper ships in the Claude-only PR. When the second file-based provider (codex) lands and we know its actual storage layout, the helper is extracted from the duplication.
- Adding a new resumable agent provider is purely additive: implement `sessionStorage`, emit `session_id` events from `parseStreamLine`, wire `resumeSession` through `buildPrintCommand`, set `captureSessions: true`. No central code changes.
