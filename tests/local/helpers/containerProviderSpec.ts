import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SandboxProvider } from "@ai-hero/sandcastle";
import type { Engine } from "./engines.js";
import {
  WORKSPACE,
  defaultNetworkMode,
  containerExists,
  createNetwork,
  idOf,
  imagesFor,
  inspect,
  removeNetworks,
  sh,
  useSandboxes,
} from "./sandboxes.js";
import { spawnContainerHolder } from "./containerHolder.js";

/** The options docker() and podman() share, as these tests use them. */
export interface SharedOptions {
  readonly imageName: string;
  readonly network?: string | readonly string[];
  readonly groups?: readonly (string | number)[];
  readonly devices?: readonly string[];
  readonly cpus?: number;
  readonly memory?: string;
  readonly pidsLimit?: number;
  readonly mounts?: readonly {
    readonly hostPath: string;
    readonly sandboxPath: string;
    readonly readonly?: boolean;
  }[];
  readonly containerUid?: number;
  readonly containerGid?: number;
}

/** What differs between the engines, for the shared tests. */
export interface EngineUnderTest {
  readonly engine: Engine;
  readonly make: (options: SharedOptions) => SandboxProvider;
  /** The uid:gid a container runs as when no containerUid/Gid is given. */
  readonly defaultUser: string;
  /** The error for an image that isn't built. */
  readonly missingImageError: (image: string) => string;
}

/** The engine's network names, from `<engine> inspect`. */
const networksJson = "{{json .NetworkSettings.Networks}}";
const networkNames = (json: string): Set<string> => {
  const parsed: unknown = JSON.parse(json);
  return new Set(
    typeof parsed === "object" && parsed !== null ? Object.keys(parsed) : [],
  );
};

/**
 * The behaviour docker() and podman() share, against the real engine: the
 * options reach the container, exec and file copies work, and the container
 * goes away on close and on shutdown.
 */
export const describeContainerProvider = (target: EngineUnderTest): void => {
  const { engine, make, defaultUser, missingImageError } = target;
  const images = imagesFor(engine);

  // Each test has its own container, so they run concurrently, except the
  // listener count, which any other open sandbox would throw off.
  describe.skipIf(images === undefined)(
    `${engine}() in a real container`,
    { concurrent: true },
    () => {
      const image = images?.base ?? "";
      const networks: string[] = [];

      beforeAll(async () => {
        networks.push(
          await createNetwork(engine, "one"),
          await createNetwork(engine, "two"),
        );
      });

      afterAll(async () => {
        await removeNetworks(engine, networks);
      });

      it("runs commands as the default user, with HOME at /home/agent", async () => {
        const boxes = useSandboxes(engine);
        const handle = await boxes.open(make({ imageName: image }));

        await expect(
          sh(handle, 'echo "$(id -u):$(id -g) $HOME $PWD"'),
        ).resolves.toBe(`${defaultUser} /home/agent ${WORKSPACE}`);
      });

      it("runs a sudo command as root through the engine, with no sudo binary", async () => {
        const boxes = useSandboxes(engine);
        const handle = await boxes.open(make({ imageName: image }));

        await expect(sh(handle, "command -v sudo || echo none")).resolves.toBe(
          "none",
        );
        // The whole command runs as root, not just its first part.
        await expect(
          sh(handle, "id -u > /tmp/x && id -u >> /tmp/x && cat /tmp/x", {
            sudo: true,
          }),
        ).resolves.toBe("0\n0");
      });

      it("streams lines, feeds stdin, honours cwd and reports the exit code", async () => {
        const boxes = useSandboxes(engine);
        const handle = await boxes.open(make({ imageName: image }));
        const lines: string[] = [];

        const result = await handle.exec("cat; pwd; echo oops >&2; exit 3", {
          onLine: (line) => {
            lines.push(line);
          },
          stdin: "from stdin\n",
          cwd: "/tmp",
        });

        expect(lines).toStrictEqual(["from stdin", "/tmp"]);
        expect(result).toMatchObject({ exitCode: 3, stderr: "oops\n" });
      });

      it("adds no network, group, device or CPU limit when those are omitted", async () => {
        const boxes = useSandboxes(engine);
        const handle = await boxes.open(make({ imageName: image }));

        // The engine's own default, whatever this host's is.
        await expect(
          inspect(engine, handle, "{{.HostConfig.NetworkMode}}"),
        ).resolves.toBe(await defaultNetworkMode(engine, image));
        await expect(sh(handle, "id -G")).resolves.toBe(
          await sh(handle, "id -g"),
        );
        await expect(
          sh(handle, "cut -d' ' -f1 /sys/fs/cgroup/cpu.max"),
        ).resolves.toBe("max");
        await expect(
          sh(handle, "ls /dev | grep -c sandcastle || true"),
        ).resolves.toBe("0");
      });

      it("attaches the container to one network", async () => {
        const boxes = useSandboxes(engine);
        const [one = ""] = networks;
        const handle = await boxes.open(
          make({ imageName: image, network: one }),
        );

        expect(
          networkNames(await inspect(engine, handle, networksJson)),
        ).toStrictEqual(new Set([one]));
      });

      it("attaches the container to every network in an array", async () => {
        const boxes = useSandboxes(engine);
        const handle = await boxes.open(
          make({ imageName: image, network: networks }),
        );

        expect(
          networkNames(await inspect(engine, handle, networksJson)),
        ).toStrictEqual(new Set(networks));
      });

      it("adds the user to each group, by name or numeric GID", async () => {
        const boxes = useSandboxes(engine);
        const handle = await boxes.open(
          make({ imageName: image, groups: ["users", 999] }),
        );

        // Alpine's `users` group is GID 100.
        const ids = await sh(handle, "id -G");
        const groups = ids.split(" ");
        expect(groups).toContain("100");
        expect(groups).toContain("999");
      });

      it("exposes each host device, in order", async () => {
        const boxes = useSandboxes(engine);
        const handle = await boxes.open(
          make({
            imageName: image,
            devices: [
              "/dev/zero:/dev/sandcastle-zero",
              "/dev/null:/dev/sandcastle-null:rwm",
            ],
          }),
        );

        await expect(
          sh(
            handle,
            "test -c /dev/sandcastle-zero && test -c /dev/sandcastle-null && echo ok",
          ),
        ).resolves.toBe("ok");
      });

      it("limits the container's CPUs, fractions included", async () => {
        const boxes = useSandboxes(engine);
        const handle = await boxes.open(make({ imageName: image, cpus: 1.5 }));

        await expect(sh(handle, "cat /sys/fs/cgroup/cpu.max")).resolves.toBe(
          "150000 100000",
        );
      });

      it("caps the container's memory with no swap, and its process count", async () => {
        const boxes = useSandboxes(engine);
        const handle = await boxes.open(
          make({ imageName: image, memory: "64m", pidsLimit: 32 }),
        );

        await expect(
          sh(
            handle,
            "cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.swap.max /sys/fs/cgroup/pids.max",
          ),
        ).resolves.toBe("67108864\n0\n32");
      });

      it("bind-mounts user mounts: read-only ones refuse writes, writable ones reach the host", async () => {
        const boxes = useSandboxes(engine);
        const readOnly = await boxes.workspace();
        const writable = await boxes.workspace();
        await writeFile(path.join(readOnly, "in.txt"), "host file");
        const handle = await boxes.open(
          make({
            imageName: image,
            mounts: [
              {
                hostPath: readOnly,
                sandboxPath: "/home/agent/ro",
                readonly: true,
              },
              // Relative to cwd on the host, and to the workspace in the sandbox.
              {
                hostPath: path.relative(process.cwd(), writable),
                sandboxPath: "data",
              },
            ],
          }),
        );

        await expect(sh(handle, "cat /home/agent/ro/in.txt")).resolves.toBe(
          "host file",
        );
        const write = await handle.exec("touch /home/agent/ro/new");
        expect(write.exitCode).not.toBe(0);
        expect(write.stderr).toMatch(/read-only/iu);

        await sh(handle, `echo from sandbox > ${WORKSPACE}/data/out.txt`);
        await expect(
          readFile(path.join(writable, "out.txt"), "utf8"),
        ).resolves.toBe("from sandbox\n");
      });

      it("creates a file mount's parent directory, owned by the container user", async () => {
        const boxes = useSandboxes(engine);
        const dir = await boxes.workspace();
        const auth = path.join(dir, "auth.json");
        await writeFile(auth, '{"token":"t"}');
        const handle = await boxes.open(
          make({
            imageName: image,
            containerUid: 1000,
            containerGid: 1000,
            mounts: [
              { hostPath: auth, sandboxPath: "/home/agent/.codex/auth.json" },
            ],
          }),
        );

        await expect(
          sh(handle, "stat -c %u:%g /home/agent/.codex"),
        ).resolves.toBe("1000:1000");
        await expect(
          sh(handle, "cat /home/agent/.codex/auth.json"),
        ).resolves.toBe('{"token":"t"}');
      });

      it("copies a file in and back out", async () => {
        const boxes = useSandboxes(engine);
        const dir = await boxes.workspace();
        const out = await boxes.workspace();
        await writeFile(path.join(dir, "in.txt"), "round trip");
        const handle = await boxes.open(make({ imageName: image }));

        await handle.copyFileIn(path.join(dir, "in.txt"), "/tmp/copied.txt");
        await expect(sh(handle, "cat /tmp/copied.txt")).resolves.toBe(
          "round trip",
        );
        await handle.copyFileOut("/tmp/copied.txt", path.join(out, "back.txt"));
        await expect(
          readFile(path.join(out, "back.txt"), "utf8"),
        ).resolves.toBe("round trip");
      });

      it("rejects a copy whose source does not exist", async () => {
        const boxes = useSandboxes(engine);
        const dir = await boxes.workspace();
        const handle = await boxes.open(make({ imageName: image }));

        await expect(
          handle.copyFileIn(path.join(dir, "missing.txt"), "/tmp/x"),
        ).rejects.toThrow(`${engine} cp (in) failed`);
        await expect(
          handle.copyFileOut("/tmp/missing.txt", path.join(dir, "x")),
        ).rejects.toThrow(`${engine} cp (out) failed`);
      });

      it("removes the container on close, quickly", async () => {
        const boxes = useSandboxes(engine);
        const handle = await boxes.open(make({ imageName: image }));
        const name = idOf(handle);
        await expect(containerExists(engine, name)).resolves.toBe(true);

        const started = performance.now();
        await handle.close();

        // podman's PID 1 is `sleep infinity`, which ignores SIGTERM: without
        // `--time 0` the removal would wait out a 10 s stop timeout.
        expect(performance.now() - started).toBeLessThan(5000);
        await expect(containerExists(engine, name)).resolves.toBe(false);
      });

      it("removes the container when the host process is signalled", async () => {
        const boxes = useSandboxes(engine);
        const dir = await boxes.workspace();
        const holder = await spawnContainerHolder(engine, image, dir);
        await expect(
          containerExists(engine, holder.containerName),
        ).resolves.toBe(true);

        const exited = new Promise((resolve) => {
          holder.process.once("exit", resolve);
        });
        holder.process.kill("SIGTERM");
        await exited;

        await expect(
          containerExists(engine, holder.containerName),
        ).resolves.toBe(false);
      });

      it("refuses an image that isn't built, saying how to build it", async () => {
        const boxes = useSandboxes(engine);
        const missing = `sandcastle-local-test:missing-${String(process.pid)}`;
        await expect(boxes.open(make({ imageName: missing }))).rejects.toThrow(
          missingImageError(missing),
        );
      });

      it.sequential("shares one SIGINT, SIGTERM and exit listener across concurrent sandboxes", async () => {
        const boxes = useSandboxes(engine);
        const before = ["SIGINT", "SIGTERM", "exit"].map((event) =>
          process.listenerCount(event),
        );
        const counts = (): number[] =>
          ["SIGINT", "SIGTERM", "exit"].map((event) =>
            process.listenerCount(event),
          );

        const handles = await Promise.all(
          [1, 2, 3].map(async () => boxes.open(make({ imageName: image }))),
        );
        expect(counts()).toStrictEqual(before.map((n) => n + 1));

        await Promise.all(handles.map(async (handle) => handle.close()));
        expect(counts()).toStrictEqual(before);
      });
    },
  );
};
