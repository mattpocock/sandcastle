import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { run, codex, type AgentProvider } from "./index.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function repository() {
  const cwd = await mkdtemp(join(tmpdir(), "reviewer-input-"));
  roots.push(cwd);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-qb", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("commit", "--allow-empty", "-qm", "baseline");
  return { cwd, git, base: git("rev-parse", "HEAD") };
}

it("reviewer can begin reviewing every changed file without embedding a multi-megabyte artifact", async () => {
  const { cwd, git, base } = await repository();
  git("checkout", "-qb", "issue");
  await writeFile(
    join(cwd, "assets.json"),
    JSON.stringify({ bytesBase64: "x".repeat(2_494_959) }),
  );
  git("add", ".");
  git("commit", "-qm", "task artifact");
  git("checkout", "-q", "main");
  let observed = "";
  const agent: AgentProvider = {
    name: "model-input-boundary",
    env: {},
    captureSessions: false,
    buildPrintCommand({ prompt }) {
      observed = prompt;
      if (prompt.length > 1_048_576) throw new Error("input_too_large");
      return { command: "printf '<promise>COMPLETE</promise>'" };
    },
    parseStreamLine: (text) => [{ type: "text", text }],
  };
  const result = await run({
    cwd,
    agent,
    sandbox: noSandbox(),
    promptFile: fileURLToPath(
      new URL(
        "./templates/parallel-planner-with-review/review-prompt.md",
        import.meta.url,
      ),
    ),
    promptArgs: {
      TASK_ID: "91",
      ISSUE_TITLE: "Review large artifact",
      BRANCH: "issue",
      REVIEW_BASE_SHA: base,
      REVIEW_ROUND: "1",
      REVIEW_REPAIR_ROUNDS: "2",
      VIEW_TASK_COMMAND: "gh issue view <ID> --json body",
    },
    logging: { type: "file", path: join(cwd, "review.log") },
  });
  expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
  expect(observed).toContain("assets.json");
  expect(observed.length).toBeLessThan(50_000);
  expect(observed).toContain("every changed file");
});

it("rejects oversized Codex input after shell expansion without invoking the model or exposing payload", async () => {
  const { cwd } = await repository();
  await writeFile(
    join(cwd, "payload.txt"),
    "SECRET_DO_NOT_PRINT" + "x".repeat(1_048_576),
  );
  const template = join(cwd, "prompt.md");
  await writeFile(template, "!`cat payload.txt`\n");
  let invoked = false;
  const agent = {
    ...codex("gpt-6.1-sol", { captureSessions: false }),
    buildPrintCommand() {
      invoked = true;
      return { command: "printf '<promise>COMPLETE</promise>'" };
    },
    parseStreamLine: (text: string) => [{ type: "text" as const, text }],
  };
  const failure = await run({
    cwd,
    agent,
    sandbox: noSandbox(),
    promptFile: template,
    logging: { type: "file", path: join(cwd, "probe.log") },
  }).then(
    () => null,
    (error) => String(error),
  );
  expect(failure).toMatch(/Resolved codex prompt.*limit.*1048576/);
  expect(failure).not.toContain("SECRET_DO_NOT_PRINT");
  expect(invoked).toBe(false);
});

it.each([
  { length: 1_048_576, allowed: true },
  { length: 1_048_577, allowed: false },
])(
  "honors the exact Codex input boundary $length without truncation",
  async ({ length, allowed }) => {
    const { cwd } = await repository();
    let received: number | undefined;
    const agent = {
      ...codex("gpt-6.1-sol", { captureSessions: false }),
      buildPrintCommand({ prompt }: { prompt: string }) {
        received = prompt.length;
        return { command: "printf '<promise>COMPLETE</promise>'" };
      },
      parseStreamLine: (text: string) => [{ type: "text" as const, text }],
    };
    const invocation = run({
      cwd,
      agent,
      sandbox: noSandbox(),
      prompt: "x".repeat(length),
      logging: { type: "file", path: join(cwd, "boundary.log") },
    });
    if (allowed) {
      await expect(invocation).resolves.toMatchObject({
        completionSignal: "<promise>COMPLETE</promise>",
      });
      expect(received).toBe(1_048_576);
    } else {
      await expect(invocation).rejects.toThrow(/limit is 1048576/);
      expect(received).toBeUndefined();
    }
  },
);
