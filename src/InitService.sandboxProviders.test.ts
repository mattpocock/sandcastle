import { describe, expect, it } from "vitest";
import { listSandboxProviders, getSandboxProvider } from "./InitService.js";

describe("Sandbox provider registry", () => {
  it("listSandboxProviders returns every built-in local provider", () => {
    const providers = listSandboxProviders();
    expect(providers.some((p) => p.name === "docker")).toBe(true);
    expect(providers.some((p) => p.name === "podman")).toBe(true);
    expect(providers.some((p) => p.name === "apple-container")).toBe(true);
  });

  it("getSandboxProvider returns docker entry", () => {
    const provider = getSandboxProvider("docker");
    expect(provider).toBeDefined();
    expect(provider!.containerfileName).toBe("Dockerfile");
    expect(provider!.cliNamespace).toBe("docker");
  });

  it("getSandboxProvider returns podman entry", () => {
    const provider = getSandboxProvider("podman");
    expect(provider).toBeDefined();
    expect(provider!.containerfileName).toBe("Containerfile");
    expect(provider!.cliNamespace).toBe("podman");
  });

  it("getSandboxProvider returns Apple Container entry", () => {
    const provider = getSandboxProvider("apple-container");
    expect(provider).toBeDefined();
    expect(provider!.factoryImport).toBe("appleContainer");
    expect(provider!.importSubpath).toBe("apple-container");
    expect(provider!.containerfileName).toBe("Dockerfile");
    expect(provider!.cliNamespace).toBe("apple-container");
  });

  it("getSandboxProvider returns undefined for unknown provider", () => {
    expect(getSandboxProvider("nonexistent")).toBeUndefined();
  });
});
