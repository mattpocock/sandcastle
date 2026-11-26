import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Sandbox } from "@ai-hero/sandcastle/v1";
import { claudeAgent } from "./common";
import { runSession } from "./run-with-extraction";
import { cloneRepo, openSandbox, run, withGitHubToken } from "./sandbox";
import { useWorkflowSandbox, WORKFLOW_SANDBOXES } from "./test-sandboxes";

// The workflows' sandbox keeps the GitHub token from the agent: it's in no
// session's env, and the clone stores no credential. It's handed only to
// the git commands that reach GitHub, through their own env.

const TOKEN = "ghs_canary0123456789abcdef";
const REPO = "example/repo";

/**
 * A stand-in for the Claude Code CLI: for each message on its stdin it
 * answers with whether its env holds GH_TOKEN, and exits once stdin closes.
 */
const STUB_CLAUDE = `#!/usr/bin/env node
const say = (line) => process.stdout.write(JSON.stringify(line) + "\\n");
say({ type: "system", subtype: "init", session_id: "s-stub" });
require("node:readline").createInterface({ input: process.stdin }).on("line", () => {
  say({ type: "result", is_error: false, result: "GH_TOKEN=" + String(process.env.GH_TOKEN) });
});
`;

/**
 * A bare repo with one commit on `main`, standing in for GitHub, made inside
 * the sandbox's home (where bwrap() can see it), with GitHub's URL for the
 * repo sent to it.
 */
const makeRemote = async (sandbox: Sandbox): Promise<void> => {
  await run(
    sandbox,
    [
      'git init -q -b main "$HOME/work"',
      'git -C "$HOME/work" -c user.name=t -c user.email=t@t commit -q --allow-empty -m first',
      'git clone -q --bare "$HOME/work" "$HOME/remote.git"',
      `git config --global "url.file://$HOME/remote.git.insteadOf" https://github.com/${REPO}.git`,
    ].join(" && "),
  );
};

/** The files in the sandbox's home, tmp and working directory that hold `needle`. */
const filesHolding = async (sandbox: Sandbox, needle: string) =>
  sandbox.exec({
    command: 'grep -rlF -e "$NEEDLE" "$HOME" "$TMPDIR" .',
    env: { NEEDLE: needle },
    allowFailure: true,
  });

describe.each(WORKFLOW_SANDBOXES)(
  "the agent workflows' sandbox on $name()",
  ({ name, skip }) => {
    let scratch = "";
    let sandbox: Sandbox | undefined;
    let cleanup = async (): Promise<void> => undefined;
    const saved = { ...process.env };

    beforeEach(async (context) => {
      context.skip(skip);
      cleanup = await useWorkflowSandbox(name);
      scratch = await mkdtemp(path.join(tmpdir(), "wf-"));
      const bin = path.join(scratch, "bin");
      await mkdir(bin);
      await writeFile(path.join(bin, "claude"), STUB_CLAUDE, { mode: 0o755 });
      process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
      process.env.GH_TOKEN = TOKEN;
      process.env.GH_REPO = REPO;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "claude-unused";
      sandbox = await openSandbox();
    });

    afterEach(async () => {
      await sandbox?.close();
      sandbox = undefined;
      process.env = { ...saved };
      await cleanup();
      await rm(scratch, { recursive: true, force: true });
    });

    const opened = (): Sandbox => {
      if (sandbox === undefined) {
        throw new TypeError("no sandbox");
      }
      return sandbox;
    };

    it("gives no command and no agent session the GitHub token", async () => {
      const exec = await run(
        opened(),
        `node -e 'process.stdout.write(String(process.env.GH_TOKEN))'`,
      );
      const session = await runSession(opened(), {
        agent: claudeAgent(),
        prompt: "What's in your env?",
      });

      expect(exec).toBe("undefined");
      expect(session.finalMessage).toBe("GH_TOKEN=undefined");
    });

    it("clones with the token in that command's env only: the clone and the home store no credential", async () => {
      await makeRemote(opened());

      await cloneRepo(opened(), { branch: "main" });

      const stored = await filesHolding(opened(), TOKEN);
      const helpers = await opened().exec({
        command: "git config --get-all credential.helper",
        allowFailure: true,
      });
      // grep's 1: it read everything and found nothing (2 is an error).
      expect(stored).toMatchObject({ exitCode: 1, stdout: "" });
      expect(helpers).toMatchObject({ exitCode: 1, stdout: "" });
      // The one-command helper does answer with the token, from its env.
      const filled = await opened().exec(
        withGitHubToken(
          String.raw`credential fill <<'EOF'
protocol=https
host=github.com

EOF`,
        ),
      );
      expect(filled.stdout).toContain(`password=${TOKEN}`);
      expect(withGitHubToken("fetch").command).not.toContain(TOKEN);
    });
  },
);
