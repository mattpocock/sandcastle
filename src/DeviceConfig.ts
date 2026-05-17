/**
 * User-facing device configuration for bind-mount sandbox providers.
 *
 * Each entry describes a host device to attach to the sandbox container.
 */

/** A single device descriptor for docker()/podman() providers. */
export interface DeviceConfig {
  /**
   * Path on the host (e.g. `/dev/kvm`, `/dev/dri`).
   *
   * Unlike mounts, device paths are NOT validated at construction time —
   * the host path may point to a device that only exists at container start.
   */
  readonly hostPath: string;
  /**
   * Path inside the sandbox container.
   *
   * When omitted, the device is mounted at the same path as `hostPath`.
   */
  readonly sandboxPath?: string;
  /**
   * Device permissions inside the container.
   *
   * One or more of:
   * - `"r"` — read
   * - `"w"` — write
   * - `"m"` — mknod (create device nodes)
   *
   * When omitted, all permissions (`"rwm"`) are granted.
   */
  readonly permissions?: string;
}
