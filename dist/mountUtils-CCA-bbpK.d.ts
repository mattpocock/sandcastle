/**
 * Shared mount utilities for Docker and Podman sandbox providers.
 *
 * Handles host/sandbox path resolution, tilde expansion, user mount
 * validation, image naming, and Windows path normalization.
 */

/**
 * SELinux volume label suffix applied to bind mounts.
 *
 * - `"z"` — shared label. No-op on non-SELinux systems.
 * - `"Z"` — private label; only this container can access the mount.
 * - `false` — disable labeling entirely.
 */
type SelinuxLabel = "z" | "Z" | false;
/**
 * Derive the default image name from the repo directory.
 * Returns `sandcastle:<dir-name>` where dir-name is the last path segment,
 * lowercased and sanitized for image tag rules.
 *
 * Handles both POSIX (`/`) and Windows (`\`) path separators.
 */
declare const defaultImageName: (repoDir: string) => string;

export { type SelinuxLabel as S, defaultImageName as d };
