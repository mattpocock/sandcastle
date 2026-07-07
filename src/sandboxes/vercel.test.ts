import { describe, expect, it } from "vitest";
import { vercel } from "./vercel.js";

describe("vercel()", () => {
  it("returns a SandboxProvider with tag 'isolated' and name 'vercel'", () => {
    const provider = vercel();
    expect(provider.tag).toBe("isolated");
    expect(provider.name).toBe("vercel");
  });

  it("has a create function", () => {
    const provider = vercel();
    expect(typeof provider.create).toBe("function");
  });

  it("accepts a token option", () => {
    // Should not throw
    const provider = vercel({ token: "my-token" });
    expect(provider.tag).toBe("isolated");
  });

  it("passes through Vercel SDK options", () => {
    // Should not throw when arbitrary SDK options are provided
    const provider = vercel({
      template: "node-22",
      timeoutMs: 30_000,
    });
    expect(provider.tag).toBe("isolated");
  });

  it("accepts persistent and fetch pass-through options", () => {
    // Should not throw
    const provider = vercel({
      persistent: false,
      fetch: globalThis.fetch,
    });
    expect(provider.tag).toBe("isolated");
  });

  it("accepts an env option", () => {
    const provider = vercel({ env: { VERCEL_VAR: "value" } });
    expect(provider.tag).toBe("isolated");
    expect(provider.env).toEqual({ VERCEL_VAR: "value" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = vercel();
    expect(provider.env).toEqual({});
  });
});
