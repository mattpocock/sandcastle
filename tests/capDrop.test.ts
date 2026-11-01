import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSandbox } from "@ai-hero/sandcastle";
import type { SandboxProvider } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import { setUpFakeEngine } from "./helpers/fakeEngine.js";
import type { FakeEngineWorld } from "./helpers/fakeEngine.js";

// docker({ capDrop }) and podman({ capDrop }) drop Linux capabilities from the
// container with one `--cap-drop` flag per entry on `<engine> run`. No real
// engine runs here: a fake `docker`/`podman` on PATH (tests/helpers/fakeEngine.ts)
// records the arguments of each `run`. The fake is a POSIX shell script, so
// these don't run on Windows.

describe.skipIf(process.platform === "win32").each([
  { engine: "docker", provider: docker },
  { engine: "podman", provider: podman },
] as const)("$engine({ capDrop })", ({ engine, provider }) => {
  let world: FakeEngineWorld;

  beforeEach(() => {
    world = setUpFakeEngine(engine, "e2e-capdrop-");
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
