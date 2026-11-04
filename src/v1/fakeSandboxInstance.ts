import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Config, DateTime, Effect } from "effect";
import type {
  ProviderCreateOptions,
  ProviderSandbox,
} from "./SandboxProvider.js";
import { runProcess, spawnDetachedProcess } from "./fakeExec.js";
import { readSandboxFile, writeSandboxFile } from "./fakeFiles.js";
import type { FakeState } from "./fakeSandboxState.js";
import {
  destroy,
  readState,
  startReaper,
  writeState,
} from "./fakeSandboxState.js";

/** The vendor object of a fake sandbox: where it lives on the host. */
export interface FakeSandboxNative {
  /** The host directory backing the sandbox: `work/`, `home/` and `tmp/` are inside it. */
  readonly directory: string;
}

/** A fake sandbox as the provider contract sees it. */
export type FakeProviderSandbox = ProviderSandbox<FakeSandboxNative>;

/** Where fake sandboxes live. */
export interface FakeRoot {
  readonly rootDir: string;
}

const openSandbox = (
  root: FakeRoot,
  {
    sandboxId,
    state,
  }: { readonly sandboxId: string; readonly state: FakeState },
  onClose: () => void,
): FakeProviderSandbox => {
  const dir = path.join(root.rootDir, sandboxId);
  const context = { dir, hostPath: state.hostPath, env: state.env };
  let closing: Promise<void> | undefined;
  return {
    sandboxId,
    workingDirectory: path.join(dir, "work"),
    killTime: DateTime.toDateUtc(DateTime.unsafeMake(state.killTime)),
    native: { directory: dir },
    exec: (options) => runProcess(context, options),
    readTextFile: (options) => readSandboxFile(dir, options.path),
    writeTextFile: (options) =>
      writeSandboxFile(dir, options.path, options.content),
    close: () => {
      closing ??= destroy(dir).finally(onClose);
      return closing;
    },
  };
};

const makeDirectory = async (dir: string, state: FakeState) => {
  try {
    await Promise.all(
      ["work", "home", "tmp"].map(async (sub) =>
        mkdir(path.join(dir, sub), { recursive: true }),
      ),
    );
    await writeState(dir, state);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
};

/** A new sandbox's state: its kill time, the host's PATH and its env. */
const newState = async (options: ProviderCreateOptions): Promise<FakeState> =>
  Effect.runPromise(
    Effect.all({
      now: DateTime.now,
      hostPath: Config.withDefault(Config.string("PATH"), ""),
    }).pipe(
      Effect.map(({ now, hostPath }) => ({
        killTime: DateTime.formatIso(
          DateTime.add(now, { millis: options.timeLimitMinutes * 60_000 }),
        ),
        hostPath,
        env: { ...options.env },
      })),
    ),
  );

/** Makes a fake sandbox that is killed at its kill time. */
export const createFakeSandbox = async (
  root: FakeRoot,
  options: ProviderCreateOptions,
  onClose: (sandbox: FakeProviderSandbox) => void,
): Promise<FakeProviderSandbox> => {
  const sandboxId = `fake-${randomUUID()}`;
  const dir = path.join(root.rootDir, sandboxId);
  const state = await newState(options);
  await makeDirectory(dir, state);
  const sandbox = openSandbox(root, { sandboxId, state }, () => {
    onClose(sandbox);
  });
  if (options.abortSignal?.aborted === true) {
    await sandbox.close();
    throw options.abortSignal.reason;
  }
  await startReaper(dir, options.timeLimitMinutes * 60);
  return sandbox;
};

/** An existing fake sandbox by id, or `undefined` once it has ended. */
export const getFakeSandbox = async (
  root: FakeRoot,
  sandboxId: string,
): Promise<FakeProviderSandbox | undefined> => {
  if (path.basename(sandboxId) !== sandboxId) {
    return undefined;
  }
  const state = await readState(path.join(root.rootDir, sandboxId));
  return state === undefined
    ? undefined
    : openSandbox(root, { sandboxId, state }, () => undefined);
};

/** Starts work in a fake sandbox that outlives the handle, with the sandbox's env. */
export const spawnInFakeSandbox = async (
  sandbox: FakeProviderSandbox,
  options: {
    readonly command: string;
    readonly workingDirectory?: string;
    readonly env?: Readonly<Record<string, string>>;
  },
) => {
  const dir = sandbox.native.directory;
  const state = await readState(dir);
  if (state === undefined) {
    throw new Error(`fakeSandbox: ${sandbox.sandboxId} has ended`);
  }
  await spawnDetachedProcess(
    { dir, hostPath: state.hostPath, env: state.env },
    options,
  );
};
