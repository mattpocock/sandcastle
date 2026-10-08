/**
 * Sandbox provider types — the pluggable interface for sandbox runtimes.
 *
 * Provider authors implement a small Promise-based interface. Sandcastle
 * handles worktree creation, git mount resolution, and commit extraction.
 */
/** Result of executing a command inside a sandbox. */
interface ExecResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
}
/** Options for interactiveExec — the streams the provider should wire to the spawned process. */
interface InteractiveExecOptions {
    readonly stdin: NodeJS.ReadableStream;
    readonly stdout: NodeJS.WritableStream;
    readonly stderr: NodeJS.WritableStream;
    readonly cwd?: string;
}
/** Handle to a running bind-mount sandbox. */
interface BindMountSandboxHandle {
    /** Absolute path to the worktree inside the sandbox. */
    readonly worktreePath: string;
    /**
     * Execute a command in the sandbox.
     *
     * Implementations MUST support line-by-line streaming via `onLine`. This is
     * how Sandcastle delivers live feedback to the user and enforces idle timeouts —
     * without a streaming implementation, neither will work. A buffered/batch
     * implementation that only calls `onLine` after the process exits does NOT
     * satisfy this contract.
     *
     * When `stdin` is set, the implementation pipes the string to the child
     * process's stdin and closes it. This avoids the Linux 128 KB per-arg limit.
     */
    exec(command: string, options?: {
        onLine?: (line: string) => void;
        cwd?: string;
        sudo?: boolean;
        stdin?: string;
    }): Promise<ExecResult>;
    /**
     * Launch an interactive process inside the sandbox.
     * Optional — providers that support interactive sessions implement this.
     * The provider detects TTY mode from the streams (e.g. stdin.isTTY) and
     * allocates a pseudo-terminal accordingly.
     */
    interactiveExec?(args: string[], options: InteractiveExecOptions): Promise<{
        exitCode: number;
    }>;
    /** Copy a single file from the host into the sandbox. */
    copyFileIn(hostPath: string, sandboxPath: string): Promise<void>;
    /** Copy a single file from the sandbox to the host. */
    copyFileOut(sandboxPath: string, hostPath: string): Promise<void>;
    /** Tear down the sandbox. */
    close(): Promise<void>;
}
/** Options passed to a bind-mount provider's `create` function. */
interface BindMountCreateOptions {
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
interface BindMountSandboxProviderConfig {
    /** Human-readable name for this provider (e.g. "docker", "podman"). */
    readonly name: string;
    /** Environment variables injected by this provider. Merged at launch time. */
    readonly env?: Record<string, string>;
    /**
     * Absolute path to the home directory inside the sandbox (e.g. `"/home/agent"`).
     * Used to expand `~` in user-provided `sandboxPath` mount configs.
     * Set to `undefined` for providers that do not have a fixed home directory.
     */
    readonly sandboxHomedir?: string;
    /** Create a sandbox handle from the given options. */
    readonly create: (options: BindMountCreateOptions) => Promise<BindMountSandboxHandle>;
}
/** Handle to a running isolated sandbox (extends bind-mount with file transfer). */
interface IsolatedSandboxHandle {
    /** Absolute path to the worktree inside the sandbox. */
    readonly worktreePath: string;
    /**
     * Execute a command in the sandbox.
     *
     * Implementations MUST support line-by-line streaming via `onLine`. This is
     * how Sandcastle delivers live feedback to the user and enforces idle timeouts —
     * without a streaming implementation, neither will work. A buffered/batch
     * implementation that only calls `onLine` after the process exits does NOT
     * satisfy this contract.
     *
     * When `stdin` is set, the implementation pipes the string to the child
     * process's stdin and closes it. This avoids the Linux 128 KB per-arg limit.
     */
    exec(command: string, options?: {
        onLine?: (line: string) => void;
        cwd?: string;
        sudo?: boolean;
        stdin?: string;
    }): Promise<ExecResult>;
    /**
     * Launch an interactive process inside the sandbox.
     * Optional — providers that support interactive sessions implement this.
     * The provider detects TTY mode from the streams (e.g. stdin.isTTY) and
     * allocates a pseudo-terminal accordingly.
     */
    interactiveExec?(args: string[], options: InteractiveExecOptions): Promise<{
        exitCode: number;
    }>;
    /** Copy a file or directory from the host into the sandbox. */
    copyIn(hostPath: string, sandboxPath: string): Promise<void>;
    /** Copy a single file from the sandbox to the host. */
    copyFileOut(sandboxPath: string, hostPath: string): Promise<void>;
    /** Tear down the sandbox. */
    close(): Promise<void>;
}
/** Options passed to an isolated provider's `create` function. */
interface IsolatedCreateOptions {
    /** Environment variables to inject into the sandbox. */
    readonly env: Record<string, string>;
}
/** Configuration for createIsolatedSandboxProvider. */
interface IsolatedSandboxProviderConfig {
    /** Human-readable name for this provider (e.g. "daytona", "e2b"). */
    readonly name: string;
    /** Environment variables injected by this provider. Merged at launch time. */
    readonly env?: Record<string, string>;
    /** Create an isolated sandbox handle from the given options. */
    readonly create: (options: IsolatedCreateOptions) => Promise<IsolatedSandboxHandle>;
}
/** A bind-mount sandbox provider. */
interface BindMountSandboxProvider {
    /** Human-readable provider name. */
    readonly name: string;
    /** Environment variables injected by this provider. */
    readonly env: Record<string, string>;
    /**
     * Absolute path to the home directory inside the sandbox (e.g. `"/home/agent"`).
     * `undefined` when the provider does not declare a sandbox home directory.
     */
    readonly sandboxHomedir: string | undefined;
}
/** An isolated sandbox provider. */
interface IsolatedSandboxProvider {
    /** Human-readable provider name. */
    readonly name: string;
    /** Environment variables injected by this provider. */
    readonly env: Record<string, string>;
}
/** Handle to a no-sandbox session — runs commands directly on the host. */
interface NoSandboxHandle {
    /** Absolute path to the worktree on the host. */
    readonly worktreePath: string;
    /**
     * Execute a command on the host.
     *
     * Implementations MUST support line-by-line streaming via `onLine`. This is
     * how Sandcastle delivers live feedback to the user and enforces idle timeouts —
     * without a streaming implementation, neither will work.
     *
     * When `stdin` is set, the implementation pipes the string to the child
     * process's stdin and closes it. This avoids the Linux 128 KB per-arg limit.
     */
    exec(command: string, options?: {
        onLine?: (line: string) => void;
        cwd?: string;
        sudo?: boolean;
        stdin?: string;
    }): Promise<ExecResult>;
    /**
     * Launch an interactive process on the host with inherited stdio.
     */
    interactiveExec(args: string[], options: InteractiveExecOptions): Promise<{
        exitCode: number;
    }>;
    /** No-op — no container to tear down. */
    close(): Promise<void>;
}
/** A no-sandbox provider — runs the agent directly on the host with no container isolation. */
interface NoSandboxProvider {
    /** Human-readable provider name. */
    readonly name: string;
    /** Environment variables injected by this provider. */
    readonly env: Record<string, string>;
}
/** Head strategy: agent writes directly to host working directory. Bind-mount only. */
interface HeadBranchStrategy {
    readonly type: "head";
}
/** Merge-to-head strategy: temp branch, merge back to HEAD, delete temp branch. */
interface MergeToHeadBranchStrategy {
    readonly type: "merge-to-head";
}
/** Branch strategy: commits land on an explicit named branch. */
interface NamedBranchStrategy {
    readonly type: "branch";
    readonly branch: string;
    /**
     * Git ref to use as the starting point when creating a new branch.
     * Only used when the branch doesn't already exist — ignored otherwise.
     * Callers are responsible for ensuring the ref is current (e.g. `git fetch`).
     * Defaults to `HEAD` when omitted.
     */
    readonly baseBranch?: string;
}
/** Branch strategy for bind-mount providers (all three variants). */
type BindMountBranchStrategy = HeadBranchStrategy | MergeToHeadBranchStrategy | NamedBranchStrategy;
/** Branch strategy for isolated providers (no head — can't write to host). */
type IsolatedBranchStrategy = MergeToHeadBranchStrategy | NamedBranchStrategy;
/** Branch strategy for no-sandbox providers (all three — same as bind-mount). */
type NoSandboxBranchStrategy = HeadBranchStrategy | MergeToHeadBranchStrategy | NamedBranchStrategy;
/** Union of all branch strategy variants. */
type BranchStrategy = BindMountBranchStrategy | IsolatedBranchStrategy | NoSandboxBranchStrategy;
/**
 * A sandbox provider — the pluggable unit that `run()`, `interactive()`, and
 * `createSandbox()` accept. Tagged for internal dispatch: "bind-mount",
 * "isolated", or "none". When `NoSandboxProvider` is used, the agent runs
 * directly on the host with no container isolation — opt in at your own risk.
 */
type SandboxProvider = BindMountSandboxProvider | IsolatedSandboxProvider | NoSandboxProvider;
/** @deprecated Use `SandboxProvider` — it now includes `NoSandboxProvider`. */
type AnySandboxProvider = SandboxProvider;
/**
 * Create a bind-mount sandbox provider from a config object.
 * The returned provider can be passed to `run()` or `createSandbox()`.
 */
declare const createBindMountSandboxProvider: (config: BindMountSandboxProviderConfig) => BindMountSandboxProvider;
/**
 * Create an isolated sandbox provider from a config object.
 * The returned provider can be passed to `run()` or `createSandbox()`.
 */
declare const createIsolatedSandboxProvider: (config: IsolatedSandboxProviderConfig) => IsolatedSandboxProvider;

export { type AnySandboxProvider as A, type BindMountSandboxHandle as B, type ExecResult as E, type HeadBranchStrategy as H, type IsolatedSandboxProvider as I, type MergeToHeadBranchStrategy as M, type NoSandboxProvider as N, type SandboxProvider as S, type BranchStrategy as a, type NamedBranchStrategy as b, type BindMountBranchStrategy as c, type BindMountCreateOptions as d, type BindMountSandboxProvider as e, type BindMountSandboxProviderConfig as f, type InteractiveExecOptions as g, type IsolatedBranchStrategy as h, type IsolatedCreateOptions as i, type IsolatedSandboxHandle as j, type IsolatedSandboxProviderConfig as k, type NoSandboxBranchStrategy as l, type NoSandboxHandle as m, createBindMountSandboxProvider as n, createIsolatedSandboxProvider as o };
