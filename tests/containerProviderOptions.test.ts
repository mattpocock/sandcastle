import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SandboxProvider } from "@ai-hero/sandcastle";
import {
  defaultImageName as dockerDefaultImageName,
  docker,
} from "@ai-hero/sandcastle/sandboxes/docker";
import {
  defaultImageName as podmanDefaultImageName,
  podman,
} from "@ai-hero/sandcastle/sandboxes/podman";

// What docker() and podman() decide before any engine runs: their identity,
// their env, the mount checks at construction, and the default image name.
// What reaches a real container is in tests/local/ (`npm run test:local`).

describe.each([
  { name: "docker", provider: docker },
  { name: "podman", provider: podman },
] as const)("$name() before any container starts", ({ name, provider }) => {
  let dir = "";
  let file = "";

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "e2e-provider-opts-")));
    file = path.join(dir, "config.json");
    writeFileSync(file, "{}");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is a bind-mount provider named after its engine, with no branch strategy", () => {
    const made = provider();

    expect(made.tag).toBe("bind-mount");
    expect(made.name).toBe(name);
    expect(made).not.toHaveProperty("branchStrategy");
  });

  it("exposes the env it was given, or none", () => {
    expect(provider({ env: { MY_VAR: "hello" } }).env).toStrictEqual({
      MY_VAR: "hello",
    });
    expect(provider().env).toStrictEqual({});
  });

  it("accepts mounts from ~, an absolute path or a path relative to cwd (the repo root)", () => {
    const made = provider({
      mounts: [
        { hostPath: "~", sandboxPath: "/mnt/home", readonly: true },
        { hostPath: dir, sandboxPath: "data" },
        { hostPath: "tests", sandboxPath: "/mnt/a" },
        { hostPath: "./tests", sandboxPath: "/mnt/b" },
      ],
    });

    expect(made.tag).toBe("bind-mount");
  });

  it("throws when a mount's hostPath does not exist, absolute or relative", () => {
    expect(() =>
      provider({
        mounts: [
          { hostPath: path.join(dir, "missing"), sandboxPath: "/mnt/cache" },
        ],
      }),
    ).toThrow("Mount hostPath does not exist");
    expect(() =>
      provider({
        mounts: [{ hostPath: "nonexistent_dir_xyz", sandboxPath: "/mnt/data" }],
      }),
    ).toThrow("Mount hostPath does not exist");
  });

  it("throws when a file mount's parent is outside the sandbox home", () => {
    expect(() =>
      provider({
        mounts: [{ hostPath: file, sandboxPath: "/opt/foo/config.json" }],
      }),
    ).toThrow(/outside the sandbox home directory/u);
  });
});

describe.each([
  { entry: "docker", defaultImageName: dockerDefaultImageName },
  { entry: "podman", defaultImageName: podmanDefaultImageName },
] as const)(
  "defaultImageName() from the $entry entry",
  ({ defaultImageName }) => {
    it("names the image after the repo directory, lowercased and sanitised", () => {
      expect(defaultImageName("/home/user/my-repo")).toBe("sandcastle:my-repo");
      expect(defaultImageName("/home/user/My Repo!")).toBe(
        "sandcastle:my-repo-",
      );
      expect(defaultImageName("/home/user/repo/")).toBe("sandcastle:repo");
    });

    it("falls back to 'local' for an empty path", () => {
      expect(defaultImageName("")).toBe("sandcastle:local");
    });
  },
);

/** Whether `podman machine list` reports a running machine on this host. */
const podmanMachineRunning = (): boolean => {
  try {
    const machines: unknown = JSON.parse(
      execFileSync("podman", ["machine", "list", "--format", "json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
    return (
      Array.isArray(machines) &&
      machines.some(
        (machine: unknown) =>
          typeof machine === "object" &&
          machine !== null &&
          "Running" in machine &&
          machine.Running === true,
      )
    );
  } catch {
    return false;
  }
};

/** Starts a sandbox from `provider` on a throwaway workspace, then closes it. */
const startOn = async (provider: SandboxProvider): Promise<void> => {
  if (provider.tag !== "bind-mount") {
    throw new Error(`expected a bind-mount provider, got ${provider.tag}`);
  }
  const dir = mkdtempSync(path.join(tmpdir(), "e2e-podman-machine-"));
  try {
    const handle = await provider.create({
      worktreePath: dir,
      hostRepoPath: dir,
      mounts: [{ hostPath: dir, sandboxPath: "/home/agent/workspace" }],
      env: {},
    });
    await handle.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// macOS and Windows run Podman in a VM. With none running (as on CI, where
// Podman isn't installed), podman() says so before it looks for the image.
describe.skipIf(
  (process.platform !== "darwin" && process.platform !== "win32") ||
    podmanMachineRunning(),
)("podman() with no Podman Machine running", () => {
  it("refuses to start, saying how to start one", async () => {
    await expect(
      startOn(podman({ imageName: "sandcastle:never-built" })),
    ).rejects.toThrow(
      "Podman Machine is not running. Run 'podman machine init && podman machine start' first.",
    );
  });
});
