import { existsSync, readFileSync } from "node:fs";
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
  // A native provider runs the host's own toolchain, so init scaffolds no
  // image: no Dockerfile, no build-image prompt, no build-image next step.
  // The scaffolded text is the same on every OS, so seatbelt runs here too.
  it.each(["bwrap", "seatbelt"])(
    "scaffolds a main file importing %s, with no image",
    async (provider) => {
      const result = await runCli(
        [
          "init",
          "--sandbox",
          provider,
          "--agent",
          "claude-code",
          "--issue-tracker",
          "github-issues",
          "--create-label",
          "false",
          "--template",
          "blank",
        ],
        { cwd: repo.dir },
      );

      expect(result).toMatchObject({ exitCode: 0 });
      const main = readFileSync(
        join(repo.dir, ".sandcastle", "main.mts"),
        "utf8",
      );
      expect(main).toContain(
        `import { ${provider} } from "@ai-hero/sandcastle/sandboxes/${provider}";`,
      );
      expect(main).not.toMatch(/\bdocker\b/);
      expect(existsSync(join(repo.dir, ".sandcastle", "Dockerfile"))).toBe(
        false,
      );
      expect(existsSync(join(repo.dir, ".sandcastle", "Containerfile"))).toBe(
        false,
      );
      expect(`${result.stdout}${result.stderr}`).not.toMatch(/build-image/i);
    },
    60_000,
  );

  it("fails naming --sandbox when no TTY and no --sandbox are given", async () => {
    const result = await runCli(
      [
        "init",
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

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("--sandbox");
    expect(existsSync(join(repo.dir, ".sandcastle"))).toBe(false);
  }, 60_000);
});
