import { exec } from "node:child_process";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const commitFile = async (
  dir: string,
  name: string,
  content: string,
  message: string,
) => {
  await writeFile(join(dir, name), content);
  await execAsync(`git add "${name}"`, { cwd: dir });
  await execAsync(`git commit -m "${message}"`, { cwd: dir });
};

const cliPath = join(import.meta.dirname, "..", "dist", "main.js");

const runCli = (args: string, cwd: string) =>
  execAsync(`node ${cliPath} ${args}`, { cwd });

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
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    try {
      await runCli("docker build-image", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("No .sandcastle/ found");
    }
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

    try {
      await runCli("init --sandbox nonexistent", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("nonexistent");
      expect(output).toContain("docker");
      expect(output).toContain("podman");
      expect(output).toContain("apple-container");
    }
  });

  it("init --template nonexistent produces error listing available templates", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --agent claude-code --template nonexistent", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("nonexistent");
      expect(output).toContain("blank");
      expect(output).toContain("simple-loop");
    }
  });

  it("old top-level build-image command no longer works", async () => {
    try {
      await runCli("build-image", process.cwd());
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      // Command should fail since build-image is no longer a top-level command
      expect(err).toBeDefined();
    }
  });

  it("old top-level remove-image command no longer works", async () => {
    try {
      await runCli("remove-image", process.cwd());
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      expect(err).toBeDefined();
    }
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
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    try {
      await runCli("podman build-image", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("No .sandcastle/ found");
    }
  });

  it("exposes Apple Container image lifecycle commands", async () => {
    const { stdout: rootHelp } = await runCli("--help", process.cwd());
    const { stdout: providerHelp } = await runCli(
      "apple-container --help",
      process.cwd(),
    );
    const { stdout: buildHelp } = await runCli(
      "apple-container build-image --help",
      process.cwd(),
    );

    expect(rootHelp).toContain("apple-container build-image");
    expect(rootHelp).toContain("apple-container remove-image");
    expect(providerHelp).toContain("build-image");
    expect(providerHelp).toContain("remove-image");
    expect(buildHelp).toContain("--dockerfile");
    expect(buildHelp).toContain("--image-name");
  });

  it("Apple Container build-image requires an initialized project", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    await expect(
      runCli("apple-container build-image", hostDir),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining("No .sandcastle/ found"),
    });
  });

  it("init --agent nonexistent produces error listing available agents", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --agent nonexistent", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("nonexistent");
      expect(output).toContain("claude-code");
    }
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

    try {
      await runCli("init --issue-tracker nonexistent", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("nonexistent");
      expect(output).toContain("github-issues");
      expect(output).toContain("beads");
      expect(output).toContain("custom");
    }
  });

  it("init with full flag set scaffolds non-interactively in a non-TTY env", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

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

  it("init scaffolds Apple Container without invoking the runtime when build is deferred", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    const { stdout } = await runCli(
      "init --agent claude-code --template blank --sandbox apple-container --issue-tracker beads --build-image false",
      hostDir,
    );

    expect(stdout).toContain("sandcastle apple-container build-image");
    const entries = await readdir(join(hostDir, ".sandcastle"));
    expect(entries).toContain("Dockerfile");
    const main = await import("node:fs/promises").then(({ readFile }) =>
      readFile(join(hostDir, ".sandcastle", "main.mts"), "utf8"),
    );
    expect(main).toContain("@ai-hero/sandcastle/sandboxes/apple-container");
    expect(main).toContain("appleContainer()");
  });

  it("init without --agent fails fast with a clear non-interactive error message", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --template blank --sandbox docker", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("--agent");
      expect(output).toContain("non-interactive");
    }
  });

  it("init --issue-tracker github-issues without --create-label fails fast in non-interactive mode", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli(
        "init --agent claude-code --template blank --sandbox docker --issue-tracker github-issues",
        hostDir,
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("--create-label");
      expect(output).toContain("non-interactive");
    }
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
