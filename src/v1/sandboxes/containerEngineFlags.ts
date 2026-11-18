import type { LinuxCapability } from "../../LinuxCapability.js";

// The `<engine> run` settings Docker and Podman share, as their flags. Each
// provider documents them in its own terms (DockerCreateOptions,
// PodmanCreateOptions) and adds its own on top.

/** The `run` settings both engines take the same way. Never a mount, env or entrypoint. */
export interface SharedCreateOptions {
  readonly network?: string | readonly string[];
  readonly cpus?: number;
  readonly memory?: string;
  readonly pidsLimit?: number;
  readonly user?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly capAdd?: readonly LinuxCapability[];
  readonly capDrop?: readonly LinuxCapability[];
}

/** `--flag value` once per value. */
export const eachFlag = (
  flag: string,
  values: readonly string[] | undefined,
): string[] => (values ?? []).flatMap((value) => [flag, value]);

/** `--flag value`, or nothing when the value is unset. */
export const oneFlag = (
  flag: string,
  value: string | number | undefined,
): string[] => (value === undefined ? [] : [flag, String(value)]);

/** The shared `create` settings as `run` flags. */
export const sharedRunFlags = (create: SharedCreateOptions = {}): string[] => {
  const { network } = create;
  return [
    ...eachFlag("--network", typeof network === "string" ? [network] : network),
    ...oneFlag("--cpus", create.cpus),
    ...oneFlag("--memory", create.memory),
    ...oneFlag("--memory-swap", create.memory),
    ...oneFlag("--pids-limit", create.pidsLimit),
    ...oneFlag("--user", create.user),
    ...eachFlag(
      "--label",
      Object.entries(create.labels ?? {}).map(
        ([key, value]) => `${key}=${value}`,
      ),
    ),
    ...eachFlag("--cap-add", create.capAdd),
    ...eachFlag("--cap-drop", create.capDrop),
  ];
};
