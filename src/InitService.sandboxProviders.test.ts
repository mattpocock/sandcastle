import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { ConfigProvider, Effect, Layer } from "effect";
import { afterEach, assert, beforeEach, describe, expect, it } from "vitest";
import {
  agentCliWarning,
  getAgent,
  getSandboxProvider,
  listSandboxProviders,
} from "./InitService.js";

const fakeFsLayer = (
  files: Readonly<Record<string, string>>,
): Layer.Layer<FileSystem.FileSystem> =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const realFs = yield* FileSystem.FileSystem;
      const sampleFile = yield* realFs
        .stat(import.meta.filename)
        .pipe(Effect.orDie);
      return FileSystem.makeNoop({
        stat: (path) =>
          path in files
            ? Effect.succeed(sampleFile)
            : realFs.stat("/nonexistent-sandcastle-test-path"),
        realPath: (path) => {
          const target = files[path];
          return target === undefined
            ? realFs.realPath("/nonexistent-sandcastle-test-path")
            : Effect.succeed(target);
        },
      });
    }),
  ).pipe(Layer.provide(NodeFileSystem.layer));

describe("Sandbox provider registry", () => {
  it("listSandboxProviders returns docker and podman", () => {
    const providers = listSandboxProviders();
    expect(providers.some((p) => p.name === "docker")).toBe(true);
    expect(providers.some((p) => p.name === "podman")).toBe(true);
  });

  it("getSandboxProvider returns docker entry", () => {
    const provider = getSandboxProvider("docker");
    assert.isDefined(provider);
    expect(provider.image?.containerfileName).toBe("Dockerfile");
    expect(provider.image?.cliNamespace).toBe("docker");
  });

  it("getSandboxProvider returns podman entry", () => {
    const provider = getSandboxProvider("podman");
    assert.isDefined(provider);
    expect(provider.image?.containerfileName).toBe("Containerfile");
    expect(provider.image?.cliNamespace).toBe("podman");
  });

  it("getSandboxProvider returns undefined for unknown provider", () => {
    expect(getSandboxProvider("nonexistent")).toBeUndefined();
  });
});

describe("agentCliWarning", () => {
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env["HOME"];
    process.env["HOME"] = "/home/dev";
  });

  afterEach(() => {
    process.env["HOME"] = originalHome;
  });

  const runWarning = async (options: {
    readonly path: string;
    readonly files: Readonly<Record<string, string>>;
    readonly providerName?: string;
  }): Promise<string | undefined> => {
    const agent = getAgent("claude-code");
    const provider = getSandboxProvider(options.providerName ?? "bwrap");
    assert.isDefined(agent);
    assert.isDefined(provider);
    const configProvider = ConfigProvider.fromMap(
      new Map([["PATH", options.path]]),
    );
    return Effect.runPromise(
      agentCliWarning(agent, provider).pipe(
        Effect.withConfigProvider(configProvider),
        Effect.provide(fakeFsLayer(options.files)),
      ),
    );
  };

  it.each([
    ["/mnt/c/Users/dev/AppData/Local/Programs/claude"],
    ["/run/WSL/bin"],
    ["/home/dev"],
    ["/home"],
  ])(
    "warns for bwrap when the agent CLI is found only under %s",
    async (dir) => {
      const cli = `${dir}/claude`;
      const warning = await runWarning({
        path: dir,
        files: { [cli]: cli },
      });

      expect(warning).toContain("curl -fsSL https://claude.ai/install.sh");
    },
  );

  it("warns for bwrap when a PATH entry symlinks the CLI into /mnt", async () => {
    const warning = await runWarning({
      path: "/usr/local/bin",
      files: {
        "/usr/local/bin/claude":
          "/mnt/c/Users/dev/AppData/Local/Programs/claude/claude.exe",
      },
    });

    expect(warning).toContain("curl -fsSL https://claude.ai/install.sh");
  });

  it("returns undefined when the agent CLI is on an allowed path alongside /mnt", async () => {
    const warning = await runWarning({
      path: "/mnt/c/bin:/home/dev/.local/bin",
      files: {
        "/mnt/c/bin/claude": "/mnt/c/bin/claude",
        "/home/dev/.local/bin/claude": "/home/dev/.local/bin/claude",
      },
    });

    expect(warning).toBeUndefined();
  });
});
