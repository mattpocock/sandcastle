/**
 * User-facing mount configuration for bind-mount sandbox providers.
 *
 * Each entry describes a host directory to mount into the sandbox container.
 */
/** A single bind-mount descriptor for docker()/podman() providers. */
interface MountConfig {
    /**
     * Path on the host. Supports:
     * - Absolute paths (`/data/cache`)
     * - Tilde-expanded paths (`~/data` → `<home>/data`)
     * - Relative paths (`data` or `./data`) — resolved from `process.cwd()`
     */
    readonly hostPath: string;
    /**
     * Path inside the sandbox container. Supports:
     * - Absolute paths (`/mnt/data`)
     * - Tilde-expanded paths (`~/.npm` → `/home/agent/.npm`) — expanded using the provider's sandbox home directory
     * - Relative paths (`data` or `./data`) — resolved from the worktree directory (`/home/agent/workspace`)
     */
    readonly sandboxPath: string;
    /** Mount as read-only. Defaults to `false`. */
    readonly readonly?: boolean;
}

export type { MountConfig as M };
