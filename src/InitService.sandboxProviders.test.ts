import { assert, describe, expect, it } from "vitest";
import { listSandboxProviders, getSandboxProvider } from "./InitService.js";

describe("Sandbox provider registry", () => {
  it("listSandboxProviders returns docker and podman", () => {
    const providers = listSandboxProviders();
    expect(providers.some((p) => p.name === "docker")).toBe(true);
    expect(providers.some((p) => p.name === "podman")).toBe(true);
  });

  it("getSandboxProvider returns docker entry", () => {
    const provider = getSandboxProvider("docker");
    assert.isDefined(provider);
    expect(provider.containerfileName).toBe("Dockerfile");
    expect(provider.cliNamespace).toBe("docker");
  });

  it("getSandboxProvider returns podman entry", () => {
    const provider = getSandboxProvider("podman");
    assert.isDefined(provider);
    expect(provider.containerfileName).toBe("Containerfile");
    expect(provider.cliNamespace).toBe("podman");
  });

  it("getSandboxProvider returns undefined for unknown provider", () => {
    expect(getSandboxProvider("nonexistent")).toBeUndefined();
  });
});
