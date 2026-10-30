/**
 * The cohort's default path, end to end: `sandcastle init` (blank template,
 * claude-code, docker) builds the image, then the scaffolded
 * `.sandcastle/main.ts` runs Claude Code in Docker and its commit lands on
 * the host branch.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  cheapModel,
  requireCommand,
  requireEnv,
  sandcastleCli,
  scratchRepo,
  sh,
  tsx,
  verify,
} from "./harness.ts";

const EXPECTED = "sandcastle-verify";

await verify(
  {
    claim: "init + run with claudeCode in docker commits the agent's change",
    agent: "claudeCode",
    sandbox: "docker",
  },
  async (check) => {
    requireEnv("CLAUDE_CODE_OAUTH_TOKEN");
    requireCommand("docker", "info");

    const repo = scratchRepo("claude-code-docker");

    check.step("sandcastle init (builds the image; slow on first run)");
    const init = sandcastleCli(
      [
        "init",
        "--template",
        "blank",
        "--agent",
        "claude-code",
        "--model",
        cheapModel("claudeCode"),
        "--sandbox",
        "docker",
        "--issue-tracker",
        "github-issues",
        "--create-label",
        "false",
        "--build-image",
        "true",
      ],
      { cwd: repo.dir, timeoutMs: 15 * 60_000 },
    );
    check.expect(init.code === 0, "sandcastle init exits 0", init.output);
    const image = sh("docker", [
      "image",
      "inspect",
      "sandcastle:claude-code-docker",
    ]);
    check.expect(
      image.code === 0,
      "image sandcastle:claude-code-docker exists",
      image.output,
    );
    if (init.code !== 0 || image.code !== 0) return;

    // As a student would: commit the scaffold, set the prompt, provide the key.
    // The key is declared empty so Sandcastle reads it from process.env, and
    // only declared keys reach the sandbox (so ANTHROPIC_API_KEY stays out).
    repo.write(
      ".sandcastle/prompt.md",
      `Create a file named hello.txt whose entire content is the single line: ${EXPECTED}\n` +
        `Then commit it with the message "add hello.txt". Do nothing else.\n`,
    );
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "sandcastle init");
    repo.write(".sandcastle/.env", "CLAUDE_CODE_OAUTH_TOKEN=\n");
    const before = repo.git("rev-parse", "HEAD");

    // init names the entry main.ts or main.mts depending on the host project.
    const main = existsSync(join(repo.dir, ".sandcastle", "main.ts"))
      ? ".sandcastle/main.ts"
      : ".sandcastle/main.mts";
    check.expect(
      repo.read(main).includes(`claudeCode("${cheapModel("claudeCode")}")`),
      `${main} runs claudeCode("${cheapModel("claudeCode")}")`,
      repo.read(main),
    );
    check.step(`npx tsx ${main} (runs Claude Code in Docker)`);
    const run = tsx(main, {
      cwd: repo.dir,
      timeoutMs: 15 * 60_000,
    });
    check.expect(run.code === 0, `${main} exits 0`, run.output);

    const added = repo.git("rev-list", "--count", `${before}..HEAD`);
    check.expect(
      Number(added) >= 1,
      `agent commit landed on the host branch (${added} new)`,
      repo.git("log", "--oneline", "-5"),
    );

    const show = sh("git", ["show", "HEAD:hello.txt"], { cwd: repo.dir });
    check.expect(
      show.code === 0 && show.stdout.trim() === EXPECTED,
      `HEAD:hello.txt is "${EXPECTED}"`,
      show.output,
    );
  },
);
