import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "vitest";
import type { TestContext } from "vitest";
import * as sandcastle from "@ai-hero/sandcastle";

// `sandcastle init --agent <name>`: which agents the CLI offers, and what each
// one scaffolds. The CLI runs from src/main.ts through tsx as a subprocess,
// with every prompt answered by a flag (stdin is not a TTY).

const MAIN = path.resolve(import.meta.dirname, "../src/main.ts");
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

interface CliResult {
  readonly exitCode: number;
  readonly output: string;
}

const sandcastleInit = async (
  cwd: string,
  agent: string,
): Promise<CliResult> => {
  const args = [
    "--import",
    TSX,
    MAIN,
    "init",
    "--agent",
    agent,
    "--sandbox",
    "docker",
    "--issue-tracker",
    "custom",
    "--template",
    "blank",
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

const AGENTS = [
  {
    name: "claude-code",
    factory: "claudeCode",
    model: "claude-opus-4-8",
    installs: "https://claude.ai/install.sh",
  },
  {
    name: "pi",
    factory: "pi",
    model: "claude-sonnet-4-6",
    installs: "@mariozechner/pi-coding-agent",
  },
  {
    name: "codex",
    factory: "codex",
    model: "gpt-5.4",
    installs: "@openai/codex",
  },
  {
    name: "cursor",
    factory: "cursor",
    model: "composer-2",
    installs: "cursor.com/install",
  },
  {
    name: "opencode",
    factory: "opencode",
    model: "opencode/big-pickle",
    installs: "opencode-ai",
  },
  {
    name: "copilot",
    factory: "copilot",
    model: "claude-sonnet-4.5",
    installs: "@github/copilot",
  },
] as const;

/** A fresh git repo, removed when the test finishes. */
const freshRepo = ({ onTestFinished }: TestContext): string => {
  const repo = mkdtempSync(path.join(tmpdir(), "e2e-init-agents-"));
  onTestFinished(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  return repo;
};

const scaffolded = (repo: string, file: string): string =>
  readFileSync(path.join(repo, ".sandcastle", file), "utf8");

// Each test spawns its own CLI in its own repo, so they run concurrently.
describe.concurrent(
  "sandcastle init --agent",
  () => {
    it("rejects an unknown agent, listing every agent it offers", async (ctx) => {
      const { expect } = ctx;
      const repo = freshRepo(ctx);
      const result = await sandcastleInit(repo, "nonexistent");

      expect(result).toMatchObject({ exitCode: 1 });
      expect(result.output).toContain(
        'Unknown agent "nonexistent". Available: claude-code, pi, codex, cursor, opencode, copilot',
      );
    });

    describe.each(AGENTS)("$name", ({ name, factory, model, installs }) => {
      it(`runs the agent through ${factory}("${model}") from the package`, async (ctx) => {
        const { expect } = ctx;
        const repo = freshRepo(ctx);
        const result = await sandcastleInit(repo, name);

        expect(result).toMatchObject({ exitCode: 0 });
        expect(scaffolded(repo, "main.mts")).toMatch(
          new RegExp(
            `import \\{[^}]*\\b${factory}\\b[^}]*\\} from "@ai-hero/sandcastle";`,
            "u",
          ),
        );
        expect(scaffolded(repo, "main.mts")).toContain(
          `agent: ${factory}("${model}"),`,
        );
        expect(sandcastle).toHaveProperty(factory, expect.any(Function));
      });

      it(`writes a Dockerfile that installs the ${name} CLI`, async (ctx) => {
        const { expect } = ctx;
        const repo = freshRepo(ctx);
        await sandcastleInit(repo, name);

        const dockerfile = scaffolded(repo, "Dockerfile");
        expect(dockerfile).toMatch(/^FROM /mu);
        expect(dockerfile).toContain(installs);
      });
    });
  },
  60_000,
);
