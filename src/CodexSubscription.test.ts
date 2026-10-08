import { describe, expect, it, vi } from "vitest";
import { ensureCodexSubscriptionLogin } from "./CodexSubscription.js";

describe("ensureCodexSubscriptionLogin", () => {
  it("checks and logs in against the project-isolated CODEX_HOME", () => {
    const run = vi
      .fn()
      .mockImplementationOnce(() => ({ status: 1 }))
      .mockImplementationOnce(() => ({ status: 0 }));

    expect(ensureCodexSubscriptionLogin("/repo", run)).toBe("authenticated");
    expect(run).toHaveBeenNthCalledWith(
      1,
      "codex",
      ["login", "status"],
      expect.objectContaining({
        cwd: "/repo",
        env: expect.objectContaining({
          CODEX_HOME: "/repo/.sandcastle/codex-home",
        }),
      }),
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      "codex",
      ["login"],
      expect.objectContaining({
        cwd: "/repo",
        stdio: "inherit",
        env: expect.objectContaining({
          CODEX_HOME: "/repo/.sandcastle/codex-home",
        }),
      }),
    );
  });

  it("does not start a browser login when the isolated home is authenticated", () => {
    const run = vi.fn(() => ({ status: 0 }));

    expect(ensureCodexSubscriptionLogin("/repo", run)).toBe(
      "already-authenticated",
    );
    expect(run).toHaveBeenCalledTimes(1);
  });
});
