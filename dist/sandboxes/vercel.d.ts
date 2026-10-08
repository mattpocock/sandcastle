import { I as IsolatedSandboxProvider } from '../SandboxProvider-EkSMuBp8.js';

/**
 * Vercel isolated sandbox provider — wraps `@vercel/sandbox` into a SandboxProvider.
 *
 * Usage:
 *   import { vercel } from "sandcastle/sandboxes/vercel";
 *   await run({ agent: claudeCode("claude-opus-4-8"), sandbox: vercel() });
 */

/**
 * Options for creating a Vercel sandbox provider.
 *
 * All `@vercel/sandbox` `Sandbox.create()` options are accepted as pass-through,
 * plus Sandcastle-specific options for auth and branch strategy.
 */
interface VercelOptions {
    /**
     * Vercel access token.
     *
     * Falls back to the SDK's default auth behavior, which reads
     * `VERCEL_OIDC_TOKEN` (recommended for Vercel-hosted environments) or
     * `VERCEL_TOKEN` from the environment.
     */
    readonly token?: string;
    /**
     * The source of the sandbox (git repo, tarball, or snapshot).
     * Omit to start an empty sandbox.
     */
    readonly source?: {
        type: "git";
        url: string;
        depth?: number;
        revision?: string;
        username?: string;
        password?: string;
    } | {
        type: "tarball";
        url: string;
    } | {
        type: "snapshot";
        snapshotId: string;
    };
    /** Array of port numbers to expose from the sandbox (up to 4). */
    readonly ports?: number[];
    /** Timeout in milliseconds before the sandbox auto-terminates. */
    readonly timeout?: number;
    /**
     * Resources to allocate to the sandbox.
     * Each vCPU gets 2048 MB of memory.
     */
    readonly resources?: {
        vcpus: number;
    };
    /**
     * The runtime of the sandbox (e.g. `"node24"`, `"node22"`, `"python3.13"`).
     * Defaults to `"node24"`.
     */
    readonly runtime?: string;
    /**
     * Network policy for the sandbox.
     * Defaults to full internet access if not specified.
     */
    readonly networkPolicy?: Record<string, unknown>;
    /**
     * Vercel project ID to associate sandbox operations with.
     */
    readonly projectId?: string;
    /**
     * Vercel team ID to associate sandbox operations with.
     */
    readonly teamId?: string;
    /**
     * Timeout in milliseconds (alias for `timeout`, kept for discoverability).
     */
    readonly timeoutMs?: number;
    /**
     * Sandbox template shorthand (e.g. `"node-22"`).
     * Maps to the `runtime` option.
     */
    readonly template?: string;
    /** Environment variables injected by this provider. Merged at launch time with env resolver and agent provider env. */
    readonly env?: Record<string, string>;
    /**
     * Maximum number of characters of streamed `exec` output retained per stream
     * (stdout and stderr) when an `onLine` callback is supplied (default: 64KiB).
     *
     * Output is delivered live to `onLine` regardless; this only bounds the tail
     * returned in `ExecResult`, preventing a long-running agent's output from
     * overflowing V8's max string length and crashing the run.
     */
    readonly maxOutputTailChars?: number;
}
/**
 * Create a Vercel isolated sandbox provider.
 *
 * The returned provider creates Vercel Firecracker microVM sandboxes via
 * the `@vercel/sandbox` SDK. Each sandbox is ephemeral — one sandbox per run.
 *
 * Requires `@vercel/sandbox` to be installed as a peer dependency.
 */
declare const vercel: (options?: VercelOptions) => IsolatedSandboxProvider;

export { type VercelOptions, vercel };
