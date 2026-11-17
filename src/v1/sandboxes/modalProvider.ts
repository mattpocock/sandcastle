// modal(), the Modal provider factory. Its entry point is ./modal.ts.

import type {
  Image,
  ModalClient,
  ModalClientParams,
  Sandbox as ModalSandbox,
} from "modal";
import type { SandboxProvider } from "../SandboxProvider.js";
import { createSandboxProvider } from "../SandboxProvider.js";
import type { ModalCreateOptions } from "./modalSandbox.js";
import {
  createModalSandbox,
  getModalSandbox,
  spawnInModalSandbox,
} from "./modalSandbox.js";

/** Options for `modal()`. They stay on the host: none reach the sandbox. */
export interface ModalOptions {
  /** Modal token id. Default the `MODAL_TOKEN_ID` environment variable, then `~/.modal.toml`. */
  readonly tokenId?: string;
  /** Modal token secret. Default the `MODAL_TOKEN_SECRET` environment variable, then `~/.modal.toml`. */
  readonly tokenSecret?: string;
  /** The Modal environment sandboxes run in. Default the `MODAL_ENVIRONMENT` environment variable, then the profile's. */
  readonly environment?: string;
  /** The Modal App sandboxes belong to, created if it's missing. Default `"sandcastle"`. */
  readonly appName?: string;
  /**
   * The image: a registry tag such as `"node:24-bookworm"`, or a Modal
   * `Image` you built. Default Sandcastle's: `node:24-bookworm` (Node LTS,
   * git) with Claude Code and a non-root `sandcastle` user. Any image needs
   * `sh` and `node`, and `git` and the agent's CLI for sessions. Commands
   * run as the `sandcastle` user when the image has one, and as root when
   * it doesn't.
   */
  readonly image?: string | Image;
  /** Passed to `modal`'s `sandboxes.create`: size, region, network limits, volumes, and anything else it takes. */
  readonly create?: ModalCreateOptions;
}

/** The registry image the default image is built on: Node LTS, with git. */
const DEFAULT_BASE_IMAGE = "node:24-bookworm";

/**
 * Installs Claude Code, and adds the non-root user commands run as, owning
 * the working directory. Claude Code refuses to skip its permission prompts
 * as root, and Modal runs every command as root unless told otherwise.
 */
const DEFAULT_IMAGE_COMMANDS = [
  "RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force",
  "RUN useradd --create-home --shell /bin/bash sandcastle && mkdir -p /workspace && chown sandcastle:sandcastle /workspace",
];

/** The `ModalClient` params: only the connection options that are set. */
const clientParams = (options: ModalOptions): ModalClientParams =>
  Object.fromEntries(
    Object.entries({
      tokenId: options.tokenId,
      tokenSecret: options.tokenSecret,
      environment: options.environment,
    }).filter(([, value]) => value !== undefined && value !== ""),
  );

/** The image to create sandboxes from. */
const imageOf = (
  client: ModalClient,
  image: string | Image | undefined,
): Image => {
  if (typeof image === "string" && image !== "") {
    return client.images.fromRegistry(image);
  }
  if (image !== undefined && typeof image !== "string") {
    return image;
  }
  return client.images
    .fromRegistry(DEFAULT_BASE_IMAGE)
    .dockerfileCommands(DEFAULT_IMAGE_COMMANDS);
};

/**
 * A provider of Modal sandboxes. Sandcastle creates each one with a
 * lifetime (`timeoutMs`) of the sandbox's time limit, at most Modal's 24
 * hours, and no idle timeout, so a run nobody hears back from can't bill
 * forever. Modal can't read the lifetime back, so the kill time is kept in a
 * file in the sandbox. Commands run as the image's non-root `sandcastle`
 * user (root with `sudo`), and env reaches each one in Modal's exec call.
 * `close()` terminates the sandbox. Its sandboxes are detachable: a Modal
 * exec keeps running after the host lets go. `native` is `modal`'s
 * `Sandbox`.
 *
 * @example
 * ```ts
 * import { createSandbox } from "@ai-hero/sandcastle/v1";
 * import { modal } from "@ai-hero/sandcastle/v1/sandboxes/modal";
 *
 * await using sandbox = await createSandbox({
 *   provider: modal({ create: { cpu: 2, memoryMiB: 4096 } }),
 *   env: { GH_TOKEN: token },
 *   timeLimitMinutes: 60,
 * });
 * ```
 */
export const modal = (
  options: ModalOptions = {},
): SandboxProvider<ModalSandbox, true> => {
  // One client per sandbox: closing a sandbox closes its client.
  const connect = async (): Promise<ModalClient> => {
    const { ModalClient: Client } = await import("modal");
    return new Client(clientParams(options));
  };
  return createSandboxProvider({
    name: "modal",
    create: async (createOptions) => {
      const client = await connect();
      return createModalSandbox(
        {
          client,
          appName: options.appName ?? "sandcastle",
          image: imageOf(client, options.image),
          create: options.create,
        },
        createOptions,
      );
    },
    detach: {
      spawnDetached: spawnInModalSandbox,
      get: async (sandboxId) => getModalSandbox(await connect(), sandboxId),
    },
  });
};
