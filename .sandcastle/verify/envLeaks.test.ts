import { describe, expect, it } from "vitest";
import { classifyEnv } from "./envLeaks.ts";

const ctx = {
  declared: new Set(["CLAUDE_CODE_OAUTH_TOKEN"]),
  hostSecrets: new Map([
    ["CLAUDE_CODE_OAUTH_TOKEN", "oauth-value-123"],
    ["ANTHROPIC_API_KEY", "api-value-456"],
  ]),
  canary: "canary-abc",
};

describe("classifyEnv", () => {
  it("passes declared keys and ordinary image env", () => {
    expect(
      classifyEnv(
        [
          ["CLAUDE_CODE_OAUTH_TOKEN", "oauth-value-123"],
          ["HOME", "/home/agent"],
          ["PATH", "/usr/bin"],
        ],
        ctx,
      ),
    ).toEqual([]);
  });

  it("flags an undeclared host secret by name", () => {
    expect(classifyEnv([["ANTHROPIC_API_KEY", "x"]], ctx)).toEqual([
      {
        name: "ANTHROPIC_API_KEY",
        reason: "a host secret the world never declared",
      },
    ]);
  });

  it("flags an undeclared host secret's value under another name", () => {
    expect(classifyEnv([["OTHER", "pre-api-value-456"]], ctx)[0]?.name).toBe(
      "OTHER",
    );
  });

  it("flags the canary wherever it appears", () => {
    expect(
      classifyEnv([["CLAUDE_CODE_OAUTH_TOKEN", "canary-abc"]], ctx)[0]?.reason,
    ).toMatch(/canary/);
  });
});
