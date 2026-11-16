import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";

// `sandcastle init` in a host project: which package manager it detects, the
// install and run commands it prints in the next steps, and when the planner
// templates need zod on the host. The CLI runs from src/main.ts through tsx as
// a subprocess, with every prompt answered by a flag (stdin is not a TTY).
// Nothing is installed: --install-template-deps is false or not needed.

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

const sandcastleInit = async (
  cwd: string,
  options: {
    readonly template: string;
    readonly installTemplateDeps?: "false";
    readonly sandbox?: string;
    readonly issueTracker?: string;
  },
): Promise<CliResult> => {
  const args = [
    "--import",
    TSX,
    MAIN,
    "init",
    "--agent",
    "claude-code",
    "--sandbox",
    options.sandbox ?? "docker",
    "--issue-tracker",
    options.issueTracker ?? "github-issues",
    "--create-label",
    "false",
    "--build-image",
    "false",
    "--template",
    options.template,
    ...(options.installTemplateDeps === undefined
      ? []
      : ["--install-template-deps", options.installTemplateDeps]),
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

/** Init with the planner template, declining the zod install. */
const initPlanner = async (files: Record<string, string>) =>
  sandcastleInit(hostProject(files), {
    template: "parallel-planner",
    installTemplateDeps: "false",
  });

const MISSING_DEPS_FLAG =
  "--install-template-deps is required in non-interactive mode";
const SCHEMA_STEP = "Install a schema validator for the planner's";

// One CLI process at a time: they take about a second each, and running them
// all at once starves the other test files on a small CI machine.
describe("sandcastle init: host package manager", () => {
  it("assumes npm when there is no lockfile or packageManager field", async () => {
    const result = await initPlanner({});

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).toContain(
      "Adjust both if you use a different package manager",
    );
    expect(result.output).toContain(
      "the template uses Zod (`npm install zod`)",
    );
    expect(result.output).toContain("Run `npm run sandcastle` to start");
  });

  it.each([
    { file: "pnpm-lock.yaml", pm: "pnpm", addZod: "pnpm add zod" },
    { file: "yarn.lock", pm: "yarn", addZod: "yarn add zod" },
    { file: "bun.lockb", pm: "bun", addZod: "bun add zod" },
    { file: "bun.lock", pm: "bun", addZod: "bun add zod" },
  ])(
    "detects $pm from $file and prints its commands",
    async ({ file, pm, addZod }) => {
      const result = await initPlanner({ [file]: "" });

      expect(result).toMatchObject({ exitCode: 0 });
      expect(result.output).toContain(
        `This project uses ${pm}, so change the hook to \`${pm} install\``,
      );
      expect(result.output).toContain(`the template uses Zod (\`${addZod}\`)`);
      expect(result.output).toContain(`Run \`${pm} run sandcastle\` to start`);
    },
  );

  it("treats package-lock.json as npm", async () => {
    const result = await initPlanner({ "package-lock.json": "" });

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).toContain(
      "Adjust both if you use a different package manager",
    );
    expect(result.output).toContain(
      "the template uses Zod (`npm install zod`)",
    );
  });

  it("prefers the package.json packageManager field over a lockfile", async () => {
    const result = await initPlanner({
      "package-lock.json": "",
      "package.json": JSON.stringify({
        name: "host",
        packageManager: "pnpm@9.1.0",
      }),
    });

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).toContain("the template uses Zod (`pnpm add zod`)");
  });

  it("ignores an unrecognised packageManager field and uses the lockfile", async () => {
    const result = await initPlanner({
      "yarn.lock": "",
      "package.json": JSON.stringify({
        name: "host",
        packageManager: "deno@1.0.0",
      }),
    });

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).toContain("the template uses Zod (`yarn add zod`)");
  });

  it.each(["{ not json", "null", "[]", '"pnpm@9.1.0"'])(
    "uses the lockfile when package.json is %s",
    async (content) => {
      const result = await initPlanner({
        "yarn.lock": "",
        "package.json": content,
      });

      expect(result).toMatchObject({ exitCode: 0 });
      expect(result.output).toContain("the template uses Zod (`yarn add zod`)");
    },
  );
}, 60_000);

// The scaffolded image ships only npm (#177), so switching the hook to another
// package manager also means adding it to the image.
describe("sandcastle init: the package manager in the image", () => {
  const COREPACK_STEP =
    "add `RUN corepack enable` to .sandcastle/Dockerfile, before its `USER` line";

  it.each(["pnpm-lock.yaml", "yarn.lock"])(
    "tells a %s project to enable corepack in the Dockerfile",
    async (lockfile) => {
      const result = await initPlanner({ [lockfile]: "" });

      expect(result).toMatchObject({ exitCode: 0 });
      expect(result.output).toContain(COREPACK_STEP);
    },
  );

  it("tells a bun project to install bun in the Dockerfile", async () => {
    const result = await initPlanner({ "bun.lock": "" });

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).toContain(
      "install bun in .sandcastle/Dockerfile, before its `USER` line (`RUN npm install -g bun`)",
    );
    expect(result.output).not.toContain("corepack");
  });

  it("names the Containerfile for podman", async () => {
    const result = await sandcastleInit(hostProject({ "pnpm-lock.yaml": "" }), {
      template: "simple-loop",
      sandbox: "podman",
    });

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).toContain(
      "add `RUN corepack enable` to .sandcastle/Containerfile",
    );
  });

  it("says nothing about the image for a native sandbox", async () => {
    const result = await sandcastleInit(hostProject({ "pnpm-lock.yaml": "" }), {
      template: "simple-loop",
      sandbox: "bwrap",
    });

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).toContain("change the hook to `pnpm install`");
    expect(result.output).not.toContain("corepack");
  });

  it("says nothing for beads, whose image already enables corepack", async () => {
    const result = await sandcastleInit(hostProject({ "pnpm-lock.yaml": "" }), {
      template: "simple-loop",
      issueTracker: "beads",
    });

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).toContain("change the hook to `pnpm install`");
    expect(result.output).not.toContain("RUN corepack enable");
  });

  it("says nothing for an npm project", async () => {
    const result = await initPlanner({});

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).not.toContain("corepack");
  });
}, 60_000);

describe("sandcastle init: zod for the planner templates", () => {
  it.each(["parallel-planner", "parallel-planner-with-review"])(
    "%s asks whether to install zod when the host has no package.json",
    async (template) => {
      const result = await sandcastleInit(hostProject({}), { template });

      expect(result).toMatchObject({ exitCode: 1 });
      expect(result.output).toContain(MISSING_DEPS_FLAG);
    },
  );

  it.each(["simple-loop", "blank"])(
    "%s needs no schema validator",
    async (template) => {
      const result = await sandcastleInit(hostProject({}), { template });

      expect(result).toMatchObject({ exitCode: 0 });
      expect(result.output).not.toContain(SCHEMA_STEP);
    },
  );

  it("asks whether to install zod when package.json doesn't declare it", async () => {
    const result = await sandcastleInit(
      hostProject({
        "package.json": JSON.stringify({
          name: "host",
          dependencies: { effect: "^3" },
        }),
      }),
      { template: "parallel-planner" },
    );

    expect(result).toMatchObject({ exitCode: 1 });
    expect(result.output).toContain(MISSING_DEPS_FLAG);
  });

  it.each(["dependencies", "devDependencies"])(
    "skips zod when package.json declares it in %s",
    async (key) => {
      const result = await sandcastleInit(
        hostProject({
          "package.json": JSON.stringify({
            name: "host",
            [key]: { zod: "^3" },
          }),
        }),
        { template: "parallel-planner" },
      );

      expect(result).toMatchObject({ exitCode: 0 });
      expect(result.output).not.toContain(SCHEMA_STEP);
    },
  );

  it.each(["{ not json", "null", "[]", '"zod"'])(
    "asks whether to install zod when package.json is %s",
    async (content) => {
      const result = await sandcastleInit(
        hostProject({ "package.json": content }),
        { template: "parallel-planner" },
      );

      expect(result).toMatchObject({ exitCode: 1 });
      expect(result.output).toContain(MISSING_DEPS_FLAG);
    },
  );
}, 60_000);
