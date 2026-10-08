import { N as NoSandboxProvider } from '../SandboxProvider-EkSMuBp8.js';

/**
 * No-sandbox provider — runs the agent directly on the host with no container isolation.
 *
 * Usage:
 *   import { noSandbox } from "sandcastle/sandboxes/no-sandbox";
 *   await interactive({ agent: claudeCode("claude-opus-4-8"), sandbox: noSandbox() });
 *
 * Accepted by `run()`, `interactive()`, and `createSandbox()`. Skips
 * container isolation entirely — the agent executes on the host. Does not
 * pass `--dangerously-skip-permissions` to the agent — the user manages
 * permissions themselves.
 */

interface NoSandboxOptions {
    /** Environment variables injected by this provider. Merged at launch time. */
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
 * Create a no-sandbox provider.
 *
 * The returned provider runs the agent directly on the host. All three
 * branch strategies are supported (head, merge-to-head, branch),
 * defaulting to head.
 */
declare const noSandbox: (options?: NoSandboxOptions) => NoSandboxProvider;

export { type NoSandboxOptions, noSandbox };
