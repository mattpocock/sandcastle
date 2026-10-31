Wherever possible, use Effect primitives like `FileSystem` over promises. This is so that we can make use of DI and type-safe errors from Effect. However, Effect should not leak out into the user-facing API.

Even if the outer function is a promise (such as in user-facing API's) the inner function should immediately delegate to Effect. Running multiple `.runPromise`'s inside a single function should be a red flag that we need to refactor to something like this:

```ts
const outerFunc = async () => {
  const inner = Effect.gen(function* () {
    // Do stuff in here
  }).pipe(Effect.runPromise);
};
```

---

Never use `new Error()` inside an Effect closure (e.g. `Effect.fail(new Error(...))` or the `catch` of `Effect.tryPromise`). Always fail with a tagged error from `errors.ts` (or define a new `Data.TaggedError` if none fits). Raw `Error` widens the inferred error channel to a generic `Error` / `unknown` and erases the type-safe error tracking Effect gives us — downstream `Effect.catchTag` / `Effect.catchAll` lose the discriminant they need to recover narrowly. The same rule applies to functions returning Effects: their failure channel should be a tagged-error union, never a bare `Error`.

```ts
// BAD: raw Error widens the failure channel
Effect.tryPromise({
  try: () => doThing(),
  catch: (e) =>
    new Error(`Failed: ${e instanceof Error ? e.message : String(e)}`),
});

// GOOD: tagged error — failure channel stays narrow and discriminated
Effect.tryPromise({
  try: () => doThing(),
  catch: (e) =>
    new WorktreeError({
      message: `Failed: ${e instanceof Error ? e.message : String(e)}`,
    }),
});
```

---

Before writing a changeset, explore other potentially related changesets so you don't duplicate effort.

You may write more than one changeset per commit, if the commit touches multiple user-facing behaviors.

---

When writing sandbox providers, don't share provider-specific code between them. Each provider — for instance Vercel and Daytona — integrates a different SDK and is a different concern; that integration logic must not be shared, even when two providers look similar today, because they will diverge.

The one exception is **pure, provider-agnostic utilities**: logic that references no provider SDK, no provider config, and whose behavior is purely a function of its inputs (e.g. a bounded string-tail buffer). These may live in a shared module. Test: if you can't tell which provider a function is for by reading it, it's a utility, not a shared abstraction.

---

`exec` with an `onLine` callback must call `onLine` in real-time as output arrives, not after the command completes. The orchestrator uses `onLine` callbacks to reset an idle timeout — if lines aren't emitted during execution, the timeout will fire prematurely or hangs won't be detected. Always use a streaming/WebSocket-based API from the underlying SDK, never execute-then-split.

---

Any public-facing properties or functions should have JSDOC comments explaining them.

---

Do not use lazy `import()`-style imports when importing Node built-ins. Just use imports.

---

Paths destined for the sandbox container (passed to `copyFileIn` / `copyFileOut` / `exec`, or stored as a sandbox cwd / projects dir) are always Linux paths. Use `posix.join` from `node:path`, not the bare platform-aware `join` — on Windows hosts the latter emits `\` separators, and `docker cp` / `podman cp` reject them silently (the run continues but data is lost).

Host-side paths (anything under `tmpdir()`, `hostRepoDir`, the host projects dir) should keep using platform-aware `join`.

---

When comparing two paths — `===`, `startsWith`, `Set.has`, `.includes`, etc. — normalize separators on both sides first (e.g. `p.replace(/\\/g, "/")`). `git` reports forward slashes on every platform, while `node:path.join`/`normalize` emit `\` on Windows, so a raw comparison between a git-derived path and a join-derived path silently fails on Windows. This is invisible on Linux/macOS CI because both sources emit `/` there, so it will not surface in tests unless you deliberately mix the two separator styles. When the result is returned for downstream `join`/fs use, re-apply platform-native `normalize` so callers get consistent separators; only the comparison needs forward slashes.

---

Optional parameters passed to functions should be scrutinised extremely carefully. They are a huge source of bugs (by omission). Prioritise correctness over backwards compatibility.

---

Every interactive prompt in the `sandcastle init` flow must be paired with a non-interactive CLI flag that resolves the same choice. They are linked: adding a new prompt without adding the matching flag breaks scripted / CI setup (no TTY → the prompt wedges or crashes), and adding a flag without wiring it into the prompt path leaves the interactive experience inconsistent. When stdin is not a TTY and the flag is absent for a prompt that would otherwise fire, fail fast with a message naming the missing flag rather than letting the prompt library crash. New prompt + new flag land in the same change.

---

If you need to provide an override to a function or modules' behavior during tests, don't use an `@internal` property, like so:

```ts
// BAD
type Example = {
  /** @internal Test-only override for the idle warning interval in milliseconds. Default: 60000 (1 minute). */
  readonly _idleWarningIntervalMs?: number;
  /** @internal Override for the host projects directory (for testing). */
  readonly _hostProjectsDir?: string;
  /** @internal Override for the sandbox projects directory (for testing). */
  readonly _sandboxProjectsDir?: string;
};
```

Instead, create a config layer using Effect for that function, then instantiate that differently in tests and in production. This helps keep the code cleaner. Don't make this layer optional - that adds more indirection to all layers of the code.

## The lint ratchet

`npm run lint` runs oxlint (every category but `restriction` and `nursery` as errors, type-aware, `.oxlintrc.json`) and every Effect language service diagnostic (the `tsconfig.json` plugin). The compiler itself is not ratcheted: `npm run typecheck` passes clean. Code that broke a rule when the linter landed is counted, per file and rule, in `scripts/lint-baseline.json`. `scripts/lint-ratchet.ts` holds the code to that baseline, and the baseline only ever shrinks:

- A new violation fails — a count going up, or a file or rule the baseline lacks. Fix it. Never raise the baseline.
- A fixed violation also fails until the baseline is lowered to match. Run `npm run lint:shrink`, which lowers counts and drops entries at zero but never raises one, and commit the baseline with the fix.
- A baseline that grew against `origin/main` fails.

No disable comments (`eslint-disable`, `oxlint-disable`, `@ts-ignore`, `@ts-expect-error`, `@effect-diagnostics`) outside the reviewed allowlist in `scripts/lint-ratchet-config.ts`; each one counts as `ratchet/disable-comment`. The same file names the Effect entry points (the only modules that may call `Effect.runPromise` and friends) and the test-only Effect exemptions. `.oxlintrc.json` may not grow a per-file override.

To pay down debt, pick a rule or a file from `npm run lint:report`, fix every violation of it, run `npm run lint:shrink`, and land the fix and the lower baseline together. Fix behaviour-neutrally: one rule or one file per PR, no autofix sweeps across the repo.

---

## Testing

### Core Principle

Tests verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't break unless behavior changed.

### Good Tests

Integration-style tests that exercise real code paths through public APIs. They describe _what_ the system does, not _how_.

```typescript
// GOOD: Tests observable behavior through the public interface
test("createUser makes user retrievable", async () => {
  const user = await createUser({ name: "Alice" });
  const retrieved = await getUser(user.id);
  expect(retrieved.name).toBe("Alice");
});
```

- Test behavior users/callers care about
- Use the public API only
- Survive internal refactors
- One logical assertion per test

### Bad Tests

```typescript
// BAD: Mocks internal collaborator, tests HOW not WHAT
test("checkout calls paymentService.process", async () => {
  const mockPayment = jest.mock(paymentService);
  await checkout(cart, payment);
  expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});

// BAD: Bypasses the interface to verify via database
test("createUser saves to database", async () => {
  await createUser({ name: "Alice" });
  const row = await db.query("SELECT * FROM users WHERE name = ?", ["Alice"]);
  expect(row).toBeDefined();
});
```

Red flags:

- Mocking internal collaborators (your own classes/modules)
- Testing private methods
- Asserting on call counts/order of internal calls
- Test breaks when refactoring without behavior change
- Test name describes HOW not WHAT
- Verifying through external means (e.g. querying a DB) instead of through the interface

### Mocking

Mock at **system boundaries** only:

- External APIs (payment, email, etc.)
- Time/randomness
- File system or databases when a real instance isn't practical

**Never mock your own classes/modules or internal collaborators.** If something is hard to test without mocking internals, redesign the interface.

Prefer SDK-style interfaces over generic fetchers at boundaries — each function is independently mockable with a single return shape, no conditional logic in test setup.

### TDD Workflow: Vertical Slices

Do NOT write all tests first, then all implementation. That produces tests that verify _imagined_ behavior and are insensitive to real changes.

Correct approach — one test, one implementation, repeat:

```
RED→GREEN: test1→impl1
RED→GREEN: test2→impl2
RED→GREEN: test3→impl3
```

Each test responds to what you learned from the previous cycle. Never refactor while RED — get to GREEN first.

## Interface Design

### Deep Modules

Prefer deep modules: small interface, deep implementation. A few methods with simple params hiding complex logic behind them.

Avoid shallow modules: large interface with many methods that just pass through to thin implementation. When designing, ask: can I reduce the number of methods? Can I simplify the parameters? Can I hide more complexity inside?

### Design for Testability

1. **Accept dependencies, don't create them** — pass external dependencies in rather than constructing them internally.
2. **Return results, don't produce side effects** — a function that returns a value is easier to test than one that mutates state.
3. **Small surface area** — fewer methods = fewer tests needed, fewer params = simpler test setup.
