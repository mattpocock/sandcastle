import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "./helpers/runCli.js";

// The blank template as a user gets it: `sandcastle init` scaffolds it into a
// project whose node_modules holds this package (a link to the built dist),
// then the scaffolded main file is typechecked, and run on the testing fake.

const ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const TSC = path.join(
  path.dirname(require.resolve("@typescript/native/package.json")),
  "bin",
  "tsc",
);
const TSX = pathToFileURL(require.resolve("tsx")).href;

/** Every provider init offers: one per `./v1/sandboxes/<name>` export. */
const PROVIDERS = [
  ...readFileSync(path.join(ROOT, "package.json"), "utf8").matchAll(
    /"\.\/v1\/sandboxes\/(?<name>[^"]+)"/gu,
  ),
].map((match) => match.groups?.name ?? "");

/**
 * A project dir with `@ai-hero/sandcastle` (this repo) and `@types` linked
 * into its node_modules, as an install would leave them.
 */
const makeProject = (parent: string, name: string): string => {
  const dir = path.join(parent, name);
  const scope = path.join(dir, "node_modules", "@ai-hero");
  mkdirSync(scope, { recursive: true });
  symlinkSync(ROOT, path.join(scope, "sandcastle"), "junction");
  symlinkSync(
    path.join(ROOT, "node_modules", "@types"),
    path.join(dir, "node_modules", "@types"),
    "junction",
  );
  return dir;
};

const initBlank = async (cwd: string, sandbox: string): Promise<void> => {
  const result = await runCli(
    ["init", "--agent", "claude-code", "--sandbox", sandbox],
    { cwd },
  );
  expect({ exitCode: result.exitCode, stderr: result.stderr }).toMatchObject({
    exitCode: 0,
  });
};

describe("the scaffolded blank main file", () => {
  let parent = "";

  beforeAll(() => {
    parent = mkdtempSync(path.join(tmpdir(), "init-blank-"));
  });

  afterAll(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it("offers a provider for each v1 sandbox factory", () => {
    expect(PROVIDERS).toStrictEqual(
      expect.arrayContaining(["bwrap", "daytona", "docker", "host", "vercel"]),
    );
  });

  // One CLI process at a time, then one tsc over every scaffold. The package's
  // types are in dist/, and the windows job runs without a build.
  it.skipIf(process.platform === "win32")(
    "typechecks against the package, for every provider",
    async () => {
      const files = PROVIDERS.map((provider) =>
        path.join(parent, `typecheck-${provider}`, ".sandcastle", "main.mts"),
      );
      await PROVIDERS.reduce(async (previous, provider) => {
        await previous;
        await initBlank(makeProject(parent, `typecheck-${provider}`), provider);
      }, Promise.resolve());
      const tsconfig = path.join(parent, "tsconfig.json");
      writeFileSync(
        tsconfig,
        JSON.stringify({
          compilerOptions: {
            target: "ESNext",
            lib: ["ESNext"],
            module: "NodeNext",
            moduleResolution: "NodeNext",
            types: ["node"],
            typeRoots: [path.join(ROOT, "node_modules", "@types")],
            strict: true,
            noEmit: true,
            skipLibCheck: true,
          },
          files,
        }),
      );

      const tsc = spawnSync(process.execPath, [TSC, "-p", tsconfig], {
        encoding: "utf8",
      });
      expect({ status: tsc.status, stdout: tsc.stdout }).toStrictEqual({
        status: 0,
        stdout: "",
      });
    },
    240_000,
  );

  // The fake runs real `sh` in temp dirs: POSIX only.
  it.skipIf(process.platform === "win32")(
    "runs on the testing fake: creates the sandbox, runs one session, prints its result and closes it",
    async () => {
      const dir = makeProject(parent, "run");
      await initBlank(dir, "bwrap");
      const config = path.join(dir, ".sandcastle");
      const sandboxes = path.join(parent, "fake-sandboxes");
      mkdirSync(sandboxes);
      const marker = path.join(parent, "marker.txt");

      // Swap the provider for the fake, and the agent for a fake one.
      const mainFile = path.join(config, "main.mts");
      const main = readFileSync(mainFile, "utf8");
      const fakeLines = [
        JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
        JSON.stringify({
          type: "result",
          is_error: false,
          result: "Hello from the blank template.",
        }),
      ];
      writeFileSync(
        mainFile,
        main
          .replace(
            'import { bwrap } from "@ai-hero/sandcastle/v1/sandboxes/bwrap";',
            'import { fakeAgent, fakeSandbox } from "@ai-hero/sandcastle/v1/testing";',
          )
          .replace(
            "bwrap()",
            `fakeSandbox({ rootDir: ${JSON.stringify(sandboxes)} })`,
          )
          .replace(
            'claudeCode("claude-opus-4-8")',
            `fakeAgent({ lines: ${JSON.stringify(fakeLines)} })`,
          ),
      );
      // The env file reaches the sandbox, and the prompt's !`command` runs there.
      writeFileSync(path.join(config, ".env"), `MARKER_FILE=${marker}\n`);
      writeFileSync(
        path.join(config, "prompt.md"),
        `${readFileSync(path.join(config, "prompt.md"), "utf8")}\n!\`echo "$PWD" > "$MARKER_FILE"\`\n`,
      );

      const stdout = execFileSync(
        process.execPath,
        ["--import", TSX, mainFile],
        { cwd: dir, encoding: "utf8" },
      );

      expect(stdout.trim()).toBe("Hello from the blank template.");
      expect(readFileSync(marker, "utf8").trim()).toContain(sandboxes);
      // Closed: the fake removes a sandbox's directory when it closes.
      expect(readdirSync(sandboxes)).toStrictEqual([]);
    },
    120_000,
  );
});
