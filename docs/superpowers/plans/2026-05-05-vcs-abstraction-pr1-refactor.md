# VCS Abstraction — PR 1: Refactor Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a `VersionControlProvider` interface from existing git-shaped code in sandcastle, ship `git()` as the sole implementation, and wire a `vcs` option through `run()` / `interactive()` / `createSandbox()` / `createWorktree()` defaulting to `git()`. **Zero behavior change.** No new functionality. All existing tests pass unchanged.

**Architecture:** Introduce `src/VersionControl.ts` defining the `VersionControlProvider` interface with one method per logical VCS operation currently performed in `WorktreeManager`, `syncIn`, `syncOut`, `SandboxLifecycle`, `SandboxFactory::resolveGitMounts`, and `RecoveryMessage`. Introduce `src/vcs/git.ts` exporting a `git()` factory that returns a `VersionControlProvider` whose methods delegate to the existing modules (which remain as internal implementation). Update all call sites that currently invoke git-shaped operations directly to instead obtain the provider from a new `vcs` option (defaulting to `git()`) and dispatch through it. Add a subpath export `@ai-hero/sandcastle/vcs/git`. Existing `WorktreeManager.ts`, `syncIn.ts`, `syncOut.ts` keep their tests green; they become internal helpers consumed only by `src/vcs/git.ts`.

**Tech Stack:** TypeScript, Effect, Vitest, npm, changesets.

**Out of scope (PR 2):** `JjProvider`, jj integration tests, jj documentation, README updates beyond a one-line API mention, CI changes.

**Pre-flight context:**
- This is a **pure refactor PR** with **zero behavior change**. Every existing test must continue to pass with the same green output it produces today.
- Use `npm run typecheck` for type checking. Use `npm test` to run the full Vitest suite. Use `npm run format:check` before committing.
- Follow existing house style — no new mocks, no test rewrites. The `WorktreeManager`-style "shell out to real git in tests" pattern stays.
- For all code searches: prefer LSP (`goto_definition`, `find_references`) for symbol questions, ast-grep for code-shape patterns, and grep only as a fallback for embedded git command strings inside template literals. See `~/.claude/CLAUDE.md` for the hierarchy.
- Add a single `patch`-level changeset at the end (per project `CLAUDE.md`).
- Prefer small, focused commits per task. Follow the existing commit message style — read the last 10 commits with `git log --oneline -10` before drafting any commit message.

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `src/VersionControl.ts` | Defines the `VersionControlProvider` TypeScript interface, supporting types (`CheckoutInfo`, `CommitRef`, `RepoMount`, `UserIdentity`), and the structural tag `"git" \| "jj"`. No implementation. |
| `src/vcs/git.ts` | Exports `git()` factory returning a `VersionControlProvider` tagged `"git"`. Each method delegates to the existing modules (`WorktreeManager`, `syncIn` helpers, `syncOut` helpers, `SandboxFactory::resolveGitMounts`, `RecoveryMessage`). |
| `src/vcs/git.test.ts` | Smoke tests for the `git()` factory: returns a provider with all expected methods; tag is `"git"`; one round-trip integration test that creates a checkout, queries `hasUncommittedChanges`, and removes it via the provider methods (mirroring `WorktreeManager.test.ts` style with real git in `mkdtempSync`). |
| `.changeset/<auto>.md` | One `patch` changeset describing the refactor and the new `vcs` option. |

### Modified files

| Path | Why |
|---|---|
| `src/run.ts` | Add `vcs?: VersionControlProvider` to `RunOptions`; pass through to internal layers; default to `git()`. |
| `src/interactive.ts` | Same as `run.ts`. |
| `src/createSandbox.ts` | Same as `run.ts`. |
| `src/createWorktree.ts` | Accept `vcs` option; replace direct `WorktreeManager.create` / `WorktreeManager.pruneStale` / `WorktreeManager.hasUncommittedChanges` / `WorktreeManager.remove` calls with `vcs.createCheckout` / `vcs.pruneStaleCheckouts` / `vcs.hasUncommittedChanges` / `vcs.removeCheckout`. |
| `src/SandboxFactory.ts` | Same call-site updates as `createWorktree.ts`. Replace `resolveGitMounts` with `vcs.resolveRepoMounts` at call sites; keep `resolveGitMounts` as the git-specific implementation that `git.ts` delegates to. |
| `src/SandboxLifecycle.ts` | Replace direct `git config user.name / user.email` reads with `vcs.readUserIdentity`. Replace inline `git config --global` setup commands with `vcs.writeUserIdentityCommands(...)`. Replace `git checkout --detach` / `git merge` / branch-delete sequence with `vcs.detachCheckout` / `vcs.mergeBranchInto` / `vcs.deleteBranch`. Replace `git rev-parse --abbrev-ref HEAD` with `vcs.currentBranch`. Replace `git rev-list ... --count` with `vcs.commitsBetween(...).length > 0`. |
| `src/syncIn.ts` | Replace direct `git rev-parse --abbrev-ref HEAD`, `git bundle create`, `git clone`, `git checkout`, `git rev-parse HEAD` calls with `vcs.currentBranch`, `vcs.bundleAllRefs`, `vcs.cloneFromBundleCommands`, `vcs.headRef`. Functions inside the sandbox stay as raw git commands because the agent's environment is git regardless of the host's VCS — but they're sourced from `vcs.cloneFromBundleCommands` so they're abstracted at the interface level. |
| `src/syncOut.ts` | Replace direct `git format-patch`, `git diff HEAD`, `git ls-files --others`, `git am --3way`, `git apply` invocations with `vcs.exportPatchesCommand`, `vcs.diffWorkingTreeCommand`, `vcs.listUntrackedCommand`, `vcs.importPatchesCommand`, `vcs.applyPatchCommand`. Same sandbox-side rationale as `syncIn.ts`. |
| `src/RecoveryMessage.ts` | Replace hard-coded `git apply` / `git am` recovery instruction text with a call to `vcs.recoveryInstructions({ patchDir, targetBranch })`. |
| `src/index.ts` | Re-export `VersionControlProvider`, `CheckoutInfo`, `CommitRef`, `RepoMount`, `UserIdentity` types from `VersionControl.ts`. Re-export `git` factory from `vcs/git.ts`. |
| `package.json` | Add subpath export `"./vcs/git": { ... }` mirroring the `./sandboxes/*` entries. |
| `tsconfig.build.json` | (Verify only — should already include `src/**/*` so no changes expected.) |

### Files explicitly **not** touched

- `src/WorktreeManager.ts` — stays as-is. It becomes an internal module called only from `src/vcs/git.ts`. No public API changes.
- `src/WorktreeManager.test.ts` — stays as-is. Continues to test git-specific behavior directly. No rewrites.
- `src/sandboxes/*.ts` — sandbox providers do not change.
- `src/SandboxProvider.ts` — `BranchStrategy` types stay git-shaped (per design decision: no public-API rename).
- `CONTEXT.md` glossary — no rename of "Worktree". (PR 2 will add a footnote about jj.)
- `README.md` — only a one-line addition mentioning the new `vcs` option for completeness; no narrative.

---

## Interface contract reference

This is the canonical reference for `VersionControlProvider`. Each task implements one or more methods; this section is the source of truth for signatures.

```ts
// src/VersionControl.ts (skeleton — see Task 1 for full content)

export interface CheckoutInfo {
  /** Filesystem path to the working tree (git worktree / jj workspace). */
  readonly path: string;
  /** Logical branch / bookmark name the agent works on. */
  readonly branch: string;
}

export interface CommitRef {
  /** Opaque commit identifier (git SHA, or jj commit-id under PR 2). */
  readonly id: string;
}

export interface RepoMount {
  readonly hostPath: string;
  readonly sandboxPath: string;
}

export interface UserIdentity {
  readonly name: string;
  readonly email: string;
}

/** Tagged union over supported backends. */
export type VersionControlTag = "git" | "jj";

/**
 * VCS backend used by sandcastle. The default `git()` implementation mirrors
 * sandcastle's historical behavior. PR 2 adds a `jj()` implementation.
 */
export interface VersionControlProvider {
  readonly tag: VersionControlTag;

  // ----- Checkout (worktree/workspace) lifecycle -----
  createCheckout(opts: {
    repoDir: string;
    branch?: string;
    baseBranch?: string;
  }): Promise<CheckoutInfo>;
  removeCheckout(checkoutPath: string): Promise<void>;
  pruneStaleCheckouts(repoDir: string): Promise<void>;
  hasUncommittedChanges(checkoutPath: string): Promise<boolean>;

  // ----- Repo introspection -----
  currentBranch(repoDir: string): Promise<string>;
  headRef(repoDir: string): Promise<string>;
  commitsBetween(repoDir: string, base: string, head: string): Promise<CommitRef[]>;

  // ----- Identity -----
  readUserIdentity(repoDir: string): Promise<UserIdentity>;
  /** Returns shell commands to be `exec`'d inside the sandbox to set identity. */
  writeUserIdentityCommands(identity: UserIdentity): string[];

  // ----- Transport (host <-> isolated sandbox) -----
  bundleAllRefs(repoDir: string, outBundlePath: string): Promise<void>;
  /** Returns shell commands to clone from a bundle inside the sandbox. */
  cloneFromBundleCommands(args: {
    bundlePath: string;
    targetPath: string;
    branch: string;
  }): string[];

  // ----- Sync-out command builders (run inside the sandbox or against
  // a checkout) -----
  exportPatchesCommand(args: { base: string; outDir: string }): string;
  importPatchesCommand(args: { patchDir: string }): string;
  diffWorkingTreeCommand(): string;
  applyPatchCommand(args: { patchPath: string }): string;
  listUntrackedCommand(): string;

  // ----- Merge-back (host) -----
  detachCheckout(checkoutPath: string): Promise<void>;
  mergeBranchInto(args: {
    repoDir: string;
    sourceBranch: string;
    targetBranch: string;
  }): Promise<void>;
  deleteBranch(repoDir: string, branch: string): Promise<void>;

  // ----- Mounts (bind-mount sandboxes) -----
  resolveRepoMounts(args: {
    checkoutPath: string;
    gitPath: string;
  }): Promise<RepoMount[]>;

  // ----- Recovery instructions (user-facing string) -----
  recoveryInstructions(args: {
    patchDir: string;
    targetBranch: string;
  }): string;
}
```

> **Important:** Some methods return shell commands as strings rather than executing them. This is intentional — sync-in/sync-out execute these commands inside the sandbox via `handle.exec(...)`, not on the host. Returning command strings keeps the provider pure and lets the caller decide where to run them. The methods that return `Promise<void>` are the ones that run on the host and need filesystem/process access.

---

## Chunk 1: Interface and `git()` factory

### Task 1: Define the `VersionControlProvider` interface

**Files:**
- Create: `src/VersionControl.ts`

- [ ] **Step 1: Create the file with the full interface definition**

Use the exact contents from the **Interface contract reference** section above. Add a top-of-file doc comment explaining: "VCS backend abstraction. The default `git()` implementation mirrors sandcastle's historical behavior. PR 2 will add a `jj()` implementation; the interface is designed to make jj a drop-in alternative for jj-colocated repos."

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck`
Expected: PASS — no errors.

- [ ] **Step 3: Commit**

```bash
jj commit -m "feat: add VersionControlProvider interface"
```

---

### Task 2: Stub the `git()` factory

**Files:**
- Create: `src/vcs/git.ts`

- [ ] **Step 1: Write the failing smoke test**

Create `src/vcs/git.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { git } from "./git.js";

describe("git() factory", () => {
  it("returns a provider tagged 'git'", () => {
    const provider = git();
    expect(provider.tag).toBe("git");
  });

  it("exposes all VersionControlProvider methods", () => {
    const provider = git();
    const expectedMethods = [
      "createCheckout",
      "removeCheckout",
      "pruneStaleCheckouts",
      "hasUncommittedChanges",
      "currentBranch",
      "headRef",
      "commitsBetween",
      "readUserIdentity",
      "writeUserIdentityCommands",
      "bundleAllRefs",
      "cloneFromBundleCommands",
      "exportPatchesCommand",
      "importPatchesCommand",
      "diffWorkingTreeCommand",
      "applyPatchCommand",
      "listUntrackedCommand",
      "detachCheckout",
      "mergeBranchInto",
      "deleteBranch",
      "resolveRepoMounts",
      "recoveryInstructions",
    ] as const;

    for (const method of expectedMethods) {
      expect(typeof (provider as Record<string, unknown>)[method]).toBe(
        "function",
      );
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/vcs/git.test.ts`
Expected: FAIL — module `./git.js` not found.

- [ ] **Step 3: Stub `src/vcs/git.ts` with `not implemented` bodies for every method**

```ts
import type {
  VersionControlProvider,
  CheckoutInfo,
  CommitRef,
  RepoMount,
  UserIdentity,
} from "../VersionControl.js";

const ni = (name: string): never => {
  throw new Error(`git().${name}: not yet wired (PR 1 stub)`);
};

export const git = (): VersionControlProvider => ({
  tag: "git",
  createCheckout: async (_opts) => ni("createCheckout") as never as CheckoutInfo,
  removeCheckout: async (_p) => ni("removeCheckout"),
  pruneStaleCheckouts: async (_d) => ni("pruneStaleCheckouts"),
  hasUncommittedChanges: async (_p) => ni("hasUncommittedChanges") as never as boolean,
  currentBranch: async (_d) => ni("currentBranch") as never as string,
  headRef: async (_d) => ni("headRef") as never as string,
  commitsBetween: async (_d, _b, _h) => ni("commitsBetween") as never as CommitRef[],
  readUserIdentity: async (_d) => ni("readUserIdentity") as never as UserIdentity,
  writeUserIdentityCommands: (_id) => { ni("writeUserIdentityCommands"); return []; },
  bundleAllRefs: async (_d, _o) => ni("bundleAllRefs"),
  cloneFromBundleCommands: (_a) => { ni("cloneFromBundleCommands"); return []; },
  exportPatchesCommand: (_a) => { ni("exportPatchesCommand"); return ""; },
  importPatchesCommand: (_a) => { ni("importPatchesCommand"); return ""; },
  diffWorkingTreeCommand: () => { ni("diffWorkingTreeCommand"); return ""; },
  applyPatchCommand: (_a) => { ni("applyPatchCommand"); return ""; },
  listUntrackedCommand: () => { ni("listUntrackedCommand"); return ""; },
  detachCheckout: async (_p) => ni("detachCheckout"),
  mergeBranchInto: async (_a) => ni("mergeBranchInto"),
  deleteBranch: async (_d, _b) => ni("deleteBranch"),
  resolveRepoMounts: async (_a) => ni("resolveRepoMounts") as never as RepoMount[],
  recoveryInstructions: (_a) => { ni("recoveryInstructions"); return ""; },
});
```

- [ ] **Step 4: Run tests to verify the smoke tests pass**

Run: `npx vitest run src/vcs/git.test.ts`
Expected: PASS — `tag === "git"`, every expected method is `"function"`.

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
jj commit -m "feat: stub git() factory returning VersionControlProvider"
```

---

## Chunk 2: Wire delegate methods one group at a time

Each task in this chunk replaces the `not implemented` stub for one method group with a real delegation to existing modules. After each task, all previously-passing tests must still pass.

### Task 3: Implement worktree lifecycle methods in `git()`

**Files:**
- Modify: `src/vcs/git.ts`
- Modify: `src/vcs/git.test.ts` (add one integration test)

**Method coverage:** `createCheckout`, `removeCheckout`, `pruneStaleCheckouts`, `hasUncommittedChanges`, `currentBranch`, `headRef`.

- [ ] **Step 1: Write the integration test for worktree lifecycle round-trip**

Append to `src/vcs/git.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("git() worktree lifecycle (real git)", () => {
  it("creates, queries, and removes a checkout", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "vcs-git-test-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "T"], { cwd: repoDir });
      writeFileSync(join(repoDir, "README"), "x\n");
      execFileSync("git", ["add", "."], { cwd: repoDir });
      execFileSync("git", ["commit", "-qm", "init"], { cwd: repoDir });

      const provider = git();
      const checkout = await provider.createCheckout({ repoDir });
      expect(checkout.path).toMatch(/sandcastle\/worktrees/);
      expect(typeof checkout.branch).toBe("string");

      const dirty = await provider.hasUncommittedChanges(checkout.path);
      expect(dirty).toBe(false);

      writeFileSync(join(checkout.path, "scratch"), "y\n");
      const dirtyAfter = await provider.hasUncommittedChanges(checkout.path);
      expect(dirtyAfter).toBe(true);

      // Clean up the dirty file before remove (mirrors WorktreeManager precondition)
      rmSync(join(checkout.path, "scratch"));
      await provider.removeCheckout(checkout.path);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL (stub throws)**

Run: `npx vitest run src/vcs/git.test.ts`
Expected: FAIL — `git().createCheckout: not yet wired (PR 1 stub)`.

- [ ] **Step 3: Replace the relevant stubs in `src/vcs/git.ts` with delegations to `WorktreeManager`**

- `createCheckout({ repoDir, branch, baseBranch })` → use `Effect.runPromise(WorktreeManager.create(repoDir, { branch, baseBranch }))` and adapt the returned `WorktreeInfo` to `CheckoutInfo` (just `{ path: info.path, branch: info.branch }`).
- `removeCheckout(p)` → `Effect.runPromise(WorktreeManager.remove(p))`.
- `pruneStaleCheckouts(d)` → `Effect.runPromise(WorktreeManager.pruneStale(d))`.
- `hasUncommittedChanges(p)` → `Effect.runPromise(WorktreeManager.hasUncommittedChanges(p))`.
- `currentBranch(d)` → `Effect.runPromise(WorktreeManager.getCurrentBranch(d))`.
- `headRef(d)` → run `git rev-parse HEAD` via `execFile` (this is not yet exposed by `WorktreeManager`; add it as a new private helper inside `src/vcs/git.ts` rather than modifying `WorktreeManager`).

For the `Effect.runPromise` calls: import `Effect` from `"effect"` at the top of the file. For `WorktreeManager`, use `import * as WorktreeManager from "../WorktreeManager.js"` matching the existing import style in `SandboxFactory.ts`.

- [ ] **Step 4: Run the test — expect PASS**

Run: `npx vitest run src/vcs/git.test.ts`
Expected: PASS — round-trip succeeds.

- [ ] **Step 5: Run the full test suite to verify zero regressions**

Run: `npm test`
Expected: PASS — all existing tests continue to pass.

- [ ] **Step 6: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
jj commit -m "feat: wire worktree lifecycle methods in git() provider"
```

---

### Task 4: Implement identity methods in `git()`

**Files:**
- Modify: `src/vcs/git.ts`

**Method coverage:** `readUserIdentity`, `writeUserIdentityCommands`.

- [ ] **Step 1: Inspect current behavior in `src/SandboxLifecycle.ts`** to find the exact `git config user.name` / `git config user.email` invocations and the `git config --global` propagation commands. Use LSP `find_references` on `execAsync` calls in `SandboxLifecycle.ts` to locate the lines (around lines ~150–170 in the indexed snapshot).

- [ ] **Step 2: Implement `readUserIdentity(repoDir)`**

It should run, on the host:
- `git config user.name` (in `repoDir`)
- `git config user.email` (in `repoDir`)

Return `{ name, email }`. On any single-key failure, set that field to the empty string (current behavior in `SandboxLifecycle.ts` uses `.catch(() => "")`). Use `execFile` from `node:child_process` wrapped in `promisify`. Match the existing pattern in `SandboxLifecycle.ts:~155`.

- [ ] **Step 3: Implement `writeUserIdentityCommands({ name, email })`**

Return an array of shell command strings:

```ts
const cmds: string[] = [];
if (name)  cmds.push(`git config --global user.name "${name.replace(/"/g, '\\"')}"`);
if (email) cmds.push(`git config --global user.email "${email.replace(/"/g, '\\"')}"`);
return cmds;
```

This is exactly the pair of commands that `SandboxLifecycle.ts` builds inline today; the abstraction just relocates the construction into the provider.

- [ ] **Step 4: Add a unit test for `writeUserIdentityCommands`**

Append to `src/vcs/git.test.ts`:

```ts
describe("git().writeUserIdentityCommands", () => {
  it("emits one command per non-empty field", () => {
    expect(git().writeUserIdentityCommands({ name: "Ada", email: "a@b" })).toEqual([
      `git config --global user.name "Ada"`,
      `git config --global user.email "a@b"`,
    ]);
  });
  it("escapes embedded quotes", () => {
    expect(git().writeUserIdentityCommands({ name: 'A"B', email: "" })).toEqual([
      `git config --global user.name "A\\"B"`,
    ]);
  });
  it("returns empty when both fields are empty", () => {
    expect(git().writeUserIdentityCommands({ name: "", email: "" })).toEqual([]);
  });
});
```

- [ ] **Step 5: Run tests — expect PASS**

Run: `npx vitest run src/vcs/git.test.ts`
Expected: PASS.

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
jj commit -m "feat: wire identity methods in git() provider"
```

---

### Task 5: Implement transport command builders in `git()`

**Files:**
- Modify: `src/vcs/git.ts`

**Method coverage:** `bundleAllRefs`, `cloneFromBundleCommands`, `exportPatchesCommand`, `importPatchesCommand`, `diffWorkingTreeCommand`, `applyPatchCommand`, `listUntrackedCommand`.

These are mostly pure command-string builders; only `bundleAllRefs` runs on the host.

- [ ] **Step 1: Inspect `src/syncIn.ts` and `src/syncOut.ts`** to read the exact current command strings. Cross-reference against the indexed snapshots:
  - `syncIn.ts:104`: `` `git bundle create "${bundleHostPath}" --all` `` (host)
  - `syncIn.ts:128`: `` `git clone "${bundleSandboxPath}" "${worktreePath}_clone"` `` (sandbox)
  - `syncIn.ts:138`: `` `git checkout "${branch}"` `` (sandbox)
  - `syncOut.ts`: `` `git format-patch "${hostHead}..HEAD" -o "${sandboxPatchDir}"` `` (sandbox)
  - `syncOut.ts`: `git diff HEAD` (sandbox)
  - `syncOut.ts`: `git ls-files --others --exclude-standard` (sandbox)
  - sync-out apply phase: `git am --3way` and `git apply` (host)

- [ ] **Step 2: Implement each method**

```ts
// On host: produces a bundle file at outBundlePath.
bundleAllRefs: async (repoDir, outBundlePath) => {
  await execFileAsync("git", ["bundle", "create", outBundlePath, "--all"], { cwd: repoDir });
},

// Returns the sequence of shell commands to run inside the sandbox.
// Caller wires them with handle.exec one-by-one.
cloneFromBundleCommands: ({ bundlePath, targetPath, branch }) => [
  `git clone "${bundlePath}" "${targetPath}_clone"`,
  `rm -rf "${targetPath}" && mv "${targetPath}_clone" "${targetPath}"`,
  `cd "${targetPath}" && git checkout "${branch}"`,
],

// Single shell command (run inside sandbox or against a checkout).
exportPatchesCommand: ({ base, outDir }) =>
  `git format-patch "${base}..HEAD" -o "${outDir}"`,

importPatchesCommand: ({ patchDir }) =>
  `git am --3way "${patchDir}"/*.patch`,

diffWorkingTreeCommand: () => `git diff HEAD`,

applyPatchCommand: ({ patchPath }) => `git apply "${patchPath}"`,

listUntrackedCommand: () => `git ls-files --others --exclude-standard`,
```

> **Decision rationale (in-line comment in the file):** `cloneFromBundleCommands` returns multiple commands rather than chaining with `&&` because the existing `syncIn.ts` flow runs them as separate `handle.exec` calls. Preserving that boundary keeps step-level error reporting intact.

- [ ] **Step 3: Add unit tests for command builders**

Append three small `it(...)` cases asserting that the returned strings exactly match the strings the existing code constructs today. Use property-style snapshots if simpler. Example:

```ts
describe("git() transport command builders", () => {
  it("builds the format-patch command", () => {
    expect(git().exportPatchesCommand({ base: "abc", outDir: "/tmp/p" }))
      .toBe(`git format-patch "abc..HEAD" -o "/tmp/p"`);
  });
  it("builds the apply command", () => {
    expect(git().applyPatchCommand({ patchPath: "/tmp/x.patch" }))
      .toBe(`git apply "/tmp/x.patch"`);
  });
  // ... one per builder
});
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run src/vcs/git.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat: wire transport command builders in git() provider"
```

---

### Task 6: Implement merge-back, mounts, recovery, and remaining methods in `git()`

**Files:**
- Modify: `src/vcs/git.ts`

**Method coverage:** `commitsBetween`, `detachCheckout`, `mergeBranchInto`, `deleteBranch`, `resolveRepoMounts`, `recoveryInstructions`.

- [ ] **Step 1: Implement each remaining method**

- `commitsBetween(repoDir, base, head)`: run `git rev-list "${base}..${head}"` via `execFile`, split stdout on newlines, filter empty, map each to `{ id }`.
- `detachCheckout(checkoutPath)`: run `git checkout --detach` in the checkout via `execFile`.
- `mergeBranchInto({ repoDir, sourceBranch, targetBranch })`: in `repoDir`, run `git checkout "${targetBranch}"` then `git merge "${sourceBranch}"`. (The current `SandboxLifecycle.ts` already does this against `hostSideWorktreePath` — verify whether merging happens in the worktree or in the host's main repo and replicate exactly.)
- `deleteBranch(repoDir, branch)`: run `git branch -D "${branch}"` in `repoDir`.
- `resolveRepoMounts({ checkoutPath, gitPath })`: re-export the existing `SandboxFactory::resolveGitMounts` logic. Easiest path: import `resolveGitMounts` from `../SandboxFactory.js`, run it via `Effect.runPromise(resolveGitMounts(gitPath).pipe(Effect.provide(NodeFileSystem.layer)))`, return the result. Note: `checkoutPath` is currently unused for git — it will matter for jj. Accepting it now keeps the signature stable.
- `recoveryInstructions({ patchDir, targetBranch })`: extract the user-facing recovery text from `src/RecoveryMessage.ts` exactly as it stands today (`git checkout <targetBranch>`, `git am --3way <patchDir>/*.patch`, `git apply <patchDir>/changes.patch`). Return as a single string with line breaks.

- [ ] **Step 2: Add unit tests for the pure builders (`recoveryInstructions`)**

```ts
it("builds a recovery instruction string for git", () => {
  const out = git().recoveryInstructions({ patchDir: "/tmp/x", targetBranch: "main" });
  expect(out).toContain("git checkout main");
  expect(out).toContain("git am --3way /tmp/x/*.patch");
  expect(out).toContain("git apply /tmp/x/changes.patch");
});
```

- [ ] **Step 3: Run tests — expect PASS**

Run: `npx vitest run src/vcs/git.test.ts`
Expected: PASS.

- [ ] **Step 4: Run full suite**

Run: `npm test`
Expected: PASS — all existing tests still green.

- [ ] **Step 5: Verify no `ni()` stubs remain**

Run: `grep -n "ni(" src/vcs/git.ts`
Expected: no matches (every method is wired).

- [ ] **Step 6: Commit**

```bash
jj commit -m "feat: complete git() provider — all interface methods wired"
```

---

## Chunk 3: Wire `vcs` option through public APIs and replace call sites

This chunk makes the abstraction live: every place that currently invokes git directly now goes through `vcs.<method>` obtained from the runtime option (defaulting to `git()`).

### Task 7: Add `vcs?: VersionControlProvider` to public option types

**Files:**
- Modify: `src/run.ts`
- Modify: `src/interactive.ts`
- Modify: `src/createSandbox.ts`
- Modify: `src/createWorktree.ts`

- [ ] **Step 1: For each of the four files, locate the public options interface** (`RunOptions`, `InteractiveOptions`, `CreateSandboxOptions`, `CreateWorktreeOptions`). Use LSP `goto_definition` on the type names from `src/index.ts`.

- [ ] **Step 2: Add `vcs?: VersionControlProvider` to each interface**

JSDoc:

```ts
/**
 * Version-control backend used for worktree/workspace creation, identity
 * propagation, and host-side merge-back. Defaults to {@link git}.
 *
 * @default git()
 */
readonly vcs?: VersionControlProvider;
```

Import `VersionControlProvider` from `./VersionControl.js`.

- [ ] **Step 3: Resolve `vcs` to its default at the entry of each function**

At the top of each function body:

```ts
const vcs = options.vcs ?? git();
```

Import `git` from `./vcs/git.js`.

- [ ] **Step 4: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: PASS — `vcs` is added but not yet used by call sites; behavior is unchanged.

- [ ] **Step 6: Commit**

```bash
jj commit -m "feat: add optional vcs option to run/interactive/createSandbox/createWorktree"
```

---

### Task 8: Replace worktree call sites with `vcs.<method>`

**Files:**
- Modify: `src/createWorktree.ts`
- Modify: `src/SandboxFactory.ts`
- Modify: `src/interactive.ts`
- Modify: `src/createSandbox.ts`

**Replacement table** (from indexed call sites):

| Current call | Replacement |
|---|---|
| `WorktreeManager.create(repoDir, { branch, baseBranch })` | `vcs.createCheckout({ repoDir, branch, baseBranch })` |
| `WorktreeManager.pruneStale(repoDir)` | `vcs.pruneStaleCheckouts(repoDir)` |
| `WorktreeManager.hasUncommittedChanges(path)` | `vcs.hasUncommittedChanges(path)` |
| `WorktreeManager.remove(path)` | `vcs.removeCheckout(path)` |
| `WorktreeManager.getCurrentBranch(d)` | `vcs.currentBranch(d)` |

- [ ] **Step 1: Use LSP `find_references` on each `WorktreeManager.*` symbol** to produce the exhaustive list of call sites. Cross-check against the indexed snapshot lines (e.g. `SandboxFactory.ts:215`, `:345`, `createWorktree.ts:226`, `:250`, `interactive.ts:256`, `:402`, `createSandbox.ts:820`).

- [ ] **Step 2: Replace each call site**, one file at a time. After each file, run `npm run typecheck` and `npm test`. The `vcs` parameter must be threaded into helper functions that previously took a `repoDir` only — accept the repository's existing convention (pass an additional argument or wrap in an options bag, matching neighbor code style).

- [ ] **Step 3: Run full suite after all replacements**

Run: `npm test`
Expected: PASS — same tests as before, identical results, because `git()` delegates to the same underlying implementation.

- [ ] **Step 4: Commit**

```bash
jj commit -m "refactor: route worktree call sites through vcs provider"
```

---

### Task 9: Replace identity, transport, merge-back, mounts, and recovery call sites

**Files:**
- Modify: `src/SandboxLifecycle.ts`
- Modify: `src/syncIn.ts`
- Modify: `src/syncOut.ts`
- Modify: `src/RecoveryMessage.ts`
- Modify: `src/SandboxFactory.ts` (remaining mount-related sites)

- [ ] **Step 1: `SandboxLifecycle.ts` — identity and merge-back**

- Replace the `git config user.name` / `git config user.email` reads with a single `vcs.readUserIdentity(hostRepoDir)` call.
- Replace the inline `git config --global` propagation commands with iteration over `vcs.writeUserIdentityCommands({ name, email })` and `execOkWithGitTimeout` for each command (preserve existing timeout semantics).
- Replace the `git rev-parse --abbrev-ref HEAD` call with `vcs.currentBranch(hostRepoDir)`.
- Replace the `git checkout --detach`, `git merge`, branch-delete sequence with `vcs.detachCheckout(...)`, `vcs.mergeBranchInto(...)`, `vcs.deleteBranch(...)`. The `hasNewCommits` short-circuit (`git rev-list ... --count`) becomes `(await vcs.commitsBetween(...)).length > 0`.

- [ ] **Step 2: `syncIn.ts` — bundle/clone**

- Replace `git bundle create ...` (host) with `await vcs.bundleAllRefs(hostRepoDir, bundleHostPath)`.
- Replace the inline `git clone` / `mv` / `git checkout` sequence (sandbox) with iteration over `vcs.cloneFromBundleCommands({ bundlePath: bundleSandboxPath, targetPath: worktreePath, branch })`, executing each via `execOk(handle, cmd, { cwd: ... })`.
- Replace `git rev-parse --abbrev-ref HEAD` (host) with `vcs.currentBranch`.
- Replace `git rev-parse HEAD` (host and sandbox) with `vcs.headRef`. Note: the sandbox-side check is a literal command exec inside the sandbox, not host-side — for now keep the literal `git rev-parse HEAD` exec inside the sandbox since the agent's environment is git regardless. Add an inline comment: `// Sandbox-side: agent environment is always git, even when host vcs is jj.`

- [ ] **Step 3: `syncOut.ts` — patches and diffs**

- Replace `git format-patch ...` exec with `execOk(handle, vcs.exportPatchesCommand({ base: hostHead, outDir: sandboxPatchDir }), ...)`.
- Replace `git diff HEAD` exec with `execOk(handle, vcs.diffWorkingTreeCommand(), ...)`.
- Replace `git ls-files --others --exclude-standard` exec with `execOk(handle, vcs.listUntrackedCommand(), ...)`.
- Replace host-side `git am --3way` and `git apply` calls with `vcs.importPatchesCommand({ patchDir })` and `vcs.applyPatchCommand({ patchPath })` respectively.

- [ ] **Step 4: `SandboxFactory.ts` — mounts**

- At the call site of `resolveGitMounts(gitPath)`, replace with `await vcs.resolveRepoMounts({ checkoutPath: worktreePath, gitPath })`.
- Keep the function `resolveGitMounts` exported from `SandboxFactory.ts` as-is — `git()` delegates to it. Don't remove it.

- [ ] **Step 5: `RecoveryMessage.ts` — recovery text**

- Replace the hardcoded recovery instruction string-builders with a single call to `vcs.recoveryInstructions({ patchDir, targetBranch })`.
- Thread `vcs` into the function signature; update its callers to pass `vcs`.

- [ ] **Step 6: After each file, run `npm run typecheck` and `npm test`**

Expected: PASS at every step. If a test fails, the call-site replacement diverged from the original behavior; debug and fix before proceeding.

- [ ] **Step 7: Run full suite a final time**

Run: `npm test`
Expected: PASS — every existing test green.

- [ ] **Step 8: Commit**

```bash
jj commit -m "refactor: route identity, transport, merge-back, mounts, recovery through vcs"
```

---

## Chunk 4: Public exports, packaging, changeset, final verification

### Task 10: Add public exports and subpath

**Files:**
- Modify: `src/index.ts`
- Modify: `package.json`

- [ ] **Step 1: Add type and value exports to `src/index.ts`**

Add after the existing `SandboxProvider` export block:

```ts
export type {
  VersionControlProvider,
  VersionControlTag,
  CheckoutInfo,
  CommitRef,
  RepoMount,
  UserIdentity,
} from "./VersionControl.js";
export { git } from "./vcs/git.js";
```

- [ ] **Step 2: Add subpath export to `package.json`**

In the `"exports"` object, add a sibling entry to `./sandboxes/docker`:

```json
"./vcs/git": {
  "import": "./dist/vcs/git.js",
  "types": "./dist/vcs/git.d.ts"
}
```

- [ ] **Step 3: Verify build emits the subpath**

Run: `npm run build`
Then: `ls dist/vcs/`
Expected: `git.js`, `git.d.ts` present.

- [ ] **Step 4: Verify typecheck and tests still pass**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat: export VersionControlProvider types and git factory"
```

---

### Task 11: Add changeset

**Files:**
- Create: `.changeset/<descriptive-name>.md`

- [ ] **Step 1: Check existing changesets first to avoid duplicates**

Run: `ls .changeset/*.md`

If a changeset already covers this work, edit it; otherwise create a new one.

- [ ] **Step 2: Create the changeset** (per project `CLAUDE.md`: all changesets are `patch`):

```markdown
---
"@ai-hero/sandcastle": patch
---

Add an optional `vcs` option to `run()`, `interactive()`, `createSandbox()`, and `createWorktree()`. Defaults to `git()`, which preserves all existing behavior. The new `VersionControlProvider` interface is the seam through which alternative VCS backends (such as Jujutsu, in a follow-up release) can be implemented.

This change is a pure refactor — no observable behavior changes for existing callers.
```

- [ ] **Step 3: Commit**

```bash
jj commit -m "chore: add changeset for vcs abstraction refactor"
```

---

### Task 12: Final verification

**Files:** none modified.

- [ ] **Step 1: Run formatting check**

Run: `npm run format:check`
Expected: PASS. If it fails, run `npm run format` and commit any formatting fixes as a separate commit (`chore: format`).

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — zero errors.

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: PASS — every test green, identical results to pre-PR baseline.

- [ ] **Step 4: Run the build**

Run: `npm run build`
Expected: PASS. `dist/vcs/git.{js,d.ts}` exist. `dist/VersionControl.d.ts` exists.

- [ ] **Step 5: Diff review — search for residual direct git invocations that should have been routed through `vcs`**

Run: `grep -nE 'execFile.*"git"|execAsync.*"git "|spawn.*"git"' src/*.ts | grep -v '/vcs/' | grep -v WorktreeManager.ts | grep -v SandboxFactory.ts`

Expected: results should only be in `WorktreeManager.ts`, `SandboxFactory.ts::resolveGitMounts`, or commented-out lines. Anywhere else means the refactor missed a call site.

- [ ] **Step 6: Smoke-test the actual CLI**

Run: `npm run sandcastle -- --help` (or equivalent that exercises the import path)
Expected: PASS — no runtime errors related to missing vcs methods.

- [ ] **Step 7: Open the PR**

Title: `refactor: extract VersionControlProvider abstraction`

PR body should clearly state:
- "This is a pure refactor. Zero behavior change."
- "Introduces an optional `vcs` parameter defaulting to `git()`, which is the only implementation in this PR."
- "Follow-up PR will add `JjProvider` for Jujutsu support."
- Link to this plan document.

- [ ] **Step 8: Self-review the diff**

Walk the entire diff yourself before requesting review. Verify each modified file:
- Has no commented-out code left over from the refactor.
- Has no `console.log` debugging.
- Imports are alphabetized / grouped consistently with neighboring code.

---

## Acceptance criteria

PR 1 is complete when:

1. ✅ `npm run typecheck` passes with zero errors.
2. ✅ `npm test` passes with the same number of green tests as on `main` (no skipped tests, no new failures).
3. ✅ `npm run format:check` passes.
4. ✅ `npm run build` produces `dist/vcs/git.{js,d.ts}` and the subpath export resolves.
5. ✅ The diff contains no functional changes — every change is moving call sites from direct git invocations to `vcs.<method>` calls, defaulting to `git()`.
6. ✅ Importing `import { git } from "@ai-hero/sandcastle/vcs/git"` resolves and returns a working provider.
7. ✅ A `patch` changeset exists describing the change.

---

## Notes for the implementing agent

- **Don't refactor things that aren't strictly needed.** If you find yourself "improving" code that isn't on the path of the refactor, stop. The PR's value comes from being a tight, reviewable, behavior-preserving change.
- **Don't rename anything in the public API.** `BranchStrategy`, `Worktree`, `WorktreeBranchStrategy` etc. all stay. The whole point of "no rename" is that this PR is invisible to existing users.
- **If a test fails after a refactor step, the refactor diverged.** Don't update the test to fit the new behavior — restore the old behavior. The contract is "zero behavior change."
- **Use LSP, then ast-grep, then grep** when locating call sites (per `~/.claude/CLAUDE.md`). LSP `find_references` on `WorktreeManager.create`, `WorktreeManager.pruneStale`, etc. is the highest-signal way to be sure you've found every call site.
- **One commit per task.** Twelve commits total roughly mirrors twelve tasks. Frequent small commits make rollback cheap if a single task introduces a regression.
- **The brainstorming/grilling that produced this plan** lived in conversation; design rationale is captured in the plan header and in the design table at the start of PR 2's plan (when written).
