import { Either, Schema } from "effect";
import { assertBwrapUsable } from "../../bwrapPreflight.js";
import type {
  ProviderCreateOptions,
  ProviderSandbox,
} from "../SandboxProvider.js";
import type { BwrapSettings } from "./bwrapArgs.js";
import { BWRAP_WORKSPACE, bwrapLaunch } from "./bwrapArgs.js";
import {
  createLocalSandbox,
  getLocalSandbox,
  spawnInLocalSandbox,
} from "./localProviderSandbox.js";

// Making, finding and starting work in bwrap() sandboxes. Each sandbox is a
// folder on the host, owned by its keeper (localProviderSandbox.ts); each
// command is a fresh Bubblewrap over that folder, run by the keeper.

/** What a bwrap() sandbox's `native` holds. */
export interface BwrapNative {
  /** The host folder behind the sandbox: its home, tmp and metadata. Removed when the sandbox ends. */
  readonly stateDirectory: string;
}

type BwrapProviderSandbox = ProviderSandbox<BwrapNative>;

const Settings = Schema.Struct({
  network: Schema.Literal("host", "none"),
  toolchainPaths: Schema.Array(Schema.String),
});
const decodeSettings = Schema.decodeUnknownEither(Settings);

/** Makes a bwrap() sandbox; on any failure, removes whatever was made. */
export const createBwrapSandbox = async (
  settings: BwrapSettings,
  options: ProviderCreateOptions,
): Promise<BwrapProviderSandbox> => {
  assertBwrapUsable();
  return createLocalSandbox({
    provider: "bwrap",
    settings,
    create: options,
    prepare: async (folder) => ({
      launch: await bwrapLaunch(folder, settings),
      workingDirectory: BWRAP_WORKSPACE,
    }),
  });
};

/**
 * An existing bwrap() sandbox by id, or `undefined` once it's gone: its
 * folder removed, or its keeper not running (the machine restarted).
 */
export const getBwrapSandbox = async (
  sandboxId: string,
): Promise<BwrapProviderSandbox | undefined> =>
  getLocalSandbox({
    provider: "bwrap",
    sandboxId,
    prepare: async (folder) => {
      const settings = decodeSettings(folder.settings);
      return Either.isLeft(settings)
        ? undefined
        : {
            launch: await bwrapLaunch(folder, settings.right),
            workingDirectory: BWRAP_WORKSPACE,
          };
    },
  });

/** Starts work under the sandbox's keeper, so it outlives this process. */
export const spawnInBwrapSandbox = spawnInLocalSandbox;
