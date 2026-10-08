import { S as SandboxProvider } from '../SandboxProvider-EkSMuBp8.js';
import { M as MountConfig } from '../MountConfig-CmXclHA5.js';
import { S as SelinuxLabel } from '../mountUtils-CCA-bbpK.js';
export { d as defaultImageName } from '../mountUtils-CCA-bbpK.js';

/**
 * Docker sandbox provider — wraps DockerLifecycle into a SandboxProvider.
 *
 * Usage:
 *   import { docker } from "sandcastle/sandboxes/docker";
 *   await run({ agent: claudeCode("claude-opus-4-8"), sandbox: docker() });
 */

interface DockerOptions {
    /** Docker image name (default: derived from repo directory name). */
    readonly imageName?: string;
    /**
     * The UID of the `agent` user inside the container image (default: host UID via `process.getuid()`, or 1000).
     *
     * Must match the UID baked into the image at build time. Used as the `--user` flag value
     * and checked against the image's configured UID in the pre-flight diagnostic.
     */
    readonly containerUid?: number;
    /**
     * The GID of the `agent` user inside the container image (default: host GID via `process.getgid()`, or 1000).
     *
     * Must match the GID baked into the image at build time. Used as the `--user` flag value.
     */
    readonly containerGid?: number;
    /**
     * SELinux volume label suffix applied to bind mounts.
     *
     * - `"z"` — shared label (default). No-op on non-SELinux systems.
     * - `"Z"` — private label; only this container can access the mount.
     * - `false` — disable labeling entirely.
     */
    readonly selinuxLabel?: SelinuxLabel;
    /**
     * Additional host directories to bind-mount into the sandbox.
     *
     * Each entry specifies a `hostPath` (tilde-expanded) and `sandboxPath`.
     * If `hostPath` does not exist, sandbox creation fails with a clear error.
     */
    readonly mounts?: readonly MountConfig[];
    /** Environment variables injected by this provider. Merged at launch time with env resolver and agent provider env. */
    readonly env?: Record<string, string>;
    /**
     * Docker network(s) to attach the container to.
     *
     * - `"my-network"` → `--network my-network`
     * - `["net1", "net2"]` → `--network net1 --network net2`
     *
     * When omitted, Docker's default bridge network is used.
     */
    readonly network?: string | readonly string[];
    /**
     * Supplementary groups to add the container user to, via `--group-add`.
     *
     * Accepts group names or numeric GIDs:
     *
     * - `["docker"]` → `--group-add docker`
     * - `[999]` → `--group-add 999`
     * - `["docker", 999]` → `--group-add docker --group-add 999`
     *
     * Useful for granting access to a bind-mounted Docker socket (Docker-outside-of-Docker).
     * When omitted, no `--group-add` flags are added.
     */
    readonly groups?: readonly (string | number)[];
    /**
     * Host devices to expose to the container, via `--device`.
     *
     * Each entry is a full device spec in `host[:container[:permissions]]` form:
     *
     * - `["/dev/kvm"]` → `--device /dev/kvm`
     * - `["/dev/sda:/dev/xvda:rwm"]` → `--device /dev/sda:/dev/xvda:rwm`
     * - `["/dev/kvm", "/dev/fuse"]` → `--device /dev/kvm --device /dev/fuse`
     *
     * When omitted, no `--device` flags are added.
     */
    readonly devices?: readonly string[];
    /**
     * Maximum number of characters of streamed `exec` output retained per stream
     * (stdout and stderr) when an `onLine` callback is supplied (default: 64KiB).
     *
     * Output is delivered live to `onLine` regardless; this only bounds the tail
     * returned in `ExecResult`, preventing a long-running agent's output from
     * overflowing V8's max string length and crashing the run.
     */
    readonly maxOutputTailChars?: number;
    /**
     * Limit the CPU resources available to the container, via `--cpus`.
     *
     * Maps directly to `docker run --cpus`. Accepts fractional values:
     *
     * - `2` → `--cpus 2` (at most 2 CPUs)
     * - `1.5` → `--cpus 1.5` (at most 1.5 CPUs)
     *
     * When omitted, no `--cpus` flag is added and the container is unconstrained.
     */
    readonly cpus?: number;
}
/**
 * Create a Docker sandbox provider.
 *
 * The returned provider creates Docker containers with bind-mounts
 * for the worktree and git directories.
 */
declare const docker: (options?: DockerOptions) => SandboxProvider;

export { type DockerOptions, docker };
