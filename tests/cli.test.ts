import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  sandbox: "docker",
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

  it.each(["--template", "--agent", "--model", "--sandbox"])(
    "documents %s",
    (flag) => {
      expect(help).toContain(flag);
    },
  );

  it.each([
    "--issue-tracker",
    "--create-label",
    "--build-image",
    "--install-template-deps",
    "--image-name",
  ])("no longer takes %s", (flag) => {
    expect(help).not.toContain(flag);
  });
});

describe.each([
  {
    provider: "docker",
    fileFlag: "--dockerfile",
    noFileMessage: "No Dockerfile found",
  },
  {
    provider: "podman",
    fileFlag: "--containerfile",
    noFileMessage: "No Containerfile or Dockerfile found",
  },
])(
  "sandcastle $provider",
  ({ provider, fileFlag, noFileMessage }) => {
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

    it("build-image says the project has no Dockerfile, not that the runtime is down", async () => {
      const repo = hostRepo();
      mkdirSync(path.join(repo, ".sandcastle"));

      const result = await sandcastle([provider, "build-image"], repo);

      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain(noFileMessage);
      expect(result.output).not.toContain("running?");
    });

    it("build-image says a custom file path does not exist", async () => {
      const repo = hostRepo();
      mkdirSync(path.join(repo, ".sandcastle"));
      const result = await sandcastle(
        [provider, "build-image", fileFlag, "missing/Dockerfile"],
        repo,
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("missing/Dockerfile");
      expect(result.output).not.toContain("running?");
    });
  },
  30_000,
);

describe("sandcastle docker build-image in a project scaffolded for podman", () => {
  it("points at podman build-image, not at native sandboxes", async () => {
    const repo = hostRepo();
    mkdirSync(path.join(repo, ".sandcastle"));
    writeFileSync(
      path.join(repo, ".sandcastle", "Containerfile"),
      "FROM node:22-bookworm\n",
    );

    const result = await sandcastle(["docker", "build-image"], repo);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("sandcastle podman build-image");
    expect(result.output).toContain("--dockerfile .sandcastle/Containerfile");
    expect(result.output).not.toContain("Native sandboxes");
    expect(result.output).not.toContain("running?");
  });
}, 30_000);

describe("sandcastle podman build-image --help", () => {
  it("documents --containerfile and --image-name", async () => {
    const { output } = await sandcastle(["podman", "build-image", "--help"]);

    expect(output).toContain("--containerfile");
    expect(output).toContain("--image-name");
  });
}, 30_000);

describe.each(["build-image", "remove-image"])(
  "sandcastle %s (the old top-level command)",
  (command) => {
    it("no longer works", async () => {
      const { exitCode } = await sandcastle([command]);

      expect(exitCode).not.toBe(0);
    });
  },
  30_000,
);

describe("sandcastle init: an unknown choice lists the valid ones", () => {
  it.each([
    {
      flags: { sandbox: "nonexistent" },
      lists: ["bwrap", "docker", "podman", "daytona", "host"],
    },
    {
      flags: { agent: "claude-code", template: "nonexistent" },
      lists: ["blank"],
    },
    {
      flags: { agent: "nonexistent" },
      lists: ["claude-code"],
    },
  ])("$flags", async ({ flags, lists }) => {
    const result = await sandcastle(initArgs(flags), hostRepo());

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("nonexistent");
    for (const valid of lists) {
      expect(result.output).toContain(valid);
    }
  });
}, 30_000);

describe("sandcastle init without a TTY", () => {
  it("scaffolds .sandcastle/ when --agent and --sandbox are given", async () => {
    const repo = hostRepo();

    const result = await sandcastle(initArgs(INIT_FLAGS), repo);

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).toContain("Init complete");
    expect(readdirSync(path.join(repo, ".sandcastle"))).toStrictEqual(
      expect.arrayContaining(["main.mts", "prompt.md"]),
    );
  });

  it("fails fast, naming --agent, when it is missing", async () => {
    const result = await sandcastle(
      initArgs({ sandbox: "docker" }),
      hostRepo(),
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("--agent");
    expect(result.output).toContain("non-interactive");
  });

  it("names every missing flag at once, before writing .sandcastle/", async () => {
    const repo = hostRepo();

    const result = await sandcastle(initArgs({ template: "blank" }), repo);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("--agent, --sandbox are required");
    expect(sandcastleDirIn(repo)).toBe(false);
  });
}, 30_000);

// The published package runs dist/main.js. The windows job runs the e2e tests
// without a build (postbuild needs rm/cp), so this one is Linux and macOS only.
describe.skipIf(process.platform === "win32")("the built CLI", () => {
  it("starts and prints its help", async () => {
    const result = await spawnNode([DIST_MAIN, "--help"], ROOT);

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).toContain("docker build-image");
  });
});
