import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSandbox } from "@ai-hero/sandcastle";
import type { SandboxProvider } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import { setUpFakeEngine } from "./helpers/fakeEngine.js";
import type { FakeEngineWorld } from "./helpers/fakeEngine.js";

// docker({ memory, pidsLimit }) and podman({ memory, pidsLimit }) cap the
// container's memory (`--memory`, with `--memory-swap` set to the same value so
// there is no swap headroom) and its process count (`--pids-limit`) on
// `<engine> run`. No real
// engine runs here: a fake `docker`/`podman` on PATH (tests/helpers/fakeEngine.ts)
// records the arguments of each `run`. The fake is a POSIX shell script, so
// these don't run on Windows.

describe.skipIf(process.platform === "win32").each([
  { engine: "docker", provider: docker },
  { engine: "podman", provider: podman },
] as const)("$engine({ memory, pidsLimit })", ({ engine, provider }) => {
  let world: FakeEngineWorld;

  beforeEach(() => {
    world = setUpFakeEngine(engine, "e2e-limits-");
  });

  afterEach(() => {
    world.cleanup();
  });

  /** The arguments of `<engine> run` when a sandbox starts on `sandbox`. */
  const runArgs = async (sandbox: SandboxProvider): Promise<string[]> => {
    const handle = await createSandbox({
      branch: "w",
      cwd: world.repo,
      sandbox,
    });
    await handle.close();
    return world.runArgs();
  };

  /** The value after `flag`, or undefined when the flag is absent. */
  const flagValue = (
    args: readonly string[],
    flag: string,
  ): string | undefined => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };

  it("passes --memory and an equal --memory-swap", async () => {
    const args = await runArgs(provider({ memory: "512m" }));

    expect(flagValue(args, "--memory")).toBe("512m");
    expect(flagValue(args, "--memory-swap")).toBe("512m");
    expect(args).not.toContain("--pids-limit");
  }, 30_000);

  it("passes --pids-limit", async () => {
    const args = await runArgs(provider({ pidsLimit: 256 }));

    expect(flagValue(args, "--pids-limit")).toBe("256");
    expect(args).not.toContain("--memory");
    expect(args).not.toContain("--memory-swap");
  }, 30_000);

  it("passes both together", async () => {
    const args = await runArgs(provider({ memory: "2g", pidsLimit: 32 }));

    expect(flagValue(args, "--memory")).toBe("2g");
    expect(flagValue(args, "--memory-swap")).toBe("2g");
    expect(flagValue(args, "--pids-limit")).toBe("32");
  }, 30_000);

  it("adds no memory or pids flags when both are omitted", async () => {
    const args = await runArgs(provider());

    expect(args[0]).toBe("run");
    expect(args).not.toContain("--memory");
    expect(args).not.toContain("--memory-swap");
    expect(args).not.toContain("--pids-limit");
  }, 30_000);
});
