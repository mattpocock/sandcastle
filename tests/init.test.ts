import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempGitRepo, runCli } from "./helpers/runCli.js";

// `init` has no library API, so these tests drive the real `sandcastle` CLI,
// run from source in a subprocess, with no TTY: every choice comes from a flag.

describe("sandcastle init (non-interactive)", () => {
  let repo: { readonly dir: string; readonly cleanup: () => void };

  beforeEach(() => {
    repo = createTempGitRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("scaffolds the main file and Dockerfile for --sandbox docker", async () => {
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
        "blank",
        "--build-image",
        "false",
      ],
      { cwd: repo.dir },
    );

    expect(result).toMatchObject({ exitCode: 0 });
    expect(existsSync(join(repo.dir, ".sandcastle", "main.mts"))).toBe(true);
    expect(existsSync(join(repo.dir, ".sandcastle", "Dockerfile"))).toBe(true);
  }, 60_000);
});
