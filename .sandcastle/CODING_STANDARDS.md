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

Before writing a changeset, explore other potentially related changesets so you don't duplicate effort.

You may write more than one changeset per commit, if the commit touches multiple user-facing behaviors.

---

When writing sandbox providers, don't use any shared abstractions between them. Each provider, for instance Vercel and Daytona, is a different concern and shouldn't share code.

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

Optional parameters passed to functions should be scrutinised extremely carefully. They are a huge source of bugs (by omission). Prioritise correctness over backwards compatibility.

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
