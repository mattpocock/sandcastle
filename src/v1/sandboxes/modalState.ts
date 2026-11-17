import { DateTime, Option } from "effect";
import type { Sandbox as ModalSandbox } from "modal";
import type { ModalUser } from "./modalExec.js";

// What Modal can't tell Sandcastle about a sandbox it made: its kill time
// (Modal never reads `timeoutMs` back) and the user its commands run as.
// Written at create to a root-owned file outside the working directory, and
// read back when reattaching.

/** The state file. */
export const MODAL_STATE_PATH = "/var/lib/sandcastle/sandbox.json";

/** A sandbox's state, as kept in its state file. */
export interface ModalState {
  readonly killTime: Date;
  readonly user: ModalUser | undefined;
}

/** Writes the state file, as root. */
export const writeModalState = async (
  sandbox: ModalSandbox,
  { killTime, user }: ModalState,
): Promise<void> => {
  await sandbox.filesystem.writeText(
    JSON.stringify({ killTime: killTime.toISOString(), user: user ?? null }),
    MODAL_STATE_PATH,
  );
};

const isUser = (value: unknown): value is ModalUser =>
  typeof value === "object" &&
  value !== null &&
  "name" in value &&
  typeof value.name === "string" &&
  "home" in value &&
  typeof value.home === "string";

/** The state in `text`, or `undefined` when it isn't one. */
const parse = (text: string): ModalState | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("killTime" in value) ||
    typeof value.killTime !== "string" ||
    !("user" in value) ||
    (value.user !== null && !isUser(value.user))
  ) {
    return undefined;
  }
  const killTime = DateTime.make(value.killTime);
  return Option.isNone(killTime)
    ? undefined
    : {
        killTime: DateTime.toDateUtc(killTime.value),
        user: value.user ?? undefined,
      };
};

/**
 * The state file's state. Rejects when it's missing or broken: without it
 * the kill time is unknown, and Sandcastle never guesses one.
 */
export const readModalState = async (
  sandbox: ModalSandbox,
): Promise<ModalState> => {
  const text = await sandbox.filesystem
    .readText(MODAL_STATE_PATH)
    .catch((error: unknown) => {
      if (
        error instanceof Error &&
        error.name === "SandboxFilesystemNotFoundError"
      ) {
        return undefined;
      }
      throw error;
    });
  const state = text === undefined ? undefined : parse(text);
  if (state === undefined) {
    throw new Error(
      `modal: sandbox ${sandbox.sandboxId} has no readable ${MODAL_STATE_PATH}, so its kill time is unknown. Sandcastle writes it at create: was it removed?`,
    );
  }
  return state;
};
