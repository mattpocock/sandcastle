import { spawnSync } from "node:child_process";
import type { BindMountSandboxProvider } from "@ai-hero/sandcastle";
import { bwrap } from "@ai-hero/sandcastle/sandboxes/bwrap";

/**
 * The native sandbox providers the containment suite runs against. Each one
 * says which OS it runs on, how to tell whether its tool works on this host,
 * and how to construct it. Another native provider joins the suite by adding
 * an entry here; the probes stay in tests/containment.test.ts.
 */
export interface NativeProviderCase {
  /** As it reads in test names and errors, e.g. `bwrap()`. */
  readonly name: string;
  readonly platform: NodeJS.Platform;
  /** The command that installs or enables the tool, shown when CI lacks it. */
  readonly setupHint: string;
  /** Whether the provider's tool works on this host. */
  readonly isUsable: () => boolean;
  /** Constructs the provider with its defaults. */
  readonly make: () => BindMountSandboxProvider;
}

export const NATIVE_PROVIDERS: readonly NativeProviderCase[] = [
  {
    name: "bwrap()",
    platform: "linux",
    setupHint:
      "sudo apt-get install -y bubblewrap && sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0",
    isUsable: () =>
      spawnSync("bwrap", ["--ro-bind", "/", "/", "true"]).status === 0,
    make: () => bwrap(),
  },
];

const ciIsSet = (): boolean => {
  const ci = process.env["CI"];
  return ci !== undefined && ci !== "" && ci !== "false";
};

/**
 * Whether a suite skips this provider here: on another OS, or where its tool
 * is missing on a contributor's machine. With `CI` set a missing tool doesn't
 * skip, so {@link assertUsable} fails the suite instead of CI silently
 * skipping it.
 */
export const skipsHere = (provider: NativeProviderCase): boolean =>
  process.platform !== provider.platform ||
  (!ciIsSet() && !provider.isUsable());

/** Throws, naming the setup command, when the provider's tool doesn't work. */
export const assertUsable = (provider: NativeProviderCase): void => {
  if (!provider.isUsable()) {
    throw new Error(
      `${provider.name} isn't usable on this ${provider.platform} host, and CI is set, ` +
        `so the suite can't skip it. Set it up with: ${provider.setupHint}`,
    );
  }
};
