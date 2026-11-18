import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Sandbox } from "@ai-hero/sandcastle/v1";
import { claudeAgent } from "./common";
import { runSession } from "./run-with-extraction";
import { cloneRepo, openSandbox, run, withGitHubToken } from "./sandbox";

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

/** Every file under `dir`, read as text. */
const allText = async (dir: string): Promise<string> => {
  const files = await readdir(dir, { recursive: true, withFileTypes: true });
  const texts = await Promise.all(
    files
      .filter((entry) => entry.isFile())
      .map(async (entry) =>
        readFile(path.join(entry.parentPath, entry.name), "utf8"),
      ),
  );
  return texts.join("\n");
};

/** A bare repo with one commit on `main`, standing in for GitHub. */
const makeRemote = (dir: string): string => {
  const work = path.join(dir, "work");
  const bare = path.join(dir, "remote.git");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: work, stdio: "ignore" });
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "first",
  );
  execFileSync("git", ["clone", "-q", "--bare", work, bare]);
  return bare;
};

describe.skipIf(process.platform === "win32")(
  "the agent workflows' sandbox",
  () => {
    let scratch = "";
    let sandbox: Sandbox | undefined;
    const saved = { ...process.env };

    beforeEach(async () => {
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
      process.env = { ...saved };
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
      const remote = makeRemote(scratch);
      // GitHub's URL for the repo, sent to the bare repo instead.
      await run(
        opened(),
        `git config --global url.${pathToFileURL(remote).href}.insteadOf https://github.com/${REPO}.git`,
      );

      await cloneRepo(opened(), { branch: "main" });

      // The sandbox's folder: its workspace (the clone), home and tmp.
      const stored = await allText(path.dirname(opened().workingDirectory));
      const helpers = await opened().exec({
        command: "git config --get-all credential.helper",
        allowFailure: true,
      });
      expect(stored).not.toContain(TOKEN);
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
