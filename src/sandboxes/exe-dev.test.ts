import { describe, expect, it } from "vitest";
import { exeDev } from "./exe-dev.js";

describe("exeDev()", () => {
  it("returns a SandboxProvider with tag 'isolated' and name 'exe-dev'", () => {
    const provider = exeDev();
    expect(provider.tag).toBe("isolated");
    expect(provider.name).toBe("exe-dev");
  });

  it("has a create function", () => {
    const provider = exeDev();
    expect(typeof provider.create).toBe("function");
  });

  it("constructs without sshKeyPath (relies on SSH agent / default key)", () => {
    const provider = exeDev({});
    expect(provider.tag).toBe("isolated");
  });

  it("accepts an sshKeyPath option", () => {
    const provider = exeDev({ sshKeyPath: "~/.ssh/id_exe" });
    expect(provider.tag).toBe("isolated");
  });

  it("accepts an explicit tags override", () => {
    const provider = exeDev({ tags: ["ci", "nightly"] });
    expect(provider.tag).toBe("isolated");
  });

  it("accepts an empty tags array", () => {
    const provider = exeDev({ tags: [] });
    expect(provider.tag).toBe("isolated");
  });

  it("accepts an env option", () => {
    const provider = exeDev({ env: { FOO: "bar" } });
    expect(provider.env).toEqual({ FOO: "bar" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = exeDev();
    expect(provider.env).toEqual({});
  });
});
