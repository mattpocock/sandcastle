import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
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
      expect(main).not.toMatch(/\bdocker\b/u);
      expect(existsSync(join(repo.dir, ".sandcastle", "Dockerfile"))).toBe(
        false,
      );
      expect(existsSync(join(repo.dir, ".sandcastle", "Containerfile"))).toBe(
        false,
      );
      expect(`${result.stdout}${result.stderr}`).not.toMatch(/build-image/iu);
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
      runCli(
        [
          "init",
          "--sandbox",
          provider,
          "--agent",
          agent,
          "--issue-tracker",
          "github-issues",
          "--create-label",
          "false",
          "--template",
          "blank",
        ],
        { cwd: repo.dir, path: emptyPath },
      );

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

  it.each([
    ["bwrap", "blank"],
    ["seatbelt", "simple-loop"],
  ])(
    "tells a %s user (%s template) to put GH_TOKEN in the Sandcastle env file",
    async (provider, template) => {
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
          template,
        ],
        { cwd: repo.dir },
      );

      expect(result).toMatchObject({ exitCode: 0 });
      expect(`${result.stdout}${result.stderr}`).toMatch(
        /GH_TOKEN[^\n]*\.sandcastle\/\.env/u,
      );
    },
    60_000,
  );

  it("doesn't add the GH_TOKEN step for --sandbox docker", async () => {
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
    expect(`${result.stdout}${result.stderr}`).not.toContain("GH_TOKEN");
  }, 60_000);

  describe("beads", () => {
    const initBeads = async (
      provider: string,
    ): Promise<Awaited<ReturnType<typeof runCli>>> =>
      runCli(
        [
          "init",
          "--sandbox",
          provider,
          "--agent",
          "claude-code",
          "--issue-tracker",
          "beads",
          "--template",
          "blank",
          "--build-image",
          "false",
        ],
        { cwd: repo.dir },
      );

    /**
     * The scaffolded `sandboxOptions`, evaluated as the main file would be
     * when run from `cwd`. The declaration is plain JavaScript.
     */
    const scaffoldedSandboxOptions = (main: string, cwd: string): unknown => {
      const declaration = /^const sandboxOptions = \{$[\s\S]*?^\};$/mu.exec(
        main,
      )?.[0];
      expect(declaration).toBeDefined();
      const prelude = main.slice(0, main.indexOf(declaration ?? ""));
      const helpers = prelude
        .split("\n")
        .filter((line) => line.startsWith("const "))
        .join("\n");
      // Evaluated in its own context; the clone gives plain objects of this realm.
      const options: unknown = runInNewContext(
        `${helpers}\n${declaration ?? ""}\nsandboxOptions;`,
        { process: { cwd: () => cwd } },
      );
      return structuredClone(options);
    };

    // Native providers run on POSIX hosts only, where the scaffold's paths use `/`.
    it.skipIf(process.platform === "win32").each(["bwrap", "seatbelt"])(
      "scaffolds an identity mount of .beads/ and a matching BEADS_DIR for %s, with no bd version warning",
      async (provider) => {
        const result = await initBeads(provider);

        expect(result).toMatchObject({ exitCode: 0 });
        expect(`${result.stdout}${result.stderr}`).not.toMatch(/\bbd\b/u);
        const main = readFileSync(
          join(repo.dir, ".sandcastle", "main.mts"),
          "utf8",
        );
        expect(main).toContain(`${provider}(sandboxOptions)`);
        const beadsDir = join(repo.dir, ".beads");
        expect(scaffoldedSandboxOptions(main, repo.dir)).toStrictEqual({
          mounts: [{ hostPath: beadsDir, sandboxPath: beadsDir }],
          env: { BEADS_DIR: beadsDir },
        });
      },
      60_000,
    );

    it("keeps the Docker beads mount at /home/agent/host-beads", async () => {
      const result = await initBeads("docker");

      expect(result).toMatchObject({ exitCode: 0 });
      const main = readFileSync(
        join(repo.dir, ".sandcastle", "main.mts"),
        "utf8",
      );
      expect(main).toContain("docker(sandboxOptions)");
      expect(scaffoldedSandboxOptions(main, repo.dir)).toStrictEqual({
        mounts: [{ hostPath: ".beads", sandboxPath: "/home/agent/host-beads" }],
        env: { BEADS_DIR: "/home/agent/host-beads" },
      });
    }, 60_000);
  });

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
