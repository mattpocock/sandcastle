import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { createTempGitRepo, runCli } from "./helpers/runCli.js";

// The parallel-planner-with-review template's own loop, run for real: init
// scaffolds it into a temp repo, then Node runs the scaffolded main file. The
// only stand-in is the `@ai-hero/sandcastle` package in the repo's
// node_modules, which records each agent run instead of starting one. Git is
// real, so the template's "branch ahead of HEAD" checks see real branches.

const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const ZOD = path.dirname(
  createRequire(import.meta.url).resolve("zod/package.json"),
);

/** One agent run the fake package saw. */
const AgentRun = z.object({
  name: z.string(),
  branch: z.string().optional(),
  branches: z.string().optional(),
});
type AgentRun = z.infer<typeof AgentRun>;

// The planner plans FAKE_PLAN once, then nothing, so the loop ends. Every
// other run makes no commits.
const FAKE_INDEX = `import { appendFileSync } from "node:fs";
const log = (run) =>
  appendFileSync(process.env.FAKE_SANDCASTLE_LOG, JSON.stringify(run) + "\\n");
let plans = 0;
export const claudeCode = (model) => ({ model });
export const Output = { object: (options) => options };
export const run = async (options) => {
  log({ name: options.name, branches: options.promptArgs?.BRANCHES });
  if (options.name !== "planner") return { commits: [] };
  plans += 1;
  const issues = plans === 1 ? JSON.parse(process.env.FAKE_PLAN) : [];
  return { output: { issues }, commits: [] };
};
export const createSandbox = async ({ branch }) => ({
  run: async (options) => {
    log({ name: options.name, branch });
    return { commits: [] };
  },
  close: async () => undefined,
});
`;

const FAKE_DOCKER = "export const docker = () => ({});\n";

/** Writes the recording `@ai-hero/sandcastle` into `dir`'s node_modules. */
const installFakeSandcastle = (dir: string): void => {
  const pkg = path.join(dir, "node_modules", "@ai-hero", "sandcastle");
  mkdirSync(path.join(pkg, "sandboxes"), { recursive: true });
  writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({
      name: "@ai-hero/sandcastle",
      type: "module",
      exports: {
        ".": "./index.mjs",
        "./sandboxes/docker": "./sandboxes/docker.mjs",
      },
    }),
  );
  writeFileSync(path.join(pkg, "index.mjs"), FAKE_INDEX);
  writeFileSync(path.join(pkg, "sandboxes", "docker.mjs"), FAKE_DOCKER);
  symlinkSync(ZOD, path.join(dir, "node_modules", "zod"), "junction");
};

/** Runs `main` in `cwd` and returns the agent runs it made, in order. */
const runTemplate = async (
  cwd: string,
  main: string,
  plan: readonly { id: string; title: string; branch: string }[],
): Promise<readonly AgentRun[]> => {
  const logFile = path.join(cwd, "agent-runs.jsonl");
  writeFileSync(logFile, "");
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", TSX, main], {
      cwd,
      env: {
        ...process.env,
        FAKE_SANDCASTLE_LOG: logFile,
        FAKE_PLAN: JSON.stringify(plan),
      },
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("close", resolve);
  });
  expect(exitCode).toBe(0);
  return readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => AgentRun.parse(JSON.parse(line)));
};

/** A temp repo with the template scaffolded and the fake package installed. */
const scaffoldedRepo = async (): Promise<{
  readonly dir: string;
  readonly main: string;
  readonly git: (...args: string[]) => void;
}> => {
  const repo = createTempGitRepo();
  onTestFinished(repo.cleanup);
  writeFileSync(
    path.join(repo.dir, "package.json"),
    JSON.stringify({ name: "host", dependencies: { zod: "^4" } }),
  );
  const result = await runCli(
    [
      "init",
      "--sandbox",
      "docker",
      "--agent",
      "claude-code",
      "--issue-tracker",
      "github-issues",
      "--create-label",
      "false",
      "--template",
      "parallel-planner-with-review",
      "--build-image",
      "false",
    ],
    { cwd: repo.dir },
  );
  expect(result).toMatchObject({ exitCode: 0 });
  const main = ["main.mts", "main.ts"]
    .map((file) => path.join(repo.dir, ".sandcastle", file))
    .find((file) => existsSync(file));
  if (main === undefined) {
    throw new Error("init scaffolded no main file");
  }
  installFakeSandcastle(repo.dir);
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: repo.dir, stdio: "ignore" });
  };
  return { dir: repo.dir, main, git };
};

describe("parallel-planner-with-review template", () => {
  it("reviews a branch an earlier cycle left ahead of HEAD before merging it", async () => {
    const repo = await scaffoldedRepo();
    // An earlier cycle's implementer committed here, then its review failed:
    // this cycle's implementer has nothing left to commit.
    repo.git("branch", "issue-1");
    repo.git("checkout", "-q", "issue-1");
    repo.git("commit", "--allow-empty", "-m", "unreviewed work");
    repo.git("checkout", "-q", "main");
    // An issue with no work on its branch yet.
    repo.git("branch", "issue-2");

    const runs = await runTemplate(repo.dir, repo.main, [
      { id: "1", title: "Earlier work", branch: "issue-1" },
      { id: "2", title: "No work", branch: "issue-2" },
    ]);

    const reviews = runs.filter((run) => run.name === "reviewer");
    const merges = runs.filter((run) => run.name === "merger");
    expect(reviews).toStrictEqual([{ name: "reviewer", branch: "issue-1" }]);
    expect(merges).toStrictEqual([{ name: "merger", branches: "- issue-1" }]);
    const reviewedAt = runs.findIndex((run) => run.name === "reviewer");
    const mergedAt = runs.findIndex((run) => run.name === "merger");
    expect(reviewedAt).toBeLessThan(mergedAt);
  }, 60_000);

  it("neither reviews nor merges a branch with nothing ahead of HEAD", async () => {
    const repo = await scaffoldedRepo();
    repo.git("branch", "issue-1");

    const runs = await runTemplate(repo.dir, repo.main, [
      { id: "1", title: "No work", branch: "issue-1" },
    ]);

    expect(runs.map((run) => run.name)).toStrictEqual([
      "planner",
      "implementer",
      "planner",
    ]);
  }, 60_000);
});
