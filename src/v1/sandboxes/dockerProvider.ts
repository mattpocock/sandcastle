// docker(), the Docker provider factory. Its entry point is ./docker.ts.

import type { LinuxCapability } from "../../LinuxCapability.js";
import type { SandboxProvider } from "../SandboxProvider.js";
import { createSandboxProvider } from "../SandboxProvider.js";
import type { ContainerEngine, EngineContainer } from "./containerEngine.js";
import {
  createContainerSandbox,
  getContainerSandbox,
  spawnInContainer,
} from "./containerEngine.js";

/**
 * The `docker run` settings Sandcastle leaves to you, each mapped to its
 * flag. There's no mount, volume, env or entrypoint here: nothing of the host
 * reaches the container, env goes to each command, and Sandcastle sets the
 * entrypoint to the keep-alive that ends the container at its kill time.
 */
export interface DockerCreateOptions {
  /**
   * The network(s) to attach the container to, as `--network`: `"none"` for
   * no network, or a user-defined network. Default Docker's bridge network,
   * whose outbound internet is open.
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
  /** Labels to put on the container, as `--label`. Keys starting `sandcastle.` are Sandcastle's own. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Linux capabilities to add, as `--cap-add`, without the `CAP_` prefix. */
  readonly capAdd?: readonly LinuxCapability[];
  /** Linux capabilities to drop, as `--cap-drop`, without the `CAP_` prefix; `"ALL"` drops every one. */
  readonly capDrop?: readonly LinuxCapability[];
}

/** Options for `docker()`. */
export interface DockerOptions {
  /**
   * The image to run: any image with Node.js (LTS), git and `sh`, plus
   * whatever your agent needs (its CLI, `gh`). It's pulled if it isn't on
   * the host. There's no default.
   */
  readonly image: string;
  /** The `docker run` settings Sandcastle doesn't control. */
  readonly create?: DockerCreateOptions;
}

const DOCKER: ContainerEngine = {
  cli: "docker",
  startHint: "Start Docker Desktop (or the Docker daemon)",
};

const each = (flag: string, values: readonly string[] | undefined) =>
  (values ?? []).flatMap((value) => [flag, value]);

const one = (flag: string, value: string | number | undefined) =>
  value === undefined ? [] : [flag, String(value)];

/** `create` as `docker run` flags. */
const runFlags = (create: DockerCreateOptions = {}): string[] => {
  const { network } = create;
  return [
    ...each("--network", typeof network === "string" ? [network] : network),
    ...one("--cpus", create.cpus),
    ...one("--memory", create.memory),
    ...one("--memory-swap", create.memory),
    ...one("--pids-limit", create.pidsLimit),
    ...one("--user", create.user),
    ...each(
      "--label",
      Object.entries(create.labels ?? {}).map(
        ([key, value]) => `${key}=${value}`,
      ),
    ),
    ...each("--cap-add", create.capAdd),
    ...each("--cap-drop", create.capDrop),
  ];
};

/**
 * A provider of Docker containers, run by the `docker` CLI on the host's
 * PATH. Nothing of the host is mounted: each sandbox starts with an empty
 * working directory (`$HOME/workspace`, or `/workspace` when the image runs
 * as root), and you clone your repo into it.
 *
 * Each container runs detached with `--rm`, and its entrypoint is a
 * keep-alive that exits at the kill time (`timeLimitMinutes` from now), so
 * Docker ends and removes it then, even if nothing on the host is running.
 * Env reaches each command through an owner-only `--env-file` that is
 * removed once read, never `docker run` or a command line. `close()` is
 * `docker rm -f`. Its sandboxes are detachable: the session supervisor is
 * started with `docker exec -d`, so it belongs to the container, not to
 * your process. `native` is `{ id }`, the container's id.
 *
 * @example
 * ```ts
 * import { createSandbox } from "@ai-hero/sandcastle/v1";
 * import { docker } from "@ai-hero/sandcastle/v1/sandboxes/docker";
 *
 * await using sandbox = await createSandbox({
 *   provider: docker({ image: "my-agent-image", create: { memory: "4g" } }),
 *   env: { GH_TOKEN: token },
 *   timeLimitMinutes: 60,
 * });
 * await sandbox.exec("git clone https://github.com/acme/app.git .");
 * ```
 */
export const docker = (
  options: DockerOptions,
): SandboxProvider<EngineContainer, true> => {
  if (typeof options.image !== "string" || options.image === "") {
    throw new TypeError(
      "docker: `image` is required: an image with Node.js, git and `sh`",
    );
  }
  const run = { image: options.image, runFlags: runFlags(options.create) };
  return createSandboxProvider({
    name: "docker",
    create: async (createOptions) =>
      createContainerSandbox(DOCKER, run, createOptions),
    detach: {
      spawnDetached: spawnInContainer,
      get: async (sandboxId) => getContainerSandbox(DOCKER, sandboxId),
    },
  });
};
