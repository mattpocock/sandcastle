import { exec, execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

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

const runCliArgs = (args: string[], cwd: string) =>
  execFileAsync("node", [cliPath, ...args], {
    cwd,
    encoding: "utf8",
  });

const parseJson = (stdout: string | Buffer) =>
  JSON.parse(stdout.toString()) as Record<string, any>;

const readJson = async (path: string) =>
  JSON.parse(await readFile(path, "utf8")) as Record<string, any>;

const createWorkflowRunRecord = async (dir: string, runId: string) => {
  const runDir = join(dir, ".sandcastle", "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "state.json"),
    JSON.stringify(
      {
        id: runId,
        status: "running",
        cwd: dir,
        agentCount: 0,
        maxAgents: 4,
        concurrency: 2,
      },
      null,
      2,
    ),
  );
  return runDir;
};

const validWorkflowSource = `
  export default {
    meta: { name: "cli-workflow", description: "CLI test workflow" },
    defaults: {
      provider: "codex",
      model: "gpt-5.5",
      sandbox: "docker",
      maxConcurrency: 2,
      maxAgents: 4,
      branchPrefix: "workflow/default",
    },
    run(ctx) {
      return {
        args: ctx.args,
        budget: {
          concurrency: ctx.budget.concurrency,
          maxAgents: ctx.budget.maxAgents,
        },
      };
    },
  };
`;

describe("sandcastle CLI", () => {
  it("shows help with --help flag", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("sandcastle");
    expect(stdout).toContain("docker");
    expect(stdout).toContain("workflow");
    expect(stdout).toContain("init");
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

  it("workflow --help shows validate and run subcommands", async () => {
    const { stdout } = await runCli("workflow --help", process.cwd());
    expect(stdout).toContain("validate");
    expect(stdout).toContain("run");
    expect(stdout).toContain("stop");
    expect(stdout).toContain("pause");
  });

  it("workflow run --help shows args and override flags", async () => {
    const { stdout } = await runCli("workflow run --help", process.cwd());
    expect(stdout).toContain("--args");
    expect(stdout).toContain("--provider");
    expect(stdout).toContain("--model");
    expect(stdout).toContain("--sandbox");
    expect(stdout).toContain("--concurrency");
    expect(stdout).toContain("--max-agents");
    expect(stdout).toContain("--branch-prefix");
    expect(stdout).toContain("--json");
  });

  it("workflow validate FILE --json emits valid validation JSON", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-workflow-"));
    const workflowFile = join(hostDir, "workflow.ts");
    await writeFile(workflowFile, validWorkflowSource);

    const { stdout } = await runCliArgs(
      ["workflow", "validate", workflowFile, "--json"],
      hostDir,
    );
    const json = parseJson(stdout);

    expect(json).toMatchObject({
      ok: true,
      meta: { name: "cli-workflow", description: "CLI test workflow" },
      warnings: [],
      errors: [],
    });
  });

  it("workflow validate FILE --json emits diagnostics and exits non-zero for invalid workflows", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-workflow-"));
    const workflowFile = join(hostDir, "workflow.ts");
    await writeFile(
      workflowFile,
      `
        export default {
          run() {
            return "missing meta";
          },
        };
      `,
    );

    try {
      await runCliArgs(
        ["workflow", "validate", workflowFile, "--json"],
        hostDir,
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout } = err as { stdout: string | Buffer };
      const json = parseJson(stdout);

      expect(json.ok).toBe(false);
      expect(json.errors).toEqual([
        expect.objectContaining({
          code: "workflow_shape_invalid",
          message: "Workflow definition meta must be an object.",
        }),
      ]);
    }
  });

  it("workflow run FILE --args JSON --json passes parsed args and emits run JSON", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-workflow-"));
    const workflowFile = join(hostDir, "workflow.ts");
    await writeFile(workflowFile, validWorkflowSource);

    const { stdout } = await runCliArgs(
      [
        "workflow",
        "run",
        workflowFile,
        "--args",
        JSON.stringify({ issue: 123, labels: ["bug"] }),
        "--json",
      ],
      hostDir,
    );
    const json = parseJson(stdout);

    expect(json).toMatchObject({
      runId: expect.stringContaining("cli-workflow"),
      status: "succeeded",
      runDir: expect.stringContaining(".sandcastle/runs"),
      result: {
        args: { issue: 123, labels: ["bug"] },
        budget: { concurrency: 2, maxAgents: 4 },
      },
      state: {
        status: "succeeded",
        concurrency: 2,
        maxAgents: 4,
        result: {
          args: { issue: 123, labels: ["bug"] },
          budget: { concurrency: 2, maxAgents: 4 },
        },
      },
    });
  });

  it("workflow run --json applies and reports override flags without launching agents", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-workflow-"));
    const workflowFile = join(hostDir, "workflow.ts");
    await writeFile(workflowFile, validWorkflowSource);

    const { stdout } = await runCliArgs(
      [
        "workflow",
        "run",
        workflowFile,
        "--json",
        "--provider",
        "claude-code",
        "--model",
        "claude-sonnet-4-6",
        "--sandbox",
        "no-sandbox",
        "--concurrency",
        "1",
        "--max-agents",
        "2",
        "--branch-prefix",
        "frontier/workflow",
      ],
      hostDir,
    );
    const json = parseJson(stdout);

    expect(json).toMatchObject({
      status: "succeeded",
      result: {
        budget: { concurrency: 1, maxAgents: 2 },
      },
      state: {
        concurrency: 1,
        maxAgents: 2,
      },
      hostOverrides: {
        provider: "claude-code",
        model: "claude-sonnet-4-6",
        sandbox: "no-sandbox",
        concurrency: 1,
        maxAgents: 2,
        branchPrefix: "frontier/workflow",
      },
    });
  });

  it("workflow run --args with invalid JSON exits non-zero with a diagnostic", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-workflow-"));
    const workflowFile = join(hostDir, "workflow.ts");
    await writeFile(workflowFile, validWorkflowSource);

    try {
      await runCliArgs(
        ["workflow", "run", workflowFile, "--args", "{nope", "--json"],
        hostDir,
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout } = err as { stdout: string | Buffer };
      const json = parseJson(stdout);

      expect(json).toMatchObject({
        status: "failed",
        error: {
          message: expect.stringContaining("Invalid --args JSON"),
        },
      });
    }
  });

  it("workflow stop RUN_ID --json writes control.json and emits JSON", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-workflow-"));
    const runDir = await createWorkflowRunRecord(hostDir, "stop-run");

    const { stdout } = await runCliArgs(
      ["workflow", "stop", "stop-run", "--json"],
      hostDir,
    );
    const json = parseJson(stdout);

    expect(json).toMatchObject({
      runId: "stop-run",
      status: "stopping",
      runDir,
      control: {
        stopRequested: true,
        pauseRequested: false,
        updatedAt: expect.any(String),
      },
      state: {
        status: "stopping",
      },
    });
    await expect(
      readJson(join(runDir, "control.json")),
    ).resolves.toMatchObject({
      stopRequested: true,
      pauseRequested: false,
    });
    await expect(readJson(join(runDir, "state.json"))).resolves.toMatchObject({
      status: "stopping",
    });
  });

  it("workflow pause RUN_ID --json writes control.json and emits JSON", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-workflow-"));
    const runDir = await createWorkflowRunRecord(hostDir, "pause-run");

    const { stdout } = await runCliArgs(
      ["workflow", "pause", "pause-run", "--json"],
      hostDir,
    );
    const json = parseJson(stdout);

    expect(json).toMatchObject({
      runId: "pause-run",
      status: "running",
      runDir,
      control: {
        stopRequested: false,
        pauseRequested: true,
        updatedAt: expect.any(String),
      },
    });
    await expect(
      readJson(join(runDir, "control.json")),
    ).resolves.toMatchObject({
      stopRequested: false,
      pauseRequested: true,
    });
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
