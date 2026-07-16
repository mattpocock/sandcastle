import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  scaffold,
  getAgent,
  listAgents,
  resolveJavaVersion,
  DEFAULT_JAVA_VERSION,
} from "./InitService.js";
import type { ScaffoldOptions } from "./InitService.js";

const makeDir = () => mkdtemp(join(tmpdir(), "init-service-"));

const claudeCodeAgent = getAgent("claude-code")!;

const defaultOptions: ScaffoldOptions = {
  agent: claudeCodeAgent,
  model: "claude-opus-4-8",
};

const runScaffold = (repoDir: string, options?: Partial<ScaffoldOptions>) =>
  Effect.runPromise(
    scaffold(repoDir, { ...defaultOptions, ...options }).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );

const resolve = (dir: string) =>
  Effect.runPromise(
    resolveJavaVersion(dir).pipe(Effect.provide(NodeFileSystem.layer)),
  );

const SDKMANRC = `# Enable auto-env through the sdkman_auto_env config
# Add key=value pairs of SDKs to use below
java=25.0.1-open
`;

describe("resolveJavaVersion", () => {
  it("given a .sdkmanrc with a java entry then returns its identifier", async () => {
    const dir = await makeDir();
    await writeFile(join(dir, ".sdkmanrc"), SDKMANRC);
    expect(await resolve(dir)).toBe("25.0.1-open");
  });

  it("given a pom.xml without .sdkmanrc then falls back to the default version", async () => {
    const dir = await makeDir();
    await writeFile(join(dir, "pom.xml"), "<project></project>");
    expect(await resolve(dir)).toBe(DEFAULT_JAVA_VERSION);
  });

  it("given a .sdkmanrc without a java entry but a pom.xml then falls back to the default version", async () => {
    const dir = await makeDir();
    await writeFile(join(dir, ".sdkmanrc"), "# no sdk entries\n");
    await writeFile(join(dir, "pom.xml"), "<project></project>");
    expect(await resolve(dir)).toBe(DEFAULT_JAVA_VERSION);
  });

  it("given neither pom.xml nor .sdkmanrc then returns undefined", async () => {
    const dir = await makeDir();
    expect(await resolve(dir)).toBeUndefined();
  });

  it("given only a .sdkmanrc with a java entry then returns it (no pom needed)", async () => {
    const dir = await makeDir();
    await writeFile(join(dir, ".sdkmanrc"), "java=21.0.11-tem\n");
    expect(await resolve(dir)).toBe("21.0.11-tem");
  });
});

describe("scaffold in a Java repo", () => {
  const makeJavaDir = async () => {
    const dir = await makeDir();
    await writeFile(join(dir, "pom.xml"), "<project></project>");
    await writeFile(join(dir, ".sdkmanrc"), SDKMANRC);
    return dir;
  };

  it("Dockerfile installs sdkman with the repo's Java version and Maven", async () => {
    const dir = await makeJavaDir();
    await runScaffold(dir);

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain("sdkman");
    expect(dockerfile).toContain("sdk install java 25.0.1-open");
    expect(dockerfile).toContain("sdk install maven");
  });

  it("Dockerfile installs zip/unzip (sdkman prerequisites) before dropping root", async () => {
    const dir = await makeJavaDir();
    await runScaffold(dir);

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    const zipIdx = dockerfile.indexOf("unzip");
    const userIdx = dockerfile.indexOf("USER ");
    expect(zipIdx).toBeGreaterThan(-1);
    expect(zipIdx).toBeLessThan(userIdx);
  });

  it("Dockerfile exports JAVA_HOME and puts java and mvn on the PATH", async () => {
    const dir = await makeJavaDir();
    await runScaffold(dir);

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain("JAVA_HOME");
    expect(dockerfile).toContain("candidates/java/current/bin");
    expect(dockerfile).toContain("candidates/maven/current/bin");
  });

  it("leaves no unresolved template arguments in the Dockerfile", async () => {
    const dir = await makeJavaDir();
    await runScaffold(dir);

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it("reports the baked Java version in the scaffold result", async () => {
    const dir = await makeJavaDir();
    const result = await runScaffold(dir);
    expect(result.javaVersion).toBe("25.0.1-open");
  });

  it.each(listAgents().map((a) => ({ agent: a })))(
    "adds the sdkman layer to the $agent.name Dockerfile",
    async ({ agent }) => {
      const dir = await makeJavaDir();
      await runScaffold(dir, { agent });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("sdk install java 25.0.1-open");
      expect(dockerfile).not.toMatch(/\{\{[A-Z_]+\}\}/);
    },
  );
});

describe("scaffold in a non-Java repo", () => {
  it("Dockerfile has no sdkman layer and no leftover placeholders", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).not.toContain("sdkman");
    expect(dockerfile).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it("Dockerfile has no triple blank lines where the Java layer would be", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).not.toMatch(/\n{4,}/);
  });

  it("reports no Java version in the scaffold result", async () => {
    const dir = await makeDir();
    const result = await runScaffold(dir);
    expect(result.javaVersion).toBeUndefined();
  });
});
