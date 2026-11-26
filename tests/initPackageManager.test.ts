import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";

// `sandcastle init` in a host project: which package manager it detects, and
// the SDK install and run commands it prints in the next steps. The CLI runs
// from src/main.ts through tsx as a subprocess, with every prompt answered by
// a flag (stdin is not a TTY). Nothing is installed.

const MAIN = path.resolve(import.meta.dirname, "../src/main.ts");
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

interface CliResult {
  readonly exitCode: number;
  readonly output: string;
}

/** A fresh git repo holding `files`; removed when the test finishes. */
const hostProject = (files: Record<string, string>): string => {
  const repo = mkdtempSync(path.join(tmpdir(), "e2e-init-pm-"));
  onTestFinished(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(path.join(repo, file), content);
  }
  return repo;
};

const sandcastleInit = async (cwd: string): Promise<CliResult> => {
  const args = [
    "--import",
    TSX,
    MAIN,
    "init",
    "--agent",
    "claude-code",
    "--sandbox",
    "daytona",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? -1, output });
    });
  });
};

/** Init with Daytona, whose SDK the next steps say to install. */
const initDaytona = async (files: Record<string, string>) =>
  sandcastleInit(hostProject(files));

// One CLI process at a time: they take about a second each, and running them
// all at once starves the other test files on a small CI machine.
describe("sandcastle init: host package manager", () => {
  it("assumes npm when there is no lockfile or packageManager field", async () => {
    const result = await initDaytona({});

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).toContain("`npm install @daytona/sdk`");
    expect(result.output).toContain("then run `npm run sandcastle`");
  });

  it.each([
    { file: "pnpm-lock.yaml", pm: "pnpm", add: "pnpm add @daytona/sdk" },
    { file: "yarn.lock", pm: "yarn", add: "yarn add @daytona/sdk" },
    { file: "bun.lockb", pm: "bun", add: "bun add @daytona/sdk" },
    { file: "bun.lock", pm: "bun", add: "bun add @daytona/sdk" },
    { file: "package-lock.json", pm: "npm", add: "npm install @daytona/sdk" },
  ])(
    "detects $pm from $file and prints its commands",
    async ({ file, pm, add }) => {
      const result = await initDaytona({ [file]: "" });

      expect(result).toMatchObject({ exitCode: 0 });
      expect(result.output).toContain(`\`${add}\``);
      expect(result.output).toContain(`then run \`${pm} run sandcastle\``);
    },
  );

  it("prefers the package.json packageManager field over a lockfile", async () => {
    const result = await initDaytona({
      "package-lock.json": "",
      "package.json": JSON.stringify({
        name: "host",
        packageManager: "pnpm@9.1.0",
      }),
    });

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).toContain("`pnpm add @daytona/sdk`");
  });

  it("ignores an unrecognised packageManager field and uses the lockfile", async () => {
    const result = await initDaytona({
      "yarn.lock": "",
      "package.json": JSON.stringify({
        name: "host",
        packageManager: "deno@1.0.0",
      }),
    });

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).toContain("`yarn add @daytona/sdk`");
  });

  it.each(["{ not json", "null", "[]", '"pnpm@9.1.0"'])(
    "uses the lockfile when package.json is %s",
    async (content) => {
      const result = await initDaytona({
        "yarn.lock": "",
        "package.json": content,
      });

      expect(result).toMatchObject({ exitCode: 0 });
      expect(result.output).toContain("`yarn add @daytona/sdk`");
    },
  );
}, 60_000);

describe("sandcastle init: the provider's SDK", () => {
  it.each(["dependencies", "devDependencies"])(
    "skips the install step when package.json declares it in %s",
    async (field) => {
      const result = await initDaytona({
        "package.json": JSON.stringify({
          name: "host",
          [field]: { "@daytona/sdk": "^0.199.0" },
        }),
      });

      expect(result).toMatchObject({ exitCode: 0 });
      expect(result.output).not.toContain("Install the Daytona SDK");
    },
  );
}, 60_000);
