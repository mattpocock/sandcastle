import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSandbox } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import { setUpFakeEngine } from "./helpers/fakeEngine.js";
import type { FakeEngineWorld } from "./helpers/fakeEngine.js";

// A command killed by a signal never counts as success. Node reports such an
// exit as `close(null, signal)`; docker() and podman() map it to a non-zero
// exit code, and keep a real numeric exit code as it is. A fake
// `docker`/`podman` on PATH (tests/helpers/fakeEngine.ts) kills its own
// `exec` with SIGTERM when the command asks it to. The fake is a POSIX shell
// script, so these don't run on Windows.

describe.skipIf(process.platform === "win32").each([
  { engine: "docker", provider: docker },
  { engine: "podman", provider: podman },
] as const)("$engine() exec killed by a signal", ({ engine, provider }) => {
  let world: FakeEngineWorld;

  beforeEach(() => {
    world = setUpFakeEngine(engine, "e2e-signal-exec-");
  });

  afterEach(() => {
    world.cleanup();
  });

  /** Opens a sandbox, runs `command` in it, closes it, returns the result. */
  const execIn = async (
    command: string,
    streamed: boolean,
  ): Promise<{ exitCode: number; stdout: string; lines: string[] }> => {
    const sandbox = await createSandbox({
      branch: "w",
      cwd: world.repo,
      sandbox: provider(),
    });
    try {
      const lines: string[] = [];
      const result = streamed
        ? await sandbox.exec(command, {
            onLine: (line) => {
              lines.push(line);
            },
          })
        : await sandbox.exec(command);
      return { ...result, lines };
    } finally {
      await sandbox.close();
    }
  };

  it("reports a non-zero exit code for a buffered exec", async () => {
    const result = await execIn("fake-engine-sigterm", false);

    expect(result).toMatchObject({ exitCode: 1, stdout: "partial\n" });
  }, 30_000);

  it("reports a non-zero exit code for a streamed exec", async () => {
    const result = await execIn("fake-engine-sigterm", true);

    expect(result).toMatchObject({ exitCode: 1, lines: ["partial"] });
  }, 30_000);

  it("still reports 0 for a command that exits normally", async () => {
    const result = await execIn("true", false);

    expect(result.exitCode).toBe(0);
  }, 30_000);
});
