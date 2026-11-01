import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { assert, describe, expect, it } from "vitest";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

/** Commit hello.txt ("hello") as the repo's initial commit. */
const commitInitialFile = async (dir: string) => {
  await writeFile(join(dir, "hello.txt"), "hello");
  await execAsync('git add "hello.txt"', { cwd: dir });
  await execAsync('git commit -m "initial commit"', { cwd: dir });
};

const cliPath = join(import.meta.dirname, "..", "dist", "main.js");

const runCli = async (args: string, cwd: string) =>
  execAsync(`node ${cliPath} ${args}`, { cwd });

/** Runs the CLI, fails the test unless it exits non-zero, and returns its
 *  combined stdout and stderr. */
const runCliExpectingFailure = async (
  args: string,
  cwd: string,
): Promise<string> => {
  try {
    await runCli(args, cwd);
  } catch (error) {
    assert(
      error instanceof Error &&
        "stdout" in error &&
        typeof error.stdout === "string" &&
        "stderr" in error &&
        typeof error.stderr === "string",
      "expected an exec error carrying stdout and stderr",
    );
    return error.stdout + error.stderr;
  }
  return expect.fail(`Expected \`sandcastle ${args}\` to fail`);
};

describe("sandcastle CLI", () => {
  it("shows help with --help flag", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("sandcastle");
    expect(stdout).toContain("docker");
    expect(stdout).toContain("init");
    expect(stdout).not.toContain("run");
    expect(stdout).not.toContain("interactive");
    // build-image and remove-image are namespaced under docker, not top-level
    expect(stdout).toContain("docker build-image");
    expect(stdout).toContain("docker remove-image");
    // Old command names should not be exposed
    expect(stdout).not.toContain("setup-sandbox");
    expect(stdout).not.toContain("cleanup-sandbox");
    expect(stdout).not.toContain("sync-in");
    expect(stdout).not.toContain("sync-out");
  });

  it("docker --help shows build-image and remove-image subcommands", async () => {
    const { stdout } = await runCli("docker --help", process.cwd());
    expect(stdout).toContain("build-image");
    expect(stdout).toContain("remove-image");
  });

  it("docker build-image errors when .sandcastle/ is missing", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitInitialFile(hostDir);

    const output = await runCliExpectingFailure("docker build-image", hostDir);
    expect(output).toContain("No .sandcastle/ found");
  });

  it("init --help shows --template flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--template");
  });

  it("init --help exposes --agent flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--agent");
  });

  it("init --help exposes --model flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--model");
  });

  it("init --help exposes --sandbox flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--sandbox");
  });

  it("init --sandbox nonexistent produces error listing available providers", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    const output = await runCliExpectingFailure(
      "init --sandbox nonexistent",
      hostDir,
    );
    expect(output).toContain("nonexistent");
    expect(output).toContain("docker");
    expect(output).toContain("podman");
  });

  it("init --template nonexistent produces error listing available templates", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    const output = await runCliExpectingFailure(
      "init --agent claude-code --template nonexistent",
      hostDir,
    );
    expect(output).toContain("nonexistent");
    expect(output).toContain("blank");
    expect(output).toContain("simple-loop");
  });

  it("old top-level build-image command no longer works", async () => {
    await expect(runCli("build-image", process.cwd())).rejects.toBeInstanceOf(
      Error,
    );
  });

  it("old top-level remove-image command no longer works", async () => {
    await expect(runCli("remove-image", process.cwd())).rejects.toBeInstanceOf(
      Error,
    );
  });

  it("--help shows podman namespace", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("podman");
    expect(stdout).toContain("podman build-image");
    expect(stdout).toContain("podman remove-image");
  });

  it("podman --help shows build-image and remove-image subcommands", async () => {
    const { stdout } = await runCli("podman --help", process.cwd());
    expect(stdout).toContain("build-image");
    expect(stdout).toContain("remove-image");
  });

  it("podman build-image --help shows --containerfile and --image-name flags", async () => {
    const { stdout } = await runCli("podman build-image --help", process.cwd());
    expect(stdout).toContain("--containerfile");
    expect(stdout).toContain("--image-name");
  });

  it("podman build-image errors when .sandcastle/ is missing", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitInitialFile(hostDir);

    const output = await runCliExpectingFailure("podman build-image", hostDir);
    expect(output).toContain("No .sandcastle/ found");
  });

  it("init --agent nonexistent produces error listing available agents", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    const output = await runCliExpectingFailure(
      "init --agent nonexistent",
      hostDir,
    );
    expect(output).toContain("nonexistent");
    expect(output).toContain("claude-code");
  });

  it("init --help exposes --issue-tracker flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--issue-tracker");
  });

  it("init --help exposes --create-label flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--create-label");
  });

  it("init --help exposes --build-image flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--build-image");
  });

  it("init --help exposes --install-template-deps flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--install-template-deps");
  });

  it("init --issue-tracker nonexistent produces error listing available trackers", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    const output = await runCliExpectingFailure(
      "init --issue-tracker nonexistent",
      hostDir,
    );
    expect(output).toContain("nonexistent");
    expect(output).toContain("github-issues");
    expect(output).toContain("beads");
    expect(output).toContain("custom");
  });

  it("init with full flag set scaffolds non-interactively in a non-TTY env", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitInitialFile(hostDir);

    // vitest workers have no TTY, so this confirms the fully-non-interactive
    // path runs to completion without clack crashing on a missing prompt.
    const { stdout } = await runCli(
      "init --agent claude-code --template blank --sandbox docker --issue-tracker beads --build-image false",
      hostDir,
    );

    expect(stdout).toContain("Init complete");
    const entries = await readdir(join(hostDir, ".sandcastle"));
    expect(entries).toContain("Dockerfile");
    expect(entries).toContain("prompt.md");
  });

  describe("init --issue-tracker beads and the host's bd version", () => {
    // Every beads sandbox opens the host's .beads/ with the image's bd 1.3.2.
    // A different host bd breaks one side (an older one can't create issues
    // once 1.3.2 has migrated the database), so init warns.
    const initWithHostBd = async (versionLine: string) => {
      const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
      await initRepo(hostDir);
      await commitInitialFile(hostDir);
      const binDir = await mkdtemp(join(tmpdir(), "cli-fake-bd-"));
      await writeFile(
        join(binDir, "bd"),
        `#!/bin/sh\necho "${versionLine}"\n`,
        {
          mode: 0o755,
        },
      );
      const { stdout } = await execAsync(
        `node ${cliPath} init --agent claude-code --template blank --sandbox docker --issue-tracker beads --build-image false`,
        {
          cwd: hostDir,
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        },
      );
      const dockerfile = await readFile(
        join(hostDir, ".sandcastle", "Dockerfile"),
        "utf8",
      );
      return { stdout, dockerfile };
    };

    it.skipIf(process.platform === "win32")(
      "warns when the host bd is older than the image's",
      async () => {
        const { stdout, dockerfile } = await initWithHostBd(
          "bd version 1.0.0 (72170267: HEAD@72170267e00a)",
        );
        expect(dockerfile).toContain("ARG BEADS_VERSION=1.3.2");
        expect(stdout).toContain("bd 1.0.0");
        expect(stdout).toContain("can no longer create issues");
      },
    );

    it.skipIf(process.platform === "win32")(
      "says nothing when the host bd matches the image's",
      async () => {
        const { stdout } = await initWithHostBd(
          "bd version 1.3.2 (0123abcd: HEAD@0123abcd)",
        );
        expect(stdout).toContain("Init complete");
        expect(stdout).not.toContain("Your host runs bd");
      },
    );
  });

  it("init without --agent fails fast with a clear non-interactive error message", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    const output = await runCliExpectingFailure(
      "init --template blank --sandbox docker",
      hostDir,
    );
    expect(output).toContain("--agent");
    expect(output).toContain("non-interactive");
  });

  it("init --issue-tracker github-issues without --create-label fails fast in non-interactive mode", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    const output = await runCliExpectingFailure(
      "init --agent claude-code --template blank --sandbox docker --issue-tracker github-issues",
      hostDir,
    );
    expect(output).toContain("--create-label");
    expect(output).toContain("non-interactive");
  });

  it("init without --build-image fails before writing .sandcastle/ in non-interactive mode", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    const output = await runCliExpectingFailure(
      "init --agent claude-code --template blank --sandbox docker --issue-tracker github-issues --create-label false",
      hostDir,
    );
    expect(output).toContain("--build-image");
    expect(output).toContain("non-interactive");
    expect(existsSync(join(hostDir, ".sandcastle"))).toBe(false);
  });

  it("init without --install-template-deps fails before writing .sandcastle/ when the template needs zod", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    const output = await runCliExpectingFailure(
      "init --agent claude-code --template parallel-planner --sandbox docker --issue-tracker beads --build-image false",
      hostDir,
    );
    expect(output).toContain("--install-template-deps");
    expect(output).toContain("non-interactive");
    expect(existsSync(join(hostDir, ".sandcastle"))).toBe(false);
  });

  it("init names every missing flag at once in non-interactive mode", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    const output = await runCliExpectingFailure(
      "init --template blank --sandbox docker --issue-tracker github-issues",
      hostDir,
    );
    expect(output).toContain("--agent");
    expect(output).toContain("--create-label");
    expect(output).toContain("--build-image");
    expect(output).toContain("non-interactive");
    expect(existsSync(join(hostDir, ".sandcastle"))).toBe(false);
  });

  it("init --issue-tracker custom ignores --build-image and scaffolds without trying to build", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    // --build-image is meaningless for the custom tracker (Dockerfile is
    // deliberately broken until configured) and must be silently ignored
    // rather than fail-fast or attempt a build.
    const { stdout } = await runCli(
      "init --agent claude-code --template blank --sandbox docker --issue-tracker custom --build-image true",
      hostDir,
    );

    expect(stdout).toContain("Init complete");
    const entries = await readdir(join(hostDir, ".sandcastle"));
    expect(entries).toContain("SETUP_ISSUE_TRACKER.md");
  });
});
