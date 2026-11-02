/**
 * A host process that holds a docker() or podman() sandbox open, for the
 * local tests' shutdown check. Run as a separate Node process (see
 * {@link spawnContainerHolder}): it starts a container from the image given,
 * prints its name, and waits to be signalled. Nothing here closes the
 * sandbox, so only the provider's shutdown hook can remove the container.
 *
 *   node --import tsx tests/local/helpers/holdContainerSandbox.ts <engine> <image> <dir>
 */

import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";

const [engine, imageName, dir] = process.argv.slice(2);
if (
  (engine !== "docker" && engine !== "podman") ||
  imageName === undefined ||
  dir === undefined
) {
  throw new Error(
    "usage: holdContainerSandbox.ts <docker|podman> <image> <workspace dir>",
  );
}

const provider =
  engine === "docker" ? docker({ imageName }) : podman({ imageName });
if (provider.tag !== "bind-mount") {
  throw new Error(`expected a bind-mount provider, got ${provider.tag}`);
}
const handle = await provider.create({
  worktreePath: dir,
  hostRepoPath: dir,
  mounts: [{ hostPath: dir, sandboxPath: "/home/agent/workspace" }],
  env: {},
});
process.stdout.write(`ready ${handle.sandboxId ?? ""}\n`);
// Keep the event loop alive until the test signals this process.
setInterval(() => undefined, 60_000);
