import { posix } from "node:path";
import type { SeatbeltPolicy } from "../../seatbeltProfile.js";
import { buildSeatbeltPolicy } from "../../seatbeltProfile.js";

// The Seatbelt profile of a v1 seatbelt() sandbox: 0.x's deny-by-default
// profile (seatbeltProfile.ts), re-scoped from a worktree to the sandbox's
// own folder, with the rules a sandbox that holds nothing of the caller's
// needs on top. Appended last, so they win over 0.x's rules:
//
// - Unix sockets: only those in the sandbox's own folders, and the system's
//   DNS resolver. Not its keeper's (which runs commands unsandboxed), not
//   another sandbox's, not an agent's or a container engine's.
// - Hidden roots (the caller's home, its tmp): not even a path's metadata
//   shows, except the folders on the way to a root the sandbox may read.
// - `network: "none"`: no IP traffic at all, not even to the host's
//   loopback, which a Seatbelt sandbox shares.

/** What a seatbelt() sandbox may see. Every path is a real host path. */
export interface SandboxPolicyInput {
  /** Folders it may read, but not write: the host toolchain. */
  readonly readableRoots: readonly string[];
  /** Folders it may read and write: its own home and tmp. */
  readonly writableRoots: readonly string[];
  /** Paths it may look up (a `PATH` folder that's a symlink), and nothing below. */
  readonly lookupPaths: readonly string[];
  /** Folders whose contents stay unseen, metadata included, beyond the roots above. */
  readonly hiddenRoots: readonly string[];
  readonly network: "host" | "none";
  /** The host home, for 0.x's container-engine denies. */
  readonly hostHome: string;
}

/** The DNS resolver's socket: name lookups go through it. */
const DNS_SOCKET = "/private/var/run/mDNSResponder";

const isWithin = (path: string, root: string): boolean =>
  root === "/" || path === root || path.startsWith(`${root}/`);

/** `path`'s ancestors inside `root`, `root` included, `path` not. */
const ancestorsWithin = (path: string, root: string): string[] => {
  const dirs: string[] = [];
  for (
    let dir = posix.dirname(path);
    isWithin(dir, root) && dir !== posix.dirname(dir);
    dir = posix.dirname(dir)
  ) {
    dirs.push(dir);
  }
  return dirs;
};

/** Appends v1's rules, and their `-D` parameters, to 0.x's policy. */
const appendRules = (
  policy: SeatbeltPolicy,
  input: SandboxPolicyInput,
): SeatbeltPolicy => {
  const params: (readonly [string, string])[] = [...policy.params];
  const ref = (prefix: string, value: string): string => {
    const key = `${prefix}_${String(params.length)}`;
    params.push([key, value]);
    return `(param "${key}")`;
  };
  const roots = [...input.readableRoots, ...input.writableRoots];
  const lookups = [...input.lookupPaths, ...input.hiddenRoots];
  const onTheWay = input.hiddenRoots.flatMap((hidden) =>
    [...roots, ...input.lookupPaths]
      .filter((root) => isWithin(root, hidden))
      .flatMap((root) => ancestorsWithin(root, hidden)),
  );
  const literals = [...new Set([...lookups, ...onTheWay])].map(
    (path) => `  (literal ${ref("LOOKUP", path)})`,
  );
  const subpaths = [...new Set(roots)].map(
    (path) => `  (subpath ${ref("ROOT", path)})`,
  );
  const hidden = [...new Set(input.hiddenRoots)].map(
    (path) => `  (subpath ${ref("HIDDEN", path)})`,
  );
  const ownSockets = [...new Set(input.writableRoots)].map(
    (path) => `  (subpath ${ref("SOCKETS", path)})`,
  );
  const rules = [
    "; v1: the caller's folders show nothing, not even metadata, beyond the way to a root.",
    ...(hidden.length === 0
      ? []
      : [
          `(deny file-read-metadata\n${hidden.join("\n")})`,
          `(allow file-read-metadata\n${[...literals, ...subpaths].join("\n")})`,
        ]),
    "; v1: Unix sockets only in the sandbox's own folders, and the DNS resolver's.",
    '(deny network-outbound (subpath "/"))',
    `(allow network-outbound\n  (literal ${ref("DNS", DNS_SOCKET)})\n${ownSockets.join("\n")})`,
    ...(input.network === "none"
      ? [
          '; v1: network "none": no IP traffic, the host loopback included.',
          '(deny network-outbound (remote ip "*:*"))',
          '(deny network-inbound (local ip "*:*"))',
          '(deny network-bind (local ip "*:*"))',
        ]
      : []),
    "",
  ];
  return { profile: `${policy.profile}${rules.join("\n")}`, params };
};

/** The profile and `-D` parameters of one seatbelt() sandbox. */
export const sandboxPolicy = (input: SandboxPolicyInput): SeatbeltPolicy =>
  appendRules(
    buildSeatbeltPolicy({
      readableRoots: input.readableRoots,
      writableRoots: input.writableRoots,
      protectedPaths: [],
      hostHome: input.hostHome,
    }),
    input,
  );
