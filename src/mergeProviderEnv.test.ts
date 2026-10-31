import { describe, expect, it } from "vitest";
import { mergeProviderEnv } from "./mergeProviderEnv.js";

describe("mergeProviderEnv", () => {
  it("returns env resolver output when no provider env is set", () => {
    const result = mergeProviderEnv({
      resolvedEnv: { FOO: "bar" },
      agentProviderEnv: {},
      sandboxProviderEnv: {},
    });
    expect(result).toStrictEqual({ FOO: "bar" });
  });

  it("agent provider env overrides env resolver output", () => {
    const result = mergeProviderEnv({
      resolvedEnv: { FOO: "old" },
      agentProviderEnv: { FOO: "new" },
      sandboxProviderEnv: {},
    });
    expect(result).toStrictEqual({ FOO: "new" });
  });

  it("sandbox provider env overrides env resolver output", () => {
    const result = mergeProviderEnv({
      resolvedEnv: { FOO: "old" },
      agentProviderEnv: {},
      sandboxProviderEnv: { FOO: "new" },
    });
    expect(result).toStrictEqual({ FOO: "new" });
  });

  it("merges all three sources with provider env taking precedence", () => {
    const result = mergeProviderEnv({
      resolvedEnv: { A: "1", B: "2", C: "3" },
      agentProviderEnv: { A: "agent" },
      sandboxProviderEnv: { B: "sandbox" },
    });
    expect(result).toStrictEqual({ A: "agent", B: "sandbox", C: "3" });
  });

  it("throws when agent and sandbox provider env have overlapping keys", () => {
    expect(() =>
      mergeProviderEnv({
        resolvedEnv: {},
        agentProviderEnv: { SHARED: "from-agent" },
        sandboxProviderEnv: { SHARED: "from-sandbox" },
      }),
    ).toThrow(/overlapping env/i);
    expect(() =>
      mergeProviderEnv({
        resolvedEnv: {},
        agentProviderEnv: { SHARED: "from-agent" },
        sandboxProviderEnv: { SHARED: "from-sandbox" },
      }),
    ).toThrow("SHARED");
  });

  it("allows same key in provider env and resolved env (override)", () => {
    const result = mergeProviderEnv({
      resolvedEnv: { KEY: "resolved" },
      agentProviderEnv: { KEY: "agent" },
      sandboxProviderEnv: {},
    });
    expect(result).toStrictEqual({ KEY: "agent" });
  });
});
