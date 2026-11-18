// podman(), the Podman provider factory. Its entry point is ./podman.ts.

import type { LinuxCapability } from "../../LinuxCapability.js";
import type { SandboxProvider } from "../SandboxProvider.js";
import type { ContainerEngine, EngineContainer } from "./containerEngine.js";
import { containerProvider } from "./containerEngine.js";
import { oneFlag, sharedRunFlags } from "./containerEngineFlags.js";

/**
 * The `podman run` settings Sandcastle leaves to you, each mapped to its
 * flag. There's no mount, volume, env or entrypoint here: nothing of the host
 * reaches the container, env goes to each command, and Sandcastle sets the
 * entrypoint to the keep-alive that ends the container at its kill time.
 *
 * Whether containers run rootless or rootful isn't a setting here: it's
 * whichever Podman the `podman` CLI talks to (your user's, `sudo podman`'s,
 * or the connection `CONTAINER_CONNECTION` names).
 */
export interface PodmanCreateOptions {
  /**
   * The network(s) to attach the container to, as `--network`: `"none"` for
   * no network, or a network made with `podman network create`. Default
   * Podman's own (rootless: pasta or slirp4netns), whose outbound internet
   * is open.
   */
  readonly network?: string | readonly string[];
  /** At most this many CPUs, as `--cpus` (fractions allowed). */
  readonly cpus?: number;
  /**
   * A hard memory cap, as `--memory` and `--memory-swap` set to the same
   * value (no swap headroom): `"2g"`, `"512m"`.
   */
  readonly memory?: string;
  /** At most this many processes, as `--pids-limit`. */
  readonly pidsLimit?: number;
  /**
   * The user commands run as, as `--user` (`"1000:1000"`, `"agent"`).
   * Default the image's own user. `sudo: true` on an `exec` runs as root
   * whatever this is.
   */
  readonly user?: string;
  /**
   * The user namespace, as `--userns`: `"auto"`, `"host"`, `"nomap"`, or
   * `"keep-id"`. Default Podman's own (rootless: the container's root is
   * your user). With nothing mounted, no file ownership needs mapping, so
   * the default suits most images.
   */
  readonly userns?: string;
  /** Labels to put on the container, as `--label`. Keys starting `sandcastle.` are Sandcastle's own. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Linux capabilities to add, as `--cap-add`, without the `CAP_` prefix. */
  readonly capAdd?: readonly LinuxCapability[];
  /** Linux capabilities to drop, as `--cap-drop`, without the `CAP_` prefix; `"ALL"` drops every one. */
  readonly capDrop?: readonly LinuxCapability[];
}

/** Options for `podman()`. */
export interface PodmanOptions {
  /**
   * The image to run: any image with Node.js (LTS), git and `sh`, plus
   * whatever your agent needs (its CLI, `gh`). It's pulled if it isn't on
   * the host. Name it in full (`docker.io/library/node:22`) unless your
   * Podman resolves short names. There's no default.
   */
  readonly image: string;
  /** The `podman run` settings Sandcastle doesn't control. */
  readonly create?: PodmanCreateOptions;
}

const PODMAN: ContainerEngine = {
  cli: "podman",
  startHint: "Start Podman (on macOS and Windows, `podman machine start`)",
};

/**
 * A provider of Podman containers, run by the `podman` CLI on the host's
 * PATH. Nothing of the host is mounted: each sandbox starts with an empty
 * working directory (`$HOME/workspace`, or `/workspace` when the image runs
 * as root), and you clone your repo into it.
 *
 * Each container runs detached with `--rm`, and its entrypoint is a
 * keep-alive that exits at the kill time (`timeLimitMinutes` from now), so
 * Podman ends and removes it then, even if nothing on the host is running.
 * Env reaches each command through an owner-only `--env-file` that is
 * removed once read, never `podman run` or a command line. `close()` is
 * `podman rm -f`. Its sandboxes are detachable: the session supervisor is
 * started with `podman exec -d`, so it belongs to the container, not to
 * your process. Rootless containers end when your user's last login session
 * does, unless lingering is on (`loginctl enable-linger`). `native` is
 * `{ id }`, the container's id.
 *
 * @example
 * ```ts
 * import { createSandbox } from "@ai-hero/sandcastle/v1";
 * import { podman } from "@ai-hero/sandcastle/v1/sandboxes/podman";
 *
 * await using sandbox = await createSandbox({
 *   provider: podman({
 *     image: "localhost/my-agent-image",
 *     create: { memory: "4g" },
 *   }),
 *   env: { GH_TOKEN: token },
 *   timeLimitMinutes: 60,
 * });
 * await sandbox.exec("git clone https://github.com/acme/app.git .");
 * ```
 */
export const podman = (
  options: PodmanOptions,
): SandboxProvider<EngineContainer, true> =>
  containerProvider(PODMAN, {
    image: options.image,
    runFlags: [
      ...sharedRunFlags(options.create),
      ...oneFlag("--userns", options.create?.userns),
    ],
  });
