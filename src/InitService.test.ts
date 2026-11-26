import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Exit } from "effect";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, expect, it } from "vitest";
import { getAgent, listAgents } from "./initAgents.js";
import {
  getSandboxProvider,
  listSandboxProviderChoices,
  listSandboxProviders,
} from "./initSandboxProviders.js";
import {
  getNextStepsLines,
  listTemplates,
  scaffold,
  templateError,
} from "./InitService.js";
import type { ScaffoldOptions } from "./InitService.js";

const TEMPLATES_DIR = join(import.meta.dirname, "templates");

const registered = <T>(entry: T | undefined, name: string): T => {
  assert(entry !== undefined, `${name} is not registered`);
  return entry;
};
const claudeCodeAgent = registered(getAgent("claude-code"), "claude-code");
const provider = (name: string) => registered(getSandboxProvider(name), name);

const defaultOptions: ScaffoldOptions = {
  agent: claudeCodeAgent,
  model: "claude-opus-4-8",
  sandboxProvider: provider("bwrap"),
};

const makeDir = async () => mkdtemp(join(tmpdir(), "init-service-"));

const runScaffold = async (
  repoDir: string,
  options?: Partial<ScaffoldOptions>,
) =>
  Effect.runPromise(
    scaffold(repoDir, { ...defaultOptions, ...options }).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );

/** The scaffolded main file for `options`. */
const scaffoldedMain = async (
  options?: Partial<ScaffoldOptions>,
): Promise<string> => {
  const dir = await makeDir();
  const { mainFilename } = await runScaffold(dir, options);
  return readFile(join(dir, ".sandcastle", mainFilename), "utf8");
};

/** Every file under `dir`, recursively. */
const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const file = join(dir, name);
    return statSync(file).isDirectory() ? filesUnder(file) : [file];
  });

describe("templates", () => {
  it("there is one, blank", () => {
    expect(listTemplates().map((t) => t.name)).toStrictEqual(["blank"]);
    expect(readdirSync(TEMPLATES_DIR)).toStrictEqual(["blank"]);
  });

  it("none is built on run()", () => {
    const onRun = filesUnder(TEMPLATES_DIR).filter((file) =>
      /\brun\b\s*[,(}]/u.test(readFileSync(file, "utf8")),
    );
    expect(onRun).toStrictEqual([]);
  });

  it("accepts blank", () => {
    expect(templateError("blank")).toBeUndefined();
  });

  it.each([
    "simple-loop",
    "sequential-reviewer",
    "parallel-planner",
    "parallel-planner-with-review",
  ])("says %s was removed in 1.0.0", (name) => {
    expect(templateError(name)).toContain(
      `The "${name}" template was removed in 1.0.0`,
    );
  });

  it("calls any other name unknown, listing blank", () => {
    expect(templateError("nope")).toBe(
      'Unknown template "nope". Available: blank',
    );
  });
});

describe("the blank prompt", () => {
  const prompt = readFileSync(
    join(TEMPLATES_DIR, "blank", "prompt.md"),
    "utf8",
  );

  it("has no completion signal or iterations", () => {
    expect(prompt).not.toContain("<promise>");
    expect(prompt).not.toMatch(/iteration/iu);
  });

  it("keeps the !`command` dynamic-context example", () => {
    expect(prompt).toContain("!`git log --oneline -10`");
  });
});

describe("scaffold", () => {
  it("writes the main file, the prompt, .env.example and .gitignore, and nothing else", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const files = await readdir(join(dir, ".sandcastle"));
    expect(new Set(files)).toStrictEqual(
      new Set([".env.example", ".gitignore", "main.mts", "prompt.md"]),
    );
    await expect(
      readFile(join(dir, ".sandcastle", ".gitignore"), "utf8"),
    ).resolves.toBe(".env\n");
  });

  it("names the main file main.ts in an ESM package, and says so in it", async () => {
    const dir = await makeDir();
    await writeFile(join(dir, "package.json"), '{ "type": "module" }');

    const { mainFilename } = await runScaffold(dir);

    expect(mainFilename).toBe("main.ts");
    const main = await readFile(join(dir, ".sandcastle", "main.ts"), "utf8");
    expect(main).toContain("npx tsx .sandcastle/main.ts");
    expect(main).not.toContain("main.mts");
  });

  it("fails, writing nothing, when .sandcastle/ already exists", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle"));

    const exit = await Effect.runPromiseExit(
      scaffold(dir, defaultOptions).pipe(Effect.provide(NodeFileSystem.layer)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain(".sandcastle/ directory already exists");
    await expect(readdir(join(dir, ".sandcastle"))).resolves.toStrictEqual([]);
  });

  it("creates the sandbox with createSandbox and runs one session, closing it with await using", async () => {
    const main = await scaffoldedMain();

    expect(main).toContain(
      'import { claudeCode, createSandbox } from "@ai-hero/sandcastle/v1";',
    );
    expect(main).toContain("await using sandbox = await createSandbox({");
    expect(main.match(/sandbox\.session\(/gu)).toHaveLength(1);
    expect(main).toContain('agent: claudeCode("claude-opus-4-8"),');
    expect(main).toContain("console.log(result.finalMessage);");
  });

  it("loads .sandcastle/.env itself and passes it to createSandbox", async () => {
    const main = await scaffoldedMain();

    expect(main).toContain(
      'parseEnv(await readFile(".sandcastle/.env", "utf8"))',
    );
    expect(main).toMatch(/createSandbox\(\{[^}]*\benv,/u);
  });

  it.each(listAgents().map((agent) => [agent.name, agent] as const))(
    "runs %s with the chosen model",
    async (_name, agent) => {
      const main = await scaffoldedMain({ agent, model: "test-model" });

      expect(main).toContain(`agent: ${agent.factoryImport}("test-model"),`);
      expect(main).toContain(
        `import { ${agent.factoryImport}, createSandbox } from "@ai-hero/sandcastle/v1";`,
      );
    },
  );

  it.each(
    listAgents()
      .filter((agent) => agent.factoryImport !== "claudeCode")
      .map((agent) => [agent.name, agent] as const),
  )("leaves no claudeCode in %s's main file", async (_name, agent) => {
    const main = await scaffoldedMain({ agent, model: "test-model" });

    expect(main).not.toContain("claudeCode");
  });

  it.each(listSandboxProviders().map((entry) => [entry.name, entry] as const))(
    "calls the %s factory from its v1 subpath",
    async (name, entry) => {
      const main = await scaffoldedMain({ sandboxProvider: entry });

      expect(main).toContain(
        `import { ${name} } from "@ai-hero/sandcastle/v1/sandboxes/${name}";`,
      );
      expect(main).toContain(`provider: ${entry.call},`);
    },
  );

  it.each(
    listSandboxProviders()
      .filter((entry) => entry.name !== "bwrap")
      .map((entry) => [entry.name, entry] as const),
  )("leaves no bwrap in the %s main file", async (_name, entry) => {
    const main = await scaffoldedMain({ sandboxProvider: entry });

    expect(main).not.toMatch(/\bbwrap\b/u);
  });

  it("keeps a provider's credentials on the host, out of the sandbox's env", async () => {
    const main = await scaffoldedMain({ sandboxProvider: provider("vercel") });

    expect(main).toContain(
      "const {\n  VERCEL_TOKEN,\n  VERCEL_TEAM_ID,\n  VERCEL_PROJECT_ID,\n  ...env\n} = Object.fromEntries(",
    );
    expect(main).toContain(
      "VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID stay on this machine",
    );
    expect(main).toMatch(/provider: vercel\(\{\s+token: VERCEL_TOKEN,/u);
  });

  it("writes the agent's key and the provider's credentials to .env.example, and no tracker lines", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { sandboxProvider: provider("modal") });

    const envExample = await readFile(
      join(dir, ".sandcastle", ".env.example"),
      "utf8",
    );
    expect(envExample).toMatch(/^CLAUDE_CODE_OAUTH_TOKEN=$/mu);
    expect(envExample).toMatch(/^MODAL_TOKEN_ID=$/mu);
    expect(envExample).toMatch(/^MODAL_TOKEN_SECRET=$/mu);
    expect(envExample).not.toContain("GH_TOKEN=");
    expect(envExample).not.toMatch(/issue/iu);
  });
});

/** The `<name>` of each `./v1/sandboxes/<name>` export in package.json. */
const v1SandboxFactories = (): string[] =>
  [
    ...readFileSync(
      join(import.meta.dirname, "..", "package.json"),
      "utf8",
    ).matchAll(/"\.\/v1\/sandboxes\/(?<name>[^"]+)"/gu),
  ].map((match) => match.groups?.name ?? "");

describe("sandbox providers", () => {
  it("are exactly the v1 sandbox factories in package.json", () => {
    expect(new Set(listSandboxProviders().map((p) => p.name))).toStrictEqual(
      new Set(v1SandboxFactories()),
    );
  });

  it.each([
    ["linux", "bwrap"],
    ["darwin", "seatbelt"],
  ] as const)("on %s, offers %s first, recommended", (platform, native) => {
    const [first, ...rest] = listSandboxProviderChoices(platform);

    expect(first).toMatchObject({ entry: { name: native }, recommended: true });
    expect(rest.every((c) => !c.recommended)).toBe(true);
  });

  it("on Windows, offers no native provider", () => {
    const names = listSandboxProviderChoices("win32").map((c) => c.entry.name);

    expect(names).not.toContain("bwrap");
    expect(names).not.toContain("seatbelt");
    expect(names).toContain("host");
  });
});

describe("getNextStepsLines", () => {
  const steps = (options: {
    readonly sandbox: string;
    readonly hasPeerDependency?: boolean;
  }): string =>
    getNextStepsLines({
      mainFilename: "main.mts",
      agent: claudeCodeAgent,
      sandboxProvider: provider(options.sandbox),
      packageManager: "pnpm",
      hasPeerDependency: options.hasPeerDependency ?? false,
    }).join("\n");

  it("tells a remote provider's user to install its SDK, with their package manager", () => {
    expect(steps({ sandbox: "daytona" })).toContain(
      "Install the Daytona SDK: `pnpm add @daytona/sdk`",
    );
  });

  it("skips the SDK step when the project already has it", () => {
    expect(
      steps({ sandbox: "daytona", hasPeerDependency: true }),
    ).not.toContain("SDK");
  });

  it("runs the main file through the package manager", () => {
    expect(steps({ sandbox: "bwrap" })).toContain(
      'Add "sandcastle": "npx tsx .sandcastle/main.mts" to your package.json scripts, then run `pnpm run sandcastle`',
    );
  });

  it("says nothing about iterations, completion signals, issue trackers or build-image", () => {
    for (const entry of listSandboxProviders()) {
      expect(steps({ sandbox: entry.name })).not.toMatch(
        /iteration|COMPLETE|issue tracker|build-image|Dockerfile/iu,
      );
    }
  });
});
