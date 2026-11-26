import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

  const init = async (
    ...flags: string[]
  ): Promise<Awaited<ReturnType<typeof runCli>>> =>
    runCli(["init", ...flags], { cwd: repo.dir });

  it("scaffolds the blank template with no --template, and no image for docker", async () => {
    const result = await init("--sandbox", "docker", "--agent", "claude-code");

    expect(result).toMatchObject({ exitCode: 0 });
    expect(new Set(readdirSync(join(repo.dir, ".sandcastle")))).toStrictEqual(
      new Set([".env.example", ".gitignore", "main.mts", "prompt.md"]),
    );
    const main = readFileSync(
      join(repo.dir, ".sandcastle", "main.mts"),
      "utf8",
    );
    expect(main).toContain(
      'import { docker } from "@ai-hero/sandcastle/v1/sandboxes/docker";',
    );
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/build-image/iu);
  }, 60_000);

  it("takes --template blank", async () => {
    const result = await init(
      "--sandbox",
      "bwrap",
      "--agent",
      "claude-code",
      "--template",
      "blank",
    );

    expect(result).toMatchObject({ exitCode: 0 });
    expect(existsSync(join(repo.dir, ".sandcastle", "main.mts"))).toBe(true);
  }, 60_000);

  it.each(["simple-loop", "parallel-planner"])(
    "fails on --template %s, saying it was removed in v1, before writing anything",
    async (template) => {
      const result = await init(
        "--sandbox",
        "bwrap",
        "--agent",
        "claude-code",
        "--template",
        template,
      );

      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(
        `The "${template}" template was removed in v1`,
      );
      expect(existsSync(join(repo.dir, ".sandcastle"))).toBe(false);
    },
    60_000,
  );

  it("tells a remote provider's user to install its SDK", async () => {
    const result = await init("--sandbox", "e2b", "--agent", "claude-code");

    expect(result).toMatchObject({ exitCode: 0 });
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Install the E2B SDK: `npm install e2b`",
    );
  }, 60_000);

  it.each([
    ["--issue-tracker", "github-issues"],
    ["--build-image", "false"],
  ])(
    "no longer takes %s",
    async (flag, value) => {
      const result = await init(
        "--sandbox",
        "bwrap",
        "--agent",
        "claude-code",
        flag,
        value,
      );

      expect(result.exitCode).not.toBe(0);
      expect(existsSync(join(repo.dir, ".sandcastle"))).toBe(false);
    },
    60_000,
  );

  describe("host checks for a native provider", () => {
    // A PATH with nothing on it: no sandbox tool, no agent CLI.
    let emptyPath: string;

    beforeEach(() => {
      emptyPath = mkdtempSync(join(tmpdir(), "e2e-empty-path-"));
    });

    afterEach(() => {
      rmSync(emptyPath, { recursive: true, force: true });
    });

    const initNative = async (
      provider: string,
      agent = "claude-code",
    ): Promise<Awaited<ReturnType<typeof runCli>>> =>
      runCli(["init", "--sandbox", provider, "--agent", agent], {
        cwd: repo.dir,
        path: emptyPath,
      });

    // The install command is read from the distro, so this is Linux only.
    it.runIf(process.platform === "linux")(
      "warns with Bubblewrap's install command when bwrap isn't on PATH, and still writes the files",
      async () => {
        const result = await initNative("bwrap");

        expect(result).toMatchObject({ exitCode: 0 });
        expect(`${result.stdout}${result.stderr}`).toMatch(
          /sudo [a-z]+ (?<verb>install|-S|add) bubblewrap/u,
        );
        expect(existsSync(join(repo.dir, ".sandcastle", "main.mts"))).toBe(
          true,
        );
      },
      60_000,
    );

    // The agent CLI check reads only PATH, so it runs on every OS.
    it.each([
      ["claude-code", "curl -fsSL https://claude.ai/install.sh | bash"],
      ["codex", "npm install -g @openai/codex"],
    ])(
      "warns with the install command when the %s CLI isn't on PATH, and still writes the files",
      async (agent, installCommand) => {
        const result = await initNative("bwrap", agent);

        expect(result).toMatchObject({ exitCode: 0 });
        expect(`${result.stdout}${result.stderr}`).toContain(installCommand);
        expect(existsSync(join(repo.dir, ".sandcastle", "main.mts"))).toBe(
          true,
        );
      },
      60_000,
    );

    it.skipIf(process.platform === "win32")(
      "doesn't warn about an agent CLI that is on PATH",
      async () => {
        const claude = join(emptyPath, "claude");
        writeFileSync(claude, "#!/bin/sh\n");
        chmodSync(claude, 0o755);

        const result = await initNative("bwrap");

        expect(result).toMatchObject({ exitCode: 0 });
        expect(`${result.stdout}${result.stderr}`).not.toContain(
          "claude.ai/install.sh",
        );
      },
      60_000,
    );
  });

  it("fails naming --sandbox when no TTY and no --sandbox are given", async () => {
    const result = await init("--agent", "claude-code");

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("--sandbox");
    expect(existsSync(join(repo.dir, ".sandcastle"))).toBe(false);
  }, 60_000);
});
