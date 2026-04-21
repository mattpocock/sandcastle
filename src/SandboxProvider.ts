/**
 * Sandbox provider types — the pluggable interface for sandbox runtimes.
 *
 * Provider authors implement a small Promise-based interface. Sandcastle
 * handles worktree creation, git mount resolution, and commit extraction.
 */

/** Result of executing a command inside a sandbox. */
export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Options for interactiveExec — the streams the provider should wire to the spawned process. */
export interface InteractiveExecOptions {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly cwd?: string;
}

/** Handle to a running bind-mount sandbox. */
export interface BindMountSandboxHandle {
  /** Absolute path to the worktree inside the sandbox. */
  readonly worktreePath: string;
  /**
   * Whether `exec()` forwards the `stdin` option to the underlying child process.
   * When true, callers may deliver large payloads (e.g. prompts larger than
   * `MAX_ARG_STRLEN`) via stdin. When false or unset, the `stdin` option is
   * silently ignored.
   */
  readonly supportsStdinExec?: boolean;
  /**
   * Execute a command in the sandbox.
   *
   * Implementations MUST support line-by-line streaming via `onLine`. This is
   * how Sandcastle delivers live feedback to the user and enforces idle timeouts —
   * without a streaming implementation, neither will work. A buffered/batch
   * implementation that only calls `onLine` after the process exits does NOT
   * satisfy this contract.
   */
  exec(
    command: string,
    options?: {
      onLine?: (line: string) => void;
      cwd?: string;
      sudo?: boolean;
      /**
       * When set, the value is written to the child process's stdin and stdin is
       * then closed. Providers that forward stdin to the underlying process MUST
       * set `supportsStdinExec: true`; providers that ignore this option MUST
       * leave `supportsStdinExec` unset/false. Callers should check the flag on
       * the handle before relying on this behaviour.
       */
      stdin?: string;
    },
  ): Promise<ExecResult>;
  /**
   * Launch an interactive process inside the sandbox.
   * Optional — providers that support interactive sessions implement this.
   * The provider detects TTY mode from the streams (e.g. stdin.isTTY) and
   * allocates a pseudo-terminal accordingly.
   */
  interactiveExec?(
    args: string[],
    options: InteractiveExecOptions,
  ): Promise<{ exitCode: number }>;
  /** Copy a single file from the host into the sandbox. */
  copyFileIn(hostPath: string, sandboxPath: string): Promise<void>;
  /** Copy a single file from the sandbox to the host. */
  copyFileOut(sandboxPath: string, hostPath: string): Promise<void>;
  /** Tear down the sandbox. */
  close(): Promise<void>;
}

/** Options passed to a bind-mount provider's `create` function. */
export interface BindMountCreateOptions {
  /** Host-side path to the worktree directory. */
  readonly worktreePath: string;
  /** Host-side path to the original repo root. */
  readonly hostRepoPath: string;
  /** Volume mounts to apply (host:sandbox pairs). */
  readonly mounts: Array<{
    hostPath: string;
    sandboxPath: string;
    readonly?: boolean;
  }>;
  /** Environment variables to inject into the sandbox. */
  readonly env: Record<string, string>;
}

/** Configuration for createBindMountSandboxProvider. */
export interface BindMountSandboxProviderConfig {
  /** Human-readable name for this provider (e.g. "docker", "podman"). */
  readonly name: string;
  /** Environment variables injected by this provider. Merged at launch time. */
  readonly env?: Record<string, string>;
  /** Create a sandbox handle from the given options. */
  readonly create: (
    options: BindMountCreateOptions,
  ) => Promise<BindMountSandboxHandle>;
}

/** Handle to a running isolated sandbox (extends bind-mount with file transfer). */
export interface IsolatedSandboxHandle {
  /** Absolute path to the worktree inside the sandbox. */
  readonly worktreePath: string;
  /**
   * Whether `exec()` forwards the `stdin` option to the underlying child process.
   * See `BindMountSandboxHandle.supportsStdinExec` for semantics.
   */
  readonly supportsStdinExec?: boolean;
  /**
   * Execute a command in the sandbox.
   *
   * Implementations MUST support line-by-line streaming via `onLine`. This is
   * how Sandcastle delivers live feedback to the user and enforces idle timeouts —
   * without a streaming implementation, neither will work. A buffered/batch
   * implementation that only calls `onLine` after the process exits does NOT
   * satisfy this contract.
   */
  exec(
    command: string,
    options?: {
      onLine?: (line: string) => void;
      cwd?: string;
      sudo?: boolean;
      /**
       * When set, the value is written to the child process's stdin and stdin is
       * then closed. Providers that forward stdin to the underlying process MUST
       * set `supportsStdinExec: true`; providers that ignore this option MUST
       * leave `supportsStdinExec` unset/false. Callers should check the flag on
       * the handle before relying on this behaviour.
       */
      stdin?: string;
    },
  ): Promise<ExecResult>;
  /**
   * Launch an interactive process inside the sandbox.
   * Optional — providers that support interactive sessions implement this.
   * The provider detects TTY mode from the streams (e.g. stdin.isTTY) and
   * allocates a pseudo-terminal accordingly.
   */
  interactiveExec?(
    args: string[],
    options: InteractiveExecOptions,
  ): Promise<{ exitCode: number }>;
  /** Copy a file or directory from the host into the sandbox. */
  copyIn(hostPath: string, sandboxPath: string): Promise<void>;
  /** Copy a single file from the sandbox to the host. */
  copyFileOut(sandboxPath: string, hostPath: string): Promise<void>;
  /** Tear down the sandbox. */
  close(): Promise<void>;
}

/** Options passed to an isolated provider's `create` function. */
export interface IsolatedCreateOptions {
  /** Environment variables to inject into the sandbox. */
  readonly env: Record<string, string>;
}

/** Configuration for createIsolatedSandboxProvider. */
export interface IsolatedSandboxProviderConfig {
  /** Human-readable name for this provider (e.g. "daytona", "e2b"). */
  readonly name: string;
  /** Environment variables injected by this provider. Merged at launch time. */
  readonly env?: Record<string, string>;
  /** Create an isolated sandbox handle from the given options. */
  readonly create: (
    options: IsolatedCreateOptions,
  ) => Promise<IsolatedSandboxHandle>;
}

/** A bind-mount sandbox provider. */
export interface BindMountSandboxProvider {
  /** @internal Discriminator for internal dispatch. */
  readonly tag: "bind-mount";
  /** Human-readable provider name. */
  readonly name: string;
  /** Environment variables injected by this provider. */
  readonly env: Record<string, string>;
  /** @internal Create a sandbox handle. */
  readonly create: (
    options: BindMountCreateOptions,
  ) => Promise<BindMountSandboxHandle>;
}

/** An isolated sandbox provider. */
export interface IsolatedSandboxProvider {
  /** @internal Discriminator for internal dispatch. */
  readonly tag: "isolated";
  /** Human-readable provider name. */
  readonly name: string;
  /** Environment variables injected by this provider. */
  readonly env: Record<string, string>;
  /** @internal Create an isolated sandbox handle. */
  readonly create: (
    options: IsolatedCreateOptions,
  ) => Promise<IsolatedSandboxHandle>;
}

/** Handle to a no-sandbox session — runs commands directly on the host. */
export interface NoSandboxHandle {
  /** Absolute path to the worktree on the host. */
  readonly worktreePath: string;
  /**
   * Whether `exec()` forwards the `stdin` option to the underlying child process.
   * See `BindMountSandboxHandle.supportsStdinExec` for semantics.
   */
  readonly supportsStdinExec?: boolean;
  /**
   * Execute a command on the host.
   *
   * Implementations MUST support line-by-line streaming via `onLine`. This is
   * how Sandcastle delivers live feedback to the user and enforces idle timeouts —
   * without a streaming implementation, neither will work.
   */
  exec(
    command: string,
    options?: {
      onLine?: (line: string) => void;
      cwd?: string;
      sudo?: boolean;
      /**
       * When set, the value is written to the child process's stdin and stdin is
       * then closed. Providers that forward stdin to the underlying process MUST
       * set `supportsStdinExec: true`; providers that ignore this option MUST
       * leave `supportsStdinExec` unset/false. Callers should check the flag on
       * the handle before relying on this behaviour.
       */
      stdin?: string;
    },
  ): Promise<ExecResult>;
  /**
   * Launch an interactive process on the host with inherited stdio.
   */
  interactiveExec(
    args: string[],
    options: InteractiveExecOptions,
  ): Promise<{ exitCode: number }>;
  /** No-op — no container to tear down. */
  close(): Promise<void>;
}

/** A no-sandbox provider — runs the agent directly on the host with no container isolation. */
export interface NoSandboxProvider {
  /** @internal Discriminator for internal dispatch. */
  readonly tag: "none";
  /** Human-readable provider name. */
  readonly name: string;
  /** Environment variables injected by this provider. */
  readonly env: Record<string, string>;
  /** @internal Create a no-sandbox handle. */
  readonly create: (options: {
    readonly worktreePath: string;
    readonly env: Record<string, string>;
  }) => Promise<NoSandboxHandle>;
}

// ---------- Branch strategy types ----------

/** Head strategy: agent writes directly to host working directory. Bind-mount only. */
export interface HeadBranchStrategy {
  readonly type: "head";
}

/** Merge-to-head strategy: temp branch, merge back to HEAD, delete temp branch. */
export interface MergeToHeadBranchStrategy {
  readonly type: "merge-to-head";
}

/** Branch strategy: commits land on an explicit named branch. */
export interface NamedBranchStrategy {
  readonly type: "branch";
  readonly branch: string;
}

/** Branch strategy for bind-mount providers (all three variants). */
export type BindMountBranchStrategy =
  | HeadBranchStrategy
  | MergeToHeadBranchStrategy
  | NamedBranchStrategy;

/** Branch strategy for isolated providers (no head — can't write to host). */
export type IsolatedBranchStrategy =
  | MergeToHeadBranchStrategy
  | NamedBranchStrategy;

/** Branch strategy for no-sandbox providers (all three — same as bind-mount). */
export type NoSandboxBranchStrategy =
  | HeadBranchStrategy
  | MergeToHeadBranchStrategy
  | NamedBranchStrategy;

/** Union of all branch strategy variants. */
export type BranchStrategy =
  | BindMountBranchStrategy
  | IsolatedBranchStrategy
  | NoSandboxBranchStrategy;

/**
 * A sandbox provider — the pluggable unit that `run()` and `createSandbox()` accept.
 * Tagged for internal dispatch: "bind-mount" or "isolated".
 * Does not include `NoSandboxProvider` — that is only valid for `interactive()`.
 */
export type SandboxProvider =
  | BindMountSandboxProvider
  | IsolatedSandboxProvider;

/**
 * Any sandbox provider, including no-sandbox.
 * This is the union accepted by `interactive()`.
 */
export type AnySandboxProvider =
  | BindMountSandboxProvider
  | IsolatedSandboxProvider
  | NoSandboxProvider;

/**
 * Create a bind-mount sandbox provider from a config object.
 * The returned provider can be passed to `run()` or `createSandbox()`.
 */
export const createBindMountSandboxProvider = (
  config: BindMountSandboxProviderConfig,
): BindMountSandboxProvider => ({
  tag: "bind-mount",
  name: config.name,
  env: config.env ?? {},
  create: config.create,
});

/**
 * Create an isolated sandbox provider from a config object.
 * The returned provider can be passed to `run()` or `createSandbox()`.
 */
export const createIsolatedSandboxProvider = (
  config: IsolatedSandboxProviderConfig,
): IsolatedSandboxProvider => ({
  tag: "isolated",
  name: config.name,
  env: config.env ?? {},
  create: config.create,
});
