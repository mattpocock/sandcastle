/**
 * The v1 sandbox provider contract: one small, Promise-based interface every
 * backend implements. Most users never touch it; they call a factory such as
 * `fakeSandbox()`. It's here for people writing their own provider.
 *
 * A provider makes sandboxes from the options it was given at its factory
 * call (vendor image, size, region…). `createSandbox` only hands it the env
 * and the time limit.
 */

/** What `createSandbox` passes to a provider's `create`. */
export interface ProviderCreateOptions {
  /** Exactly the env the caller passed to `createSandbox`. Every command in the sandbox gets it. Nothing else. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Wall-clock limit for the sandbox's whole life. Set the vendor's own limit
   * from it, so a sandbox nobody holds can't keep running, and report the
   * resulting time as `killTime`.
   */
  readonly timeLimitMinutes: number;
  /** Aborts creation. Clean up whatever was made so far. */
  readonly abortSignal?: AbortSignal;
}

/** One command for a provider sandbox to run. */
export interface ProviderExecOptions {
  /** The shell command. */
  readonly command: string;
  /** Directory to run in. Relative paths resolve against the sandbox's `workingDirectory`. */
  readonly workingDirectory?: string;
  /** Extra env for this command only, on top of the sandbox's env. */
  readonly env?: Readonly<Record<string, string>>;
  /** Run it as root. */
  readonly sudo?: boolean;
  /** Written to the command's stdin, which is then closed. Without it, stdin is empty. */
  readonly stdin?: string;
  /**
   * Called with each line of stdout as it arrives, not after the command ends:
   * callers use it to see progress and detect hangs.
   */
  readonly onLine?: (line: string) => void;
  /** Kills the command. */
  readonly abortSignal?: AbortSignal;
}

/** The outcome of a command. */
export interface ProviderExecResult {
  /** The command's exit code. */
  readonly exitCode: number;
  /** Everything the command printed to stdout. */
  readonly stdout: string;
  /** Everything the command printed to stderr. */
  readonly stderr: string;
}

/** A live sandbox, as a provider exposes it to Sandcastle. */
export interface ProviderSandbox<Native = unknown> {
  /** The provider's id for this sandbox. */
  readonly sandboxId: string;
  /** The directory commands start in. Never changes. */
  readonly workingDirectory: string;
  /** When the provider will end the sandbox, whatever is running in it. */
  readonly killTime: Date;
  /** The vendor's own object for this sandbox, for features Sandcastle doesn't wrap. */
  readonly native: Native;
  /** Run a command and wait for it. Resolves with any exit code. */
  readonly exec: (options: ProviderExecOptions) => Promise<ProviderExecResult>;
  /** Read a text file, or `null` if it doesn't exist. Relative paths resolve against `workingDirectory`. */
  readonly readTextFile: (options: {
    readonly path: string;
  }) => Promise<string | null>;
  /** Write a text file, creating parent directories. Relative paths resolve against `workingDirectory`. */
  readonly writeTextFile: (options: {
    readonly path: string;
    readonly content: string;
  }) => Promise<void>;
  /** End the sandbox and kill everything running in it. Safe to call twice. */
  readonly close: () => Promise<void>;
}

/** What a provider adds to make its sandboxes detachable: work that outlives the host's hold on them. */
export interface DetachCapability<Native = unknown> {
  /** Start a command that keeps running after the host lets go of the sandbox; resolve once it has started. */
  readonly spawnDetached: (
    sandbox: ProviderSandbox<Native>,
    options: {
      readonly command: string;
      readonly workingDirectory?: string;
      readonly env?: Readonly<Record<string, string>>;
    },
  ) => Promise<void>;
  /** Get an existing sandbox by id, or `undefined` if it has ended. */
  readonly get: (
    sandboxId: string,
  ) => Promise<ProviderSandbox<Native> | undefined>;
}

/** Everything a provider author supplies to `createSandboxProvider`. */
export interface SandboxProviderConfig<Native = unknown> {
  /** A short name for logs, e.g. `"daytona"`. */
  readonly name: string;
  /** Make a sandbox. If it fails partway, clean up what it made before rejecting. */
  readonly create: (
    options: ProviderCreateOptions,
  ) => Promise<ProviderSandbox<Native>>;
  /** Supply this to make the provider's sandboxes detachable. */
  readonly detach?: DetachCapability<Native>;
}

declare const nativeType: unique symbol;

/**
 * Something that makes sandboxes, built with `createSandboxProvider`. Pass it
 * to `createSandbox`. `CanDetach` says whether its sandboxes can be detached
 * from: a sandbox that's a child of your process can't.
 */
export interface SandboxProvider<
  Native = unknown,
  CanDetach extends boolean = boolean,
> {
  /** A short name for logs. */
  readonly name: string;
  /** Whether this provider's sandboxes are detachable. */
  readonly canDetach: CanDetach;
  /** Type-only: the vendor object a sandbox's `native` holds. */
  readonly [nativeType]?: Native;
}

/** What `createSandbox` needs from a provider's config, with `Native` erased. */
interface ProviderInternals {
  readonly create: (options: ProviderCreateOptions) => Promise<ProviderSandbox>;
}

const internals = new WeakMap<object, ProviderInternals>();

/** Build a sandbox provider from your own backend. Supplying `detach` makes it detachable. */
export function createSandboxProvider<Native>(
  config: SandboxProviderConfig<Native> & {
    readonly detach: DetachCapability<Native>;
  },
): SandboxProvider<Native, true>;
export function createSandboxProvider<Native>(
  config: SandboxProviderConfig<Native> & { readonly detach?: undefined },
): SandboxProvider<Native, false>;
export function createSandboxProvider<Native>(
  config: SandboxProviderConfig<Native>,
): SandboxProvider<Native> {
  const provider = {
    name: config.name,
    canDetach: config.detach !== undefined,
  };
  internals.set(provider, { create: config.create });
  return provider;
}

/** The internals behind a provider made by `createSandboxProvider`. */
export const providerInternals = (
  provider: SandboxProvider,
): ProviderInternals => {
  const config = internals.get(provider);
  if (config === undefined) {
    throw new TypeError(
      "createSandbox: `provider` must come from createSandboxProvider() or a provider factory",
    );
  }
  return config;
};
