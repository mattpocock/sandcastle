import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSandbox, createWorktree } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";

// docker() and podman() name their container, and the Sandbox handle exposes
// that name so a supervisor outside the process can inspect or kill it. No
// real engine runs here: a fake `docker`/`podman` on PATH records the
// arguments of each `run` and succeeds at everything else. The fake is a
// POSIX shell script, so these don't run on Windows.

describe.skipIf(process.platform === "win32").each([
  { engine: "docker", provider: docker },
  { engine: "podman", provider: podman },
] as const)("$engine() containerName", ({ engine, provider }) => {
  let repo = "";
  let binDir = "";
  let runLog = "";

  beforeEach(() => {
    repo = realpathSync(
      mkdtempSync(path.join(tmpdir(), "e2e-container-name-")),
    );
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    };
    git("init", "-b", "main");
    writeFileSync(path.join(repo, "a.txt"), "a");
    git("add", ".");
    git("commit", "-m", "init");

    binDir = mkdtempSync(path.join(tmpdir(), `e2e-fake-${engine}-`));
    runLog = path.join(binDir, "run-args");
    // `run` writes one argument per line; `podman machine list` (checked on
    // macOS) reports a running machine; every other call succeeds silently.
    writeFileSync(
      path.join(binDir, engine),
      [
        "#!/bin/sh",
        `if [ "$1" = run ]; then printf '%s\\n' "$@" > '${runLog}'; fi`,
        `if [ "$1" = machine ]; then echo '[{"Running":true}]'; fi`,
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    vi.stubEnv(
      "PATH",
      `${binDir}${path.delimiter}${process.env["PATH"] ?? ""}`,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(repo, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  /** The value after `--name` in the recorded `<engine> run`. */
  const nameFromRun = (): string | undefined => {
    const args = readFileSync(runLog, "utf8").trimEnd().split("\n");
    return args[args.indexOf("--name") + 1];
  };

  it("createSandbox() exposes the name the container was started with", async () => {
    const sandbox = await createSandbox({
      branch: "w",
      cwd: repo,
      sandbox: provider(),
    });
    await sandbox.close();

    expect(sandbox.containerName).toMatch(/^sandcastle-/u);
    expect(sandbox.containerName).toBe(nameFromRun());
  }, 30_000);

  it("worktree.createSandbox() exposes it too", async () => {
    await using wt = await createWorktree({
      branchStrategy: { type: "branch", branch: "w" },
      cwd: repo,
    });
    const sandbox = await wt.createSandbox({ sandbox: provider() });
    await sandbox.close();

    expect(sandbox.containerName).toMatch(/^sandcastle-/u);
    expect(sandbox.containerName).toBe(nameFromRun());
  }, 30_000);
});
