import { describe, expect, it } from "vitest";
import type { BindMountSandboxHandle } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { describeContainerProvider } from "./helpers/containerProviderSpec.js";
import {
  WORKSPACE,
  imagesFor,
  inspect,
  sh,
  useSandboxes,
} from "./helpers/sandboxes.js";

// docker() against the real Docker engine. The behaviour it shares with
// podman() is in helpers/containerProviderSpec.ts.

const hostUid = process.getuid?.() ?? 1000;
const hostGid = process.getgid?.() ?? 1000;

describeContainerProvider({
  engine: "docker",
  make: docker,
  defaultUser: `${String(hostUid)}:${String(hostGid)}`,
  missingImageError: (image) =>
    `Image '${image}' not found locally. Build it first with 'sandcastle docker build-image'.`,
});

const images = imagesFor("docker");

describe.skipIf(images === undefined)(
  "docker() image user and SELinux labels",
  { concurrent: true },
  () => {
    const base = images?.base ?? "";
    const uid500 = images?.uid500 ?? "";

    it.skipIf(hostUid === 500)(
      "refuses an image built for another UID, naming the fix",
      async () => {
        const boxes = useSandboxes("docker");
        await expect(boxes.open(docker({ imageName: uid500 }))).rejects.toThrow(
          `UID mismatch: image '${uid500}' was built with UID 500, but the expected UID is ${String(hostUid)}. ` +
            "Rebuild the image with 'sandcastle docker build-image', or pass containerUid: 500 to docker() to match the image.",
        );
      },
    );

    it("runs as containerUid and containerGid, which may match such an image", async () => {
      const boxes = useSandboxes("docker");
      const handle = await boxes.open(
        docker({ imageName: uid500, containerUid: 500, containerGid: 500 }),
      );

      await expect(sh(handle, 'echo "$(id -u):$(id -g)"')).resolves.toBe(
        "500:500",
      );
    });

    /** The bind specs Docker recorded, by sandbox path. */
    const binds = async (
      handle: BindMountSandboxHandle,
    ): Promise<Map<string, string>> => {
      const specs: unknown = JSON.parse(
        await inspect("docker", handle, "{{json .HostConfig.Binds}}"),
      );
      const list = Array.isArray(specs) ? specs.map(String) : [];
      return new Map(list.map((spec) => [spec.split(":")[1] ?? "", spec]));
    };

    it("labels bind mounts :z by default, read-only ones :ro,z", async () => {
      const boxes = useSandboxes("docker");
      const dir = await boxes.workspace();
      const extra = await boxes.workspace();
      const handle = await boxes.open(
        docker({
          imageName: base,
          mounts: [
            { hostPath: extra, sandboxPath: "/home/agent/ro", readonly: true },
          ],
        }),
        dir,
      );

      const recorded = await binds(handle);
      expect(recorded.get(WORKSPACE)).toBe(`${dir}:${WORKSPACE}:z`);
      expect(recorded.get("/home/agent/ro")).toBe(
        `${extra}:/home/agent/ro:ro,z`,
      );
    });

    it("labels bind mounts :Z with selinuxLabel 'Z'", async () => {
      const boxes = useSandboxes("docker");
      const dir = await boxes.workspace();
      const handle = await boxes.open(
        docker({ imageName: base, selinuxLabel: "Z" }),
        dir,
      );

      const recorded = await binds(handle);
      expect(recorded.get(WORKSPACE)).toBe(`${dir}:${WORKSPACE}:Z`);
    });

    it("adds no label with selinuxLabel false, leaving read-only ones :ro", async () => {
      const boxes = useSandboxes("docker");
      const dir = await boxes.workspace();
      const extra = await boxes.workspace();
      const handle = await boxes.open(
        docker({
          imageName: base,
          selinuxLabel: false,
          mounts: [
            { hostPath: extra, sandboxPath: "/home/agent/ro", readonly: true },
          ],
        }),
        dir,
      );

      const recorded = await binds(handle);
      expect(recorded.get(WORKSPACE)).toBe(`${dir}:${WORKSPACE}`);
      expect(recorded.get("/home/agent/ro")).toBe(`${extra}:/home/agent/ro:ro`);
    });
  },
);
