import { randomUUID } from "node:crypto";
import { DateTime, Either, Option, Schema } from "effect";
import type {
  ProviderCreateOptions,
  ProviderSandbox,
  SandboxProvider,
} from "../SandboxProvider.js";
import { createSandboxProvider } from "../SandboxProvider.js";
import type { ContainerEngine } from "./containerEngineCli.js";
import { cliError, runCli, runCliOrFail } from "./containerEngineCli.js";
import type { ContainerContext } from "./containerEngineExec.js";
import {
  containerExec,
  containerReadTextFile,
  containerSpawnDetached,
  containerWriteTextFile,
} from "./containerEngineExec.js";

// Making, finding and closing a container that is a Sandcastle sandbox, with
// any engine whose CLI takes Docker's `run`, `exec`, `inspect` and `rm`
// (Docker, Podman). Nothing of the host is mounted: the caller clones into an
// empty working directory.
//
// The container's entrypoint is a keep-alive that exits at the kill time, and
// it runs with `--rm`, so the engine ends and removes it then, whether or not
// anything on the host is still running. Work started with `<engine> exec -d`
// belongs to the container, so it outlives the host process.

export type { ContainerEngine } from "./containerEngineCli.js";

/** `native` for a container sandbox: its id, for your own `<engine>` calls. */
export interface EngineContainer {
  /** The container's id. */
  readonly id: string;
}

/** What the engine's provider puts on `<engine> run`, besides what this module sets. */
export interface ContainerRun {
  /** The image. It needs `sh`, and Node.js for sessions. */
  readonly image: string;
  /** Flags for the settings the caller controls: network, limits, user, labels… Never a mount or env. */
  readonly runFlags: readonly string[];
}

type ContainerSandbox = ProviderSandbox<EngineContainer>;

/** The label that holds the kill time, which `get` reads back. */
export const KILL_TIME_LABEL = "sandcastle.kill-time";

/** Sleeps until the epoch second in `$1`, then exits, ending the container. */
const KEEP_ALIVE =
  'd=$(( $1 - $(date +%s) )); [ "$d" -gt 0 ] && exec sleep "$d"';

/**
 * Makes the working directory and resolves it: `$HOME/workspace` for the
 * image's user, or `/workspace` when that's root.
 */
const WORKSPACE =
  'if [ "$(id -u)" = 0 ]; then d=/workspace; else d="$HOME/workspace"; fi; mkdir -p "$d" && printf %s "$d"';

const Inspected = Schema.parseJson(
  Schema.Array(
    Schema.Struct({
      Id: Schema.String,
      State: Schema.Struct({ Running: Schema.Boolean }),
      Config: Schema.Struct({
        Labels: Schema.NullishOr(
          Schema.Record({ key: Schema.String, value: Schema.String }),
        ),
      }),
    }),
  ),
);

const decodeInspected = Schema.decodeUnknownEither(Inspected);

const workspaceOf = async (
  engine: ContainerEngine,
  id: string,
): Promise<string> =>
  runCliOrFail(engine, ["exec", id, "sh", "-c", WORKSPACE], {
    what: "making the working directory",
  });

/** What each sandbox's commands need, kept off the public object. */
const contexts = new WeakMap<ContainerSandbox, ContainerContext>();

const openContainer = (context: ContainerContext, killTime: Date) => {
  let closing: Promise<void> | undefined;
  const sandbox: ContainerSandbox = {
    sandboxId: context.id,
    workingDirectory: context.workingDirectory,
    killTime,
    native: { id: context.id },
    exec: async (options) => containerExec(context, options),
    readTextFile: async ({ path }) => containerReadTextFile(context, path),
    writeTextFile: async ({ path, content }) =>
      containerWriteTextFile(context, path, content),
    close: async () => {
      closing ??= runCliOrFail(context.engine, ["rm", "-f", context.id], {
        what: "removing the container",
      }).then(() => undefined);
      return closing;
    },
  };
  contexts.set(sandbox, context);
  return sandbox;
};

/** The `<engine> run` that starts the container, ended at `killTime` by its keep-alive. */
const runArgs = (
  run: ContainerRun,
  name: string,
  killTime: DateTime.Utc,
): string[] => [
  "run",
  "-d",
  "--rm",
  "--init",
  "--name",
  name,
  ...run.runFlags,
  "--label",
  `${KILL_TIME_LABEL}=${DateTime.formatIso(killTime)}`,
  "--entrypoint",
  "sh",
  run.image,
  "-c",
  KEEP_ALIVE,
  "sh",
  String(DateTime.toEpochMillis(killTime) / 1000),
];

/** The kill time `timeLimitMinutes` from now, on a whole second. */
const killTimeIn = (timeLimitMinutes: number): DateTime.Utc => {
  const seconds = Math.max(1, Math.ceil(timeLimitMinutes * 60));
  const now = DateTime.toEpochMillis(DateTime.unsafeNow());
  return DateTime.unsafeMake((Math.ceil(now / 1000) + seconds) * 1000);
};

/**
 * Makes a container sandbox that the engine ends at its kill time. On any
 * failure, removes whatever was made.
 */
export const createContainerSandbox = async (
  engine: ContainerEngine,
  run: ContainerRun,
  options: ProviderCreateOptions,
): Promise<ContainerSandbox> => {
  const name = `sandcastle-${randomUUID()}`;
  const killTime = killTimeIn(options.timeLimitMinutes);
  try {
    const stdout = await runCliOrFail(engine, runArgs(run, name, killTime), {
      what: "starting the container",
      ...(options.abortSignal === undefined
        ? {}
        : { abortSignal: options.abortSignal }),
    });
    options.abortSignal?.throwIfAborted();
    const id = stdout.trim().split("\n").at(-1) ?? "";
    const workingDirectory = await workspaceOf(engine, id);
    return openContainer(
      { engine, id, workingDirectory, env: options.env },
      DateTime.toDateUtc(killTime),
    );
  } catch (error) {
    await runCli(engine, ["rm", "-f", name]).catch(() => undefined);
    options.abortSignal?.throwIfAborted();
    throw error;
  }
};

/** A running container's id and kill time, or `undefined` if it isn't a running Sandcastle sandbox. */
const inspect = async (
  engine: ContainerEngine,
  sandboxId: string,
): Promise<{ readonly id: string; readonly killTime: Date } | undefined> => {
  const result = await runCli(engine, [
    "inspect",
    "--type",
    "container",
    sandboxId,
  ]);
  if (result.exitCode !== 0) {
    if (/no such (?:container|object)/iu.test(result.stderr)) {
      return undefined;
    }
    throw cliError(engine, `inspecting ${sandboxId}`, result);
  }
  const decoded = decodeInspected(result.stdout);
  if (Either.isLeft(decoded)) {
    throw new Error(
      `${engine.cli}: couldn't read \`${engine.cli} inspect\`'s output: ${decoded.left.message}`,
    );
  }
  const [container] = decoded.right;
  const label = container?.Config.Labels?.[KILL_TIME_LABEL];
  if (container?.State.Running !== true || label === undefined) {
    return undefined;
  }
  return Option.match(DateTime.make(label), {
    onNone: () => undefined,
    onSome: (killTime) => ({
      id: container.Id,
      killTime: DateTime.toDateUtc(killTime),
    }),
  });
};

/**
 * An existing container sandbox by id, or `undefined` once it has ended.
 * Its commands get only their own env: the env it was created with isn't
 * kept anywhere it could be read back from.
 */
export const getContainerSandbox = async (
  engine: ContainerEngine,
  sandboxId: string,
): Promise<ContainerSandbox | undefined> => {
  const found = await inspect(engine, sandboxId);
  if (found === undefined) {
    return undefined;
  }
  const workingDirectory = await workspaceOf(engine, found.id);
  return openContainer(
    { engine, id: found.id, workingDirectory, env: {} },
    found.killTime,
  );
};

/** Starts work with `<engine> exec -d`, which belongs to the container, not the host. */
export const spawnInContainer = async (
  sandbox: ContainerSandbox,
  options: {
    readonly command: string;
    readonly workingDirectory?: string;
    readonly env?: Readonly<Record<string, string>>;
  },
): Promise<void> => {
  const context = contexts.get(sandbox);
  if (context === undefined) {
    throw new TypeError(
      `${sandbox.sandboxId} is not an open container sandbox`,
    );
  }
  await containerSpawnDetached(context, options);
};

/**
 * The detachable provider for `engine`, named after its CLI: what `docker()`
 * and `podman()` return once they've mapped their options to `run`.
 */
export const containerProvider = (
  engine: ContainerEngine,
  run: ContainerRun,
): SandboxProvider<EngineContainer, true> => {
  if (typeof run.image !== "string" || run.image === "") {
    throw new TypeError(
      `${engine.cli}: \`image\` is required: an image with Node.js, git and \`sh\``,
    );
  }
  return createSandboxProvider({
    name: engine.cli,
    create: async (createOptions) =>
      createContainerSandbox(engine, run, createOptions),
    detach: {
      spawnDetached: spawnInContainer,
      get: async (sandboxId) => getContainerSandbox(engine, sandboxId),
    },
  });
};
