/**
 * Builds the Seatbelt (SBPL) profile a `seatbelt()` sandbox runs under, and
 * the `-D` parameters that carry its paths. Pure and provider-agnostic: it
 * takes paths and returns text. No path is ever written into the profile
 * text: every one is a `(param "…")` passed to `sandbox-exec` with `-D`, so
 * there is nothing to escape.
 *
 * Hand-rolled, with no dependency on the projects its rule shapes come from:
 *
 * - OpenAI Codex (Apache-2.0, https://github.com/openai/codex,
 *   codex-rs/sandboxing/src/seatbelt_base_policy.sbpl,
 *   seatbelt_read_only_platform_defaults.sbpl, seatbelt_network_policy.sbpl
 *   and seatbelt.rs): the deny-default base, the sysctl list (no
 *   `kern.proc.all`), the platform defaults, the `-D` parameter pattern, the
 *   `file-write-unlink` denies on protected ancestors, and the fcntl and XPC
 *   denies.
 * - Google Gemini CLI (Apache-2.0, https://github.com/google-gemini/gemini-cli,
 *   packages/cli/src/utils/sandbox-macos-*.sb): the Docker, Colima and
 *   OrbStack socket denies.
 * - Microsoft MXC (MIT, https://github.com/microsoft/mxc,
 *   docs/backends/seatbelt/seatbelt-backend.md): the read-only system
 *   baseline and the developer dir.
 */

import { posix } from "node:path";

/** What a `seatbelt()` sandbox may read and write. Every path is a real host path. */
export interface SeatbeltPolicyInput {
  /** Dirs the sandbox may read (and map executable code from), but not write. */
  readonly readableRoots: readonly string[];
  /** Dirs the sandbox may read and write: the worktree, writable git dirs, private dirs. */
  readonly writableRoots: readonly string[];
  /**
   * Files and dirs that stay read-only even inside a writable root (the
   * #1261 git control files). Their ancestors inside a writable root can't
   * be renamed or removed either, so they can't be moved aside.
   */
  readonly protectedPaths: readonly string[];
  /** The host home dir, for the container-engine socket denies. */
  readonly hostHome: string;
}

/** A Seatbelt profile and the `-D` parameters its `(param …)`s name. */
export interface SeatbeltPolicy {
  readonly profile: string;
  readonly params: readonly (readonly [key: string, value: string])[];
}

/** The system dirs every sandbox may read: MXC's baseline, Homebrew and `/opt`. */
export const SYSTEM_READ_ROOTS: readonly string[] = [
  "/bin",
  "/sbin",
  "/usr",
  "/System",
  "/Library",
  "/opt",
  "/private/etc",
  "/private/var/db",
  // `/bin/sh` picks the shell it runs from here.
  "/private/var/select",
];

/** Container-engine sockets and state under the host home, never reachable. */
const CONTAINER_ENGINE_HOME_DIRS = [
  ".docker",
  ".colima",
  ".orbstack",
  ".lima",
  ".rd",
];

const CONTAINER_ENGINE_SOCKETS = [
  "/private/var/run/docker.sock",
  "/private/var/run/com.docker.vmnetd.sock",
];

/** Deny-default, processes, sysctls and system services (after Codex's base policy). */
const BASE = String.raw`(version 1)
(deny default)

(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))

(allow sysctl-read
  (sysctl-name "hw.activecpu")
  (sysctl-name "hw.busfrequency_compat")
  (sysctl-name "hw.byteorder")
  (sysctl-name "hw.cacheconfig")
  (sysctl-name "hw.cachelinesize_compat")
  (sysctl-name "hw.cpufamily")
  (sysctl-name "hw.cpufrequency_compat")
  (sysctl-name "hw.cputype")
  (sysctl-name "hw.l1dcachesize_compat")
  (sysctl-name "hw.l1icachesize_compat")
  (sysctl-name "hw.l2cachesize_compat")
  (sysctl-name "hw.l3cachesize_compat")
  (sysctl-name "hw.logicalcpu_max")
  (sysctl-name "hw.machine")
  (sysctl-name "hw.model")
  (sysctl-name "hw.memsize")
  (sysctl-name "hw.ncpu")
  (sysctl-name "hw.nperflevels")
  (sysctl-name-prefix "hw.optional.arm.")
  (sysctl-name-prefix "hw.optional.armv8_")
  (sysctl-name "hw.packages")
  (sysctl-name "hw.pagesize_compat")
  (sysctl-name "hw.pagesize")
  (sysctl-name "hw.physicalcpu")
  (sysctl-name "hw.physicalcpu_max")
  (sysctl-name "hw.logicalcpu")
  (sysctl-name "hw.cpufrequency")
  (sysctl-name "hw.tbfrequency_compat")
  (sysctl-name "hw.vectorunit")
  (sysctl-name "machdep.cpu.brand_string")
  (sysctl-name "kern.argmax")
  (sysctl-name "kern.hostname")
  (sysctl-name "kern.maxfilesperproc")
  (sysctl-name "kern.maxproc")
  (sysctl-name "kern.osproductversion")
  (sysctl-name "kern.osrelease")
  (sysctl-name "kern.ostype")
  (sysctl-name "kern.osvariant_status")
  (sysctl-name "kern.osversion")
  (sysctl-name "kern.secure_kernel")
  (sysctl-name "kern.sysv.semmns")
  (sysctl-name "kern.usrstack64")
  (sysctl-name "kern.version")
  (sysctl-name "sysctl.proc_cputype")
  (sysctl-name "vm.loadavg")
  (sysctl-name-prefix "hw.perflevel")
  (sysctl-name-prefix "kern.proc.pgrp.")
  (sysctl-name-prefix "kern.proc.pid.")
  (sysctl-name-prefix "net.routetable."))
(allow sysctl-write (sysctl-name "kern.grade_cputype"))

(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))
(allow ipc-posix-sem)
(allow ipc-posix-shm-read* (ipc-posix-name "apple.shm.notification_center"))
(allow system-mac-syscall (mac-policy-name "vnguard"))
(allow system-mac-syscall
  (require-all (mac-policy-name "Sandbox") (mac-syscall-number 67)))
(allow system-fsctl (fsctl-command FSIOC_CAS_BSDFLAGS))

(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.system.DirectoryService.libinfo_v1")
  (global-name "com.apple.system.logger")
  (global-name "com.apple.system.notification_center")
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.logd")
  (global-name "com.apple.diagnosticd")
  (global-name "com.apple.secinitd")
  (global-name "com.apple.trustd")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.networkd")
  (global-name "com.apple.ocspd")
  (global-name "com.apple.SystemConfiguration.DNSConfiguration")
  (global-name "com.apple.SystemConfiguration.configd")
  (global-name "com.apple.PowerManagement.control"))

; Path lookups: any path's metadata, never its contents.
(allow file-read-metadata)
(allow file-read* (literal "/"))

; Devices and terminals.
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/tty")
  (literal "/dev/ptmx")
  (literal "/dev/dtracehelper")
  (regex #"^/dev/ttys[0-9]+$"))
(allow file-read* (literal "/dev/random") (literal "/dev/urandom"))
(allow file-read-data file-write-data (subpath "/dev/fd"))

; Open egress (and host localhost, which the docs say).
(allow network*)
(allow system-socket
  (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))`;

const isWithin = (path: string, root: string): boolean =>
  root === "/" || path === root || path.startsWith(`${root}/`);

/** Hands out `-D` parameter names, and records their values. */
class Params {
  readonly entries: [string, string][] = [];

  /** A `(param "…")` reference for `value`, under a fresh `prefix_n` key. */
  ref(prefix: string, value: string): string {
    const key = `${prefix}_${String(this.entries.length)}`;
    this.entries.push([key, value]);
    return `(param "${key}")`;
  }
}

/**
 * The dirs that must not be renamed or removed: each writable root, and each
 * ancestor of a protected path up to the writable root that holds it.
 */
const anchoredDirs = (input: SeatbeltPolicyInput): string[] => {
  const dirs = new Set(input.writableRoots);
  for (const path of input.protectedPaths) {
    const roots = input.writableRoots.filter((root) => isWithin(path, root));
    let dir = posix.dirname(path);
    while (roots.some((root) => isWithin(dir, root))) {
      dirs.add(dir);
      const parent = posix.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  return [...dirs];
};

/** One `(allow …)` over `paths` as subpaths, or nothing for no paths. */
const allowSubpaths = (
  operations: string,
  refs: readonly string[],
): string[] =>
  refs.length === 0
    ? []
    : [
        `(allow ${operations}\n${refs.map((r) => `  (subpath ${r})`).join("\n")})`,
      ];

/** Builds the profile and parameters for one `seatbelt()` sandbox. */
export const buildSeatbeltPolicy = (
  input: SeatbeltPolicyInput,
): SeatbeltPolicy => {
  const params = new Params();
  const readable = [...new Set(input.readableRoots)].map((p) =>
    params.ref("READ", p),
  );
  const writable = [...new Set(input.writableRoots)].map((p) =>
    params.ref("WRITE", p),
  );
  const engineSockets = CONTAINER_ENGINE_SOCKETS.map((socket) =>
    params.ref("ENGINE", socket),
  );
  const engineDirs = CONTAINER_ENGINE_HOME_DIRS.map((name) =>
    params.ref("ENGINE", posix.join(input.hostHome, name)),
  );
  const protectedRefs = [...new Set(input.protectedPaths)].map((p) =>
    params.ref("PROTECTED", p),
  );
  const anchors = anchoredDirs(input).map((p) => params.ref("ANCHOR", p));

  const engineFilters = [
    ...engineSockets.map((r) => `  (literal ${r})`),
    ...engineDirs.map((r) => `  (subpath ${r})`),
  ].join("\n");

  const profile = [
    BASE,
    "; Read-only: the system toolchain and the paths given to read.",
    ...allowSubpaths("file-read* file-map-executable", readable),
    "; Read/write: the worktree, the writable git dirs, the private home and temp dir.",
    ...allowSubpaths("file-read* file-write* file-map-executable", writable),
    "; No way into a container engine, which would be a way out.",
    `(deny file-read* file-write* network-outbound process-exec\n${engineFilters})`,
    '(deny mach-lookup (xpc-service-name-prefix ""))',
    "; Last, so nothing above reopens them: the read-only git control files,",
    "; and the dirs that hold them, which can't be moved aside.",
    ...protectedRefs.map((r) => `(deny file-write* (subpath ${r}))`),
    ...anchors.map(
      (r) =>
        `(deny file-write-unlink (require-all (vnode-type DIRECTORY) (literal ${r})))`,
    ),
    "; Writes through read-only descriptors (F_MAKECOMPRESSED, F_TRANSFEREXTENTS).",
    "(deny system-fcntl (fcntl-command 80 110))",
    "",
  ].join("\n");

  return { profile, params: params.entries };
};
