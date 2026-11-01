import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";

// The `sandcastle` CLI: its commands, its help, and how `init` fails or
// scaffolds when stdin is not a TTY. It runs from src/main.ts through tsx as a
// subprocess, so it also runs on the windows job (which has no build), plus
// one check that the built dist/main.js starts.

const ROOT = path.resolve(import.meta.dirname, "..");
const MAIN = path.join(ROOT, "src", "main.ts");
const DIST_MAIN = path.join(ROOT, "dist", "main.js");
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

interface CliResult {
  readonly exitCode: number;
  readonly output: string;
}

const spawnNode = async (
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env });
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

const sandcastle = async (
  args: readonly string[],
  cwd: string = ROOT,
  env?: NodeJS.ProcessEnv,
): Promise<CliResult> => spawnNode(["--import", TSX, MAIN, ...args], cwd, env);

/** A fresh git repo with one commit; removed when the test finishes. */
const hostRepo = (): string => {
  const repo = mkdtempSync(path.join(tmpdir(), "e2e-cli-"));
  onTestFinished(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  };
  git("init", "-b", "main");
  writeFileSync(path.join(repo, "hello.txt"), "hello");
  git("add", ".");
  git(
    "-c",
    "user.email=test@test.com",
    "-c",
    "user.name=Test",
    "commit",
    "-m",
    "initial commit",
  );
  return repo;
};

/** Every flag `init` takes, so a test can drop or change one. */
const INIT_FLAGS = {
  agent: "claude-code",
  template: "blank",
  sandbox: "docker",
  "issue-tracker": "beads",
  "build-image": "false",
} as const;

const initArgs = (
  flags: Readonly<Record<string, string | undefined>>,
): string[] => [
  "init",
  ...Object.entries(flags).flatMap(([flag, value]) =>
    value === undefined ? [] : [`--${flag}`, value],
  ),
];

const sandcastleDirIn = (repo: string): boolean =>
  existsSync(path.join(repo, ".sandcastle"));

describe("sandcastle --help", () => {
  let help = "";

  beforeAll(async () => {
    ({ output: help } = await sandcastle(["--help"]));
  }, 30_000);

  it("lists init and the docker and podman image commands", () => {
    expect(help).toContain("sandcastle");
    expect(help).toContain("init");
    expect(help).toContain("docker build-image");
    expect(help).toContain("docker remove-image");
    expect(help).toContain("podman build-image");
    expect(help).toContain("podman remove-image");
  });

  it("has no run or interactive command, nor any old command name", () => {
    for (const gone of [
      "run",
      "interactive",
      "setup-sandbox",
      "cleanup-sandbox",
      "sync-in",
      "sync-out",
    ]) {
      expect(help).not.toContain(gone);
    }
  });
});

describe("sandcastle init --help", () => {
  let help = "";

  beforeAll(async () => {
    ({ output: help } = await sandcastle(["init", "--help"]));
  }, 30_000);

  it.each([
    "--template",
    "--agent",
    "--model",
    "--sandbox",
    "--issue-tracker",
    "--create-label",
    "--build-image",
    "--install-template-deps",
  ])("documents %s", (flag) => {
    expect(help).toContain(flag);
  });
});

describe.each(["docker", "podman"])("sandcastle %s", (provider) => {
  it("--help lists build-image and remove-image", async () => {
    const { output } = await sandcastle([provider, "--help"]);

    expect(output).toContain("build-image");
    expect(output).toContain("remove-image");
  });

  it("build-image fails when the repo has no .sandcastle/", async () => {
    const result = await sandcastle([provider, "build-image"], hostRepo());

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("No .sandcastle/ found");
  });
});

describe("sandcastle podman build-image --help", () => {
  it("documents --containerfile and --image-name", async () => {
    const { output } = await sandcastle(["podman", "build-image", "--help"]);

    expect(output).toContain("--containerfile");
    expect(output).toContain("--image-name");
  });
});

describe.each(["build-image", "remove-image"])(
  "sandcastle %s (the old top-level command)",
  (command) => {
    it("no longer works", async () => {
      const { exitCode } = await sandcastle([command]);

      expect(exitCode).not.toBe(0);
    });
  },
);

describe("sandcastle init: an unknown choice lists the valid ones", () => {
  it.each([
    {
      flags: { sandbox: "nonexistent" },
      lists: ["docker", "podman"],
    },
    {
      flags: { agent: "claude-code", template: "nonexistent" },
      lists: ["blank", "simple-loop"],
    },
    {
      flags: { agent: "nonexistent" },
      lists: ["claude-code"],
    },
    {
      flags: { "issue-tracker": "nonexistent" },
      lists: ["github-issues", "beads", "custom"],
    },
  ])("$flags", async ({ flags, lists }) => {
    const result = await sandcastle(initArgs(flags), hostRepo());

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("nonexistent");
    for (const valid of lists) {
      expect(result.output).toContain(valid);
    }
  });
});

describe("sandcastle init without a TTY", () => {
  it("scaffolds .sandcastle/ when every flag is given", async () => {
    const repo = hostRepo();

    const result = await sandcastle(initArgs(INIT_FLAGS), repo);

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).toContain("Init complete");
    expect(readdirSync(path.join(repo, ".sandcastle"))).toStrictEqual(
      expect.arrayContaining(["Dockerfile", "prompt.md"]),
    );
  });

  it("fails fast, naming --agent, when it is missing", async () => {
    const result = await sandcastle(
      initArgs({ template: "blank", sandbox: "docker" }),
      hostRepo(),
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("--agent");
    expect(result.output).toContain("non-interactive");
  });

  it("fails fast, naming --create-label, for github-issues without it", async () => {
    const result = await sandcastle(
      initArgs({
        ...INIT_FLAGS,
        "issue-tracker": "github-issues",
        "build-image": undefined,
      }),
      hostRepo(),
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("--create-label");
    expect(result.output).toContain("non-interactive");
  });

  it("fails before writing .sandcastle/ when --build-image is missing", async () => {
    const repo = hostRepo();

    const result = await sandcastle(
      initArgs({
        ...INIT_FLAGS,
        "issue-tracker": "github-issues",
        "create-label": "false",
        "build-image": undefined,
      }),
      repo,
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("--build-image");
    expect(result.output).toContain("non-interactive");
    expect(sandcastleDirIn(repo)).toBe(false);
  });

  it("fails before writing .sandcastle/ when a zod template lacks --install-template-deps", async () => {
    const repo = hostRepo();

    const result = await sandcastle(
      initArgs({ ...INIT_FLAGS, template: "parallel-planner" }),
      repo,
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("--install-template-deps");
    expect(result.output).toContain("non-interactive");
    expect(sandcastleDirIn(repo)).toBe(false);
  });

  it("names every missing flag at once", async () => {
    const repo = hostRepo();

    const result = await sandcastle(
      initArgs({
        template: "blank",
        sandbox: "docker",
        "issue-tracker": "github-issues",
      }),
      repo,
    );

    expect(result.exitCode).not.toBe(0);
    for (const flag of ["--agent", "--create-label", "--build-image"]) {
      expect(result.output).toContain(flag);
    }
    expect(result.output).toContain("non-interactive");
    expect(sandcastleDirIn(repo)).toBe(false);
  });

  it("ignores --build-image for the custom tracker and builds nothing", async () => {
    const repo = hostRepo();

    const result = await sandcastle(
      initArgs({
        ...INIT_FLAGS,
        "issue-tracker": "custom",
        "build-image": "true",
      }),
      repo,
    );

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).toContain("Init complete");
    expect(result.output).not.toContain("Building Docker image");
    expect(readdirSync(path.join(repo, ".sandcastle"))).toContain(
      "SETUP_ISSUE_TRACKER.md",
    );
  });
});

// Every beads sandbox opens the host's .beads/ with the image's bd 1.3.2. A
// different host bd breaks one side (an older one can't create issues once
// 1.3.2 has migrated the database), so init warns. The fake bd is a POSIX
// shell script, so these don't run on Windows.
describe.skipIf(process.platform === "win32")(
  "sandcastle init --issue-tracker beads and the host's bd version",
  () => {
    const initWithHostBd = async (versionLine: string) => {
      const repo = hostRepo();
      const binDir = mkdtempSync(path.join(tmpdir(), "e2e-cli-fake-bd-"));
      onTestFinished(() => {
        rmSync(binDir, { recursive: true, force: true });
      });
      writeFileSync(
        path.join(binDir, "bd"),
        `#!/bin/sh\necho "${versionLine}"\n`,
        { mode: 0o755 },
      );
      const result = await sandcastle(initArgs(INIT_FLAGS), repo, {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env["PATH"] ?? ""}`,
      });
      const dockerfile = await readFile(
        path.join(repo, ".sandcastle", "Dockerfile"),
        "utf8",
      );
      return { result, dockerfile };
    };

    it("warns when the host bd is older than the image's", async () => {
      const { result, dockerfile } = await initWithHostBd(
        "bd version 1.0.0 (72170267: HEAD@72170267e00a)",
      );

      expect(result).toMatchObject({ exitCode: 0 });
      expect(dockerfile).toContain("ARG BEADS_VERSION=1.3.2");
      expect(result.output).toContain("bd 1.0.0");
      expect(result.output).toContain("can no longer create issues");
    });

    it("says nothing when the host bd matches the image's", async () => {
      const { result } = await initWithHostBd(
        "bd version 1.3.2 (0123abcd: HEAD@0123abcd)",
      );

      expect(result.output).toContain("Init complete");
      expect(result.output).not.toContain("Your host runs bd");
    });
  },
);

// The published package runs dist/main.js. The windows job runs the e2e tests
// without a build (postbuild needs rm/cp), so this one is Linux and macOS only.
describe.skipIf(process.platform === "win32")("the built CLI", () => {
  it("starts and prints its help", async () => {
    const result = await spawnNode([DIST_MAIN, "--help"], ROOT);

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).toContain("docker build-image");
  });
});
