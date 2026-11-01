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
import { createSandbox } from "@ai-hero/sandcastle";
import type { SandboxProvider } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";

// docker({ capDrop }) and podman({ capDrop }) drop Linux capabilities from the
// container with one `--cap-drop` flag per entry on `<engine> run`. No real
// engine runs here: a fake `docker`/`podman` on PATH records the arguments of
// each `run` and succeeds at everything else. The fake is a POSIX shell
// script, so these don't run on Windows.

describe.skipIf(process.platform === "win32").each([
  { engine: "docker", provider: docker },
  { engine: "podman", provider: podman },
] as const)("$engine({ capDrop })", ({ engine, provider }) => {
  let repo = "";
  let binDir = "";
  let runLog = "";

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(path.join(tmpdir(), "e2e-capdrop-")));
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

  /** The arguments of `<engine> run` when a sandbox starts on `sandbox`. */
  const runArgs = async (sandbox: SandboxProvider): Promise<string[]> => {
    const handle = await createSandbox({ branch: "w", cwd: repo, sandbox });
    await handle.close();
    return readFileSync(runLog, "utf8").trimEnd().split("\n");
  };

  /** The capability after each `--cap-drop`, in order. */
  const droppedCaps = (args: readonly string[]): string[] =>
    args.flatMap((arg, i) => (arg === "--cap-drop" ? [args[i + 1] ?? ""] : []));

  it("passes one --cap-drop per capability, in order", async () => {
    const args = await runArgs(provider({ capDrop: ["NET_RAW", "MKNOD"] }));

    expect(droppedCaps(args)).toStrictEqual(["NET_RAW", "MKNOD"]);
  }, 30_000);

  it("passes ALL through", async () => {
    const args = await runArgs(provider({ capDrop: ["ALL"] }));

    expect(droppedCaps(args)).toStrictEqual(["ALL"]);
  }, 30_000);

  it("adds no --cap-drop when capDrop is omitted", async () => {
    const args = await runArgs(provider());

    expect(args[0]).toBe("run");
    expect(args).not.toContain("--cap-drop");
  }, 30_000);

  it("rejects a capability name that isn't one at compile time", () => {
    // npm run typecheck fails if either line stops being a type error.
    const typos = [
      // @ts-expect-error -- "NET_RAWW" is not a Linux capability.
      () => provider({ capDrop: ["NET_RAWW"] }),
      // @ts-expect-error -- docker takes the name without the CAP_ prefix.
      () => provider({ capDrop: ["CAP_NET_RAW"] }),
    ];
    expect(typos).toHaveLength(2);
  });
});
