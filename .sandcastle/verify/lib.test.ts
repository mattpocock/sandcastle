import { afterEach, describe, expect, it, vi } from "vitest";
import { cheapAgentCall, cheapModel } from "./lib.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("cheapAgentCall", () => {
  it("passes thinking: off to pi, whose default thinking its cheap model rejects", () => {
    vi.stubEnv("VERIFY_MODEL", "");
    expect(cheapAgentCall("pi")).toBe(
      'pi("anthropic/claude-haiku-5-5", { thinking: "off" })',
    );
  });

  it("is the bare factory call for an agent that needs no options", () => {
    vi.stubEnv("VERIFY_MODEL", "");
    expect(cheapAgentCall("claudeCode")).toBe('claudeCode("claude-haiku-5-5")');
  });

  it("drops the options when VERIFY_MODEL picks another model", () => {
    vi.stubEnv("VERIFY_MODEL", "anthropic/claude-sonnet-4-6");
    expect(cheapModel("pi")).toBe("anthropic/claude-sonnet-4-6");
    expect(cheapAgentCall("pi")).toBe('pi("anthropic/claude-sonnet-4-6")');
  });
});
