import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSandbox } from "@ai-hero/sandcastle";
import type { SandboxProvider } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { setUpFakeEngine } from "./helpers/fakeEngine.js";
import type { FakeEngineWorld } from "./helpers/fakeEngine.js";

// docker({ ports }) publishes only to host loopback. A missing hostPort asks
// Docker to allocate one, while a supplied hostPort creates a fixed binding.
// The fake Docker executable records `docker run` without starting a container.
describe.skipIf(process.platform === "win32")("docker({ ports })", () => {
  let world: FakeEngineWorld;

  beforeEach(() => {
    world = setUpFakeEngine("docker", "e2e-docker-ports-");
  });

  afterEach(() => {
    world.cleanup();
  });

  const runArgs = async (sandbox: SandboxProvider): Promise<string[]> => {
    const handle = await createSandbox({
      branch: "w",
      cwd: world.repo,
      sandbox,
    });
    await handle.close();
    return world.runArgs();
  };

  const publishedPorts = (args: readonly string[]): string[] =>
    args.flatMap((arg, i) => (arg === "--publish" ? [args[i + 1] ?? ""] : []));

  it("publishes fixed host ports on 127.0.0.1", async () => {
    const args = await runArgs(
      docker({ ports: [{ containerPort: 8080, hostPort: 3000 }] }),
    );

    expect(publishedPorts(args)).toStrictEqual(["127.0.0.1:3000:8080"]);
  }, 30_000);

  it("lets Docker allocate a host loopback port", async () => {
    const args = await runArgs(docker({ ports: [{ containerPort: 8080 }] }));

    expect(publishedPorts(args)).toStrictEqual(["127.0.0.1::8080"]);
  }, 30_000);

  it("rejects fixed host-port collisions before starting Docker", () => {
    expect(() =>
      docker({
        ports: [
          { containerPort: 8080, hostPort: 3000 },
          { containerPort: 8081, hostPort: 3000 },
        ],
      }),
    ).toThrow("Host port 3000 is configured more than once");
  });

  it("removes a partial container when Docker reports an occupied host port", async () => {
    world.cleanup();
    world = setUpFakeEngine("docker", "e2e-docker-port-collision-", {
      runFailure: "port is already allocated",
    });

    await expect(
      createSandbox({
        branch: "w",
        cwd: world.repo,
        sandbox: docker({
          ports: [{ containerPort: 8080, hostPort: 3000 }],
        }),
      }),
    ).rejects.toThrow("port is already allocated");

    expect(world.calls()).toContainEqual(
      expect.stringMatching(/^rm sandcastle-/u),
    );
  }, 30_000);

  it("publishes no ports when the option is omitted or empty", async () => {
    const omitted = await runArgs(docker());
    expect(omitted).not.toContain("--publish");

    world.cleanup();
    world = setUpFakeEngine("docker", "e2e-docker-ports-empty-");

    const empty = await runArgs(docker({ ports: [] }));
    expect(empty).not.toContain("--publish");
  }, 30_000);
});
