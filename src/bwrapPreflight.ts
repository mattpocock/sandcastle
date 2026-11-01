/**
 * The `bwrap()` construction check (src/sandboxes/bwrap.ts): is Bubblewrap
 * usable on this host, and if not, why and how to fix it. Runs once per
 * process. Used only by `bwrap()`.
 *
 * Synchronous on purpose: `bwrap()` is a synchronous constructor, and it must
 * throw before anything else (a worktree, a temp dir) exists.
 */

/* oxlint-disable node/no-sync -- bwrap() throws at construction, which is synchronous (allowlisted in scripts/lint-ratchet-config.ts). */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { NativeSandboxUnavailableError } from "./NativeSandboxUnavailableError.js";

/** Why Bubblewrap isn't usable, and the command that fixes it, when there is one. */
interface BwrapUnavailable {
  readonly message: string;
  readonly fixCommand?: string;
}

/** The install command per package manager, keyed by the os-release IDs that use it. */
const INSTALL_COMMANDS: readonly {
  readonly ids: readonly string[];
  readonly command: string;
}[] = [
  { ids: ["debian", "ubuntu"], command: "sudo apt install bubblewrap" },
  {
    ids: ["fedora", "rhel", "centos", "rocky", "almalinux", "amzn"],
    command: "sudo dnf install bubblewrap",
  },
  {
    ids: ["arch", "manjaro", "endeavouros"],
    command: "sudo pacman -S bubblewrap",
  },
  { ids: ["alpine"], command: "sudo apk add bubblewrap" },
  {
    ids: ["opensuse", "suse", "sles", "opensuse-leap", "opensuse-tumbleweed"],
    command: "sudo zypper install bubblewrap",
  },
];

/** The distro's IDs from os-release: `ID` first, then each of `ID_LIKE`. */
const distroIds = (osRelease: string): string[] => {
  const field = (name: string): string => {
    const match = new RegExp(`^${name}=(.*)$`, "mu").exec(osRelease);
    return (match?.[1] ?? "").replaceAll(/["']/gu, "").trim();
  };
  return [field("ID"), ...field("ID_LIKE").split(/\s+/u)]
    .map((id) => id.toLowerCase())
    .filter((id) => id !== "");
};

const readOsRelease = (): string => {
  for (const file of ["/etc/os-release", "/usr/lib/os-release"]) {
    try {
      return readFileSync(file, "utf8");
    } catch {
      // Try the next location.
    }
  }
  return "";
};

/** The install command for this distro, or undefined when it's not one we know. */
const installCommand = (osRelease: string): string | undefined => {
  for (const id of distroIds(osRelease)) {
    const known = INSTALL_COMMANDS.find((entry) => entry.ids.includes(id));
    if (known !== undefined) {
      return known.command;
    }
  }
  return undefined;
};

const notInstalled = (): BwrapUnavailable => {
  const command = installCommand(readOsRelease());
  if (command !== undefined) {
    return {
      message: `bwrap() needs Bubblewrap, and \`bwrap\` isn't on PATH. Install it with: ${command}`,
      fixCommand: command,
    };
  }
  const list = INSTALL_COMMANDS.map((entry) => `  ${entry.command}`).join("\n");
  return {
    message: `bwrap() needs Bubblewrap, and \`bwrap\` isn't on PATH. Install the \`bubblewrap\` package with your distro's package manager:\n${list}`,
  };
};

/** The probe failed because the kernel won't give an unprivileged user a user namespace. */
const userNamespacesBlocked = (stderr: string): BwrapUnavailable => {
  const profile = [
    "abi <abi/4.0>,",
    "include <tunables/global>",
    "profile bwrap %s flags=(unconfined) {",
    "  userns,",
    "}",
  ].join(String.raw`\n`);
  const fixCommand =
    `printf '${profile}\\n' "$(command -v bwrap)" | sudo tee /etc/apparmor.d/bwrap >/dev/null` +
    " && sudo apparmor_parser -r /etc/apparmor.d/bwrap";
  return {
    message:
      "bwrap() can't start a sandbox: this kernel blocks unprivileged user namespaces " +
      "(Ubuntu 24.04+ restricts them with AppArmor). " +
      `Bubblewrap said: ${stderr.trim()}\n` +
      `Fix it by giving bwrap an AppArmor profile that allows user namespaces:\n  ${fixCommand}\n` +
      "Or, more bluntly, allow them for every program: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0",
    fixCommand,
  };
};

/** Runs the trivial probe and explains its failure, or returns undefined when bwrap works. */
const probe = (): BwrapUnavailable | undefined => {
  const result = spawnSync("bwrap", ["--ro-bind", "/", "/", "true"], {
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
    timeout: 30_000,
  });
  const spawnError: NodeJS.ErrnoException | undefined = result.error;
  if (spawnError?.code === "ENOENT") {
    return notInstalled();
  }
  if (result.status === 0) {
    return undefined;
  }
  const stderr = result.stderr ?? "";
  if (/namespace|uid map/iu.test(stderr)) {
    return userNamespacesBlocked(stderr);
  }
  const reason =
    stderr.trim() === ""
      ? (result.error?.message ?? `exit code ${String(result.status)}`)
      : stderr.trim();
  return {
    message: `bwrap() can't start a sandbox: \`bwrap --ro-bind / / true\` failed: ${reason}`,
  };
};

const check = (): BwrapUnavailable | undefined =>
  process.platform === "linux"
    ? probe()
    : { message: "bwrap() needs Linux or WSL2; on macOS use seatbelt()" };

let outcome: { readonly unavailable: BwrapUnavailable | undefined } | undefined;

/**
 * Throws `NativeSandboxUnavailableError` when Bubblewrap isn't usable on this
 * host. Checks on the first call only; later calls give the same answer.
 */
export const assertBwrapUsable = (): void => {
  outcome ??= { unavailable: check() };
  if (outcome.unavailable !== undefined) {
    throw new NativeSandboxUnavailableError(outcome.unavailable);
  }
};
