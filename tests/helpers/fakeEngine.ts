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
import { vi } from "vitest";

/**
 * A git repo with one commit on `main`, and a fake `docker` or `podman` first
 * on PATH, for tests of docker() and podman() that run no real engine. The
 * fake is a POSIX shell script, so callers skip Windows.
 *
 * The fake records the arguments of each `<engine> run`, one per line; it
 * answers `podman machine list` (checked on macOS) with a running machine;
 * an `<engine> exec` runs its command (from `sh` on) on the host, as the
 * container would, except that one whose command contains
 * `fake-engine-sigterm` prints `partial` and then gets SIGTERM before the
 * command ends. Like the real `docker` and `podman` CLIs, it traps the signal
 * and exits 0. Every other call succeeds silently.
 */
export interface FakeEngineWorld {
  /** Host path to the repo. */
  readonly repo: string;
  /** The arguments of the last `<engine> run`, starting with `run`. */
  readonly runArgs: () => string[];
  /** Restores PATH and removes the repo and the fake. */
  readonly cleanup: () => void;
}

export const setUpFakeEngine = (
  engine: "docker" | "podman",
  repoPrefix: string,
): FakeEngineWorld => {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), repoPrefix)));
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  };
  git("init", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "a");
  git("add", ".");
  git("commit", "-m", "init");

  const binDir = mkdtempSync(path.join(tmpdir(), `e2e-fake-${engine}-`));
  const runLog = path.join(binDir, "run-args");
  writeFileSync(
    path.join(binDir, engine),
    [
      "#!/bin/sh",
      `if [ "$1" = run ]; then printf '%s\\n' "$@" > '${runLog}'; fi`,
      `if [ "$1" = machine ]; then echo '[{"Running":true}]'; fi`,
      `if [ "$1" = exec ]; then`,
      `  case "$*" in *fake-engine-sigterm*) trap 'exit 0' TERM; echo partial; kill -TERM $$; sleep 5;; esac`,
      // Drop `exec`, its flags and the container name, up to `sh -c …`.
      `  shift; while [ "$#" -gt 0 ] && [ "$1" != sh ]; do shift; done`,
      `  exec "$@"`,
      "fi",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${binDir}${path.delimiter}${process.env["PATH"] ?? ""}`);

  return {
    repo,
    runArgs: () => readFileSync(runLog, "utf8").trimEnd().split("\n"),
    cleanup: () => {
      vi.unstubAllEnvs();
      rmSync(repo, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    },
  };
};
