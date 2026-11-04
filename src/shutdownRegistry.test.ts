import { afterEach, describe, expect, it, vi } from "vitest";
import { registerShutdown } from "./shutdownRegistry.js";

describe("shutdownRegistry", () => {
  let restoreExit: (() => void) | undefined;

  afterEach(() => {
    restoreExit?.();
    restoreExit = undefined;
  });

  // Like the real process.exit, the stub never returns: it throws, so the
  // signal handler stops where the process would have ended.
  const stubExit = () => {
    const spy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    restoreExit = () => {
      spy.mockRestore();
    };
    return spy;
  };

  /** Emits a signal whose handler ends by calling the stubbed process.exit. */
  const emitExitingSignal = (signal: "SIGINT" | "SIGTERM") => {
    expect(() => process.emit(signal)).toThrow("process.exit called");
  };

  it("installs one listener per signal regardless of how many shutdowns are registered", () => {
    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");
    const exitBefore = process.listenerCount("exit");

    const unregisters = Array.from({ length: 25 }, () =>
      registerShutdown(() => {}),
    );

    expect(process.listenerCount("SIGINT")).toBe(sigintBefore + 1);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore + 1);
    expect(process.listenerCount("exit")).toBe(exitBefore + 1);

    for (const unregister of unregisters) {
      unregister();
    }

    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
    expect(process.listenerCount("exit")).toBe(exitBefore);
  });

  it("runs every registered teardown then exits once with code 1 on SIGINT", () => {
    const exit = stubExit();
    const calls: string[] = [];
    const u1 = registerShutdown(() => {
      calls.push("a");
    });
    const u2 = registerShutdown(() => {
      calls.push("b");
    });

    emitExitingSignal("SIGINT");

    expect(calls).toStrictEqual(["a", "b"]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);

    u1();
    u2();
  });

  it("runs registered teardowns on SIGTERM", () => {
    stubExit();
    const calls: string[] = [];
    const u1 = registerShutdown(() => {
      calls.push("x");
    });

    emitExitingSignal("SIGTERM");

    expect(calls).toStrictEqual(["x"]);
    u1();
  });

  it("runs registered teardowns on a plain exit", () => {
    const calls: string[] = [];
    const u1 = registerShutdown(() => {
      calls.push("e");
    });

    process.emit("exit", 0);

    expect(calls).toStrictEqual(["e"]);
    u1();
  });

  it("detaches its listeners while handling a signal so process.exit's exit event cannot re-run teardowns", () => {
    stubExit();
    const sigintBefore = process.listenerCount("SIGINT");
    const exitBefore = process.listenerCount("exit");
    const u1 = registerShutdown(() => {});

    emitExitingSignal("SIGINT");

    // The handler removes every listener before calling process.exit(1), so the
    // synchronous "exit" event the real exit fires finds nothing to run again.
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    expect(process.listenerCount("exit")).toBe(exitBefore);
    u1();
  });

  it("does not run a teardown after it has been unregistered", () => {
    stubExit();
    const calls: string[] = [];
    const stay = registerShutdown(() => {
      calls.push("stay");
    });
    const gone = registerShutdown(() => {
      calls.push("gone");
    });

    gone();
    emitExitingSignal("SIGINT");

    expect(calls).toStrictEqual(["stay"]);
    stay();
  });

  it("a throwing teardown does not prevent the others from running", () => {
    stubExit();
    const calls: string[] = [];
    const u1 = registerShutdown(() => {
      throw new Error("boom");
    });
    const u2 = registerShutdown(() => {
      calls.push("ran");
    });

    emitExitingSignal("SIGINT");

    expect(calls).toStrictEqual(["ran"]);
    u1();
    u2();
  });

  it("unregister is idempotent", () => {
    const exitBefore = process.listenerCount("exit");
    const unreg = registerShutdown(() => {});
    unreg();
    unreg();
    expect(process.listenerCount("exit")).toBe(exitBefore);
  });
});
