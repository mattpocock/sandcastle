import { chmod, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import { describeContainerProvider } from "./helpers/containerProviderSpec.js";
import { WORKSPACE, imagesFor, sh, useSandboxes } from "./helpers/sandboxes.js";

// podman() against the real Podman engine. The behaviour it shares with
// docker() is in helpers/containerProviderSpec.ts.

describeContainerProvider({
  engine: "podman",
  make: podman,
  defaultUser: "1000:1000",
  missingImageError: (image) =>
    `Image '${image}' not found locally. Build it first with 'podman build -t ${image} .'`,
});

const images = imagesFor("podman");
const hostUid = process.getuid?.() ?? 0;

describe.skipIf(images === undefined)(
  "podman() user namespace",
  { concurrent: true },
  () => {
    const base = images?.base ?? "";

    /** The host owner of a file the sandbox creates in the workspace. */
    const ownerOfNewFile = async (
      provider: ReturnType<typeof podman>,
    ): Promise<{ inside: string; hostUid: number }> => {
      const boxes = useSandboxes("podman");
      const dir = await boxes.workspace();
      // Writable whoever the container user maps to on the host.
      await chmod(dir, 0o777);
      const handle = await boxes.open(provider, dir);
      const inside = await sh(handle, `id -u; touch ${WORKSPACE}/new.txt`);
      const created = await stat(path.join(dir, "new.txt"));
      return { inside, hostUid: created.uid };
    };

    it("maps the container user to the host user, so workspace files are the host's", async () => {
      await expect(
        ownerOfNewFile(podman({ imageName: base })),
      ).resolves.toStrictEqual({
        inside: "1000",
        hostUid,
      });
    });

    it("maps a custom containerUid to the host user too", async () => {
      await expect(
        ownerOfNewFile(
          podman({ imageName: base, containerUid: 500, containerGid: 500 }),
        ),
      ).resolves.toStrictEqual({ inside: "500", hostUid });
    });

    it("leaves the user unmapped with userns: false", async () => {
      const owner = await ownerOfNewFile(
        podman({ imageName: base, userns: false }),
      );

      expect(owner.inside).toBe("1000");
      expect(owner.hostUid).not.toBe(hostUid);
    });
  },
);
