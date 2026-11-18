import { Either, Schema } from "effect";
import { assertSeatbeltUsable } from "../../seatbeltPreflight.js";
import type {
  ProviderCreateOptions,
  ProviderSandbox,
} from "../SandboxProvider.js";
import { createLocalSandbox, getLocalSandbox } from "./localProviderSandbox.js";
import type { SeatbeltSettings } from "./seatbeltArgs.js";
import { seatbeltSetup } from "./seatbeltArgs.js";

// Making, finding and starting work in seatbelt() sandboxes. Each sandbox
// is a folder on the host, owned by its keeper (localProviderSandbox.ts);
// each command is a fresh `sandbox-exec` scoped to that folder, run by the
// keeper.

/** What a seatbelt() sandbox's `native` holds. */
export interface SeatbeltNative {
  /** The host folder behind the sandbox: its home, tmp and metadata. Removed when the sandbox ends. */
  readonly stateDirectory: string;
}

type SeatbeltProviderSandbox = ProviderSandbox<SeatbeltNative>;

const Settings = Schema.Struct({
  network: Schema.Literal("host", "none"),
  toolchainPaths: Schema.Array(Schema.String),
});
const decodeSettings = Schema.decodeUnknownEither(Settings);

/** Makes a seatbelt() sandbox; on any failure, removes whatever was made. */
export const createSeatbeltSandbox = async (
  settings: SeatbeltSettings,
  options: ProviderCreateOptions,
): Promise<SeatbeltProviderSandbox> => {
  assertSeatbeltUsable();
  return createLocalSandbox({
    provider: "seatbelt",
    settings,
    create: options,
    prepare: async (folder) => seatbeltSetup(folder, settings),
  });
};

/**
 * An existing seatbelt() sandbox by id, or `undefined` once it's gone: its
 * folder removed, or its keeper not running (the machine restarted).
 */
export const getSeatbeltSandbox = async (
  sandboxId: string,
): Promise<SeatbeltProviderSandbox | undefined> =>
  getLocalSandbox({
    provider: "seatbelt",
    sandboxId,
    prepare: async (folder) => {
      const settings = decodeSettings(folder.settings);
      return Either.isLeft(settings)
        ? undefined
        : seatbeltSetup(folder, settings.right);
    },
  });

/** Starts work under the sandbox's keeper, so it outlives this process. */
export { spawnInLocalSandbox as spawnInSeatbeltSandbox } from "./localProviderSandbox.js";
