/**
 * Which repository config a host-side git call must not obey, and the
 * `GIT_CONFIG_*` overrides that stop it. See `hostGit.ts`.
 */

import { devNull } from "node:os";

/** An environment for a child process. */
export type Env = Readonly<Record<string, string | undefined>>;

/** One entry of `git config --list --show-scope`. */
export interface GitConfigEntry {
  readonly scope: string;
  readonly key: string;
  /** `undefined` for a bare boolean key (`[core] bare`). */
  readonly value: string | undefined;
}

/** Config scopes the sandbox cannot write. Everything else is repository-owned. */
const TRUSTED_SCOPES: ReadonlySet<string> = new Set([
  "system",
  "global",
  "command",
]);

/**
 * Keys set on every call: each group shares one git variable (aliases), so
 * every key in it gets the same value — the last trusted one, else the
 * neutral value, which runs nothing.
 */
const PINNED_GROUPS: readonly (readonly [readonly string[], string])[] = [
  [["core.fsmonitor"], "false"],
  [["core.hookspath"], devNull],
  [["core.pager"], "cat"],
  [["core.editor"], "true"],
  [["sequence.editor"], "true"],
  [["diff.external"], ""],
  [["gpg.program", "gpg.openpgp.program"], "gpg"],
  [["gpg.x509.program"], "gpgsm"],
  [["gpg.ssh.program"], "ssh-keygen"],
  [["protocol.ext.allow"], "never"],
  [["submodule.recurse"], "false"],
  [["fetch.recursesubmodules"], "false"],
];

/**
 * Keys overridden only when the repository sets them (a value that runs
 * nothing is not always expressible, e.g. `core.sshCommand`).
 */
const REPO_SET_KEYS: ReadonlyMap<string, string> = new Map([
  ["core.sshcommand", "ssh"],
  ["core.askpass", ""],
  ["core.alternaterefscommand", ""],
  ["gpg.ssh.defaultkeycommand", ""],
]);

/** Per-name keys (`filter.<name>.clean`, …), matched on section and variable. */
const NAMED_KEYS: ReadonlyMap<string, string> = new Map([
  ["filter.clean", ""],
  ["filter.smudge", ""],
  ["filter.process", ""],
  ["filter.required", "false"],
  ["diff.command", ""],
  ["diff.textconv", ""],
  ["merge.driver", ""],
  ["remote.uploadpack", "git-upload-pack"],
  ["remote.receivepack", "git-receive-pack"],
]);

const isTrusted = (entry: GitConfigEntry): boolean =>
  TRUSTED_SCOPES.has(entry.scope);

/** `section.variable` for a three-part key, `undefined` otherwise. */
const namedKeyClass = (key: string): string | undefined => {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first === -1 || first === last) {
    return undefined;
  }
  return `${key.slice(0, first)}.${key.slice(last + 1)}`;
};

const isCredentialHelperKey = (key: string): boolean =>
  key.startsWith("credential.") && key.endsWith(".helper");

const lastTrustedValue = (
  entries: readonly GitConfigEntry[],
  keys: readonly string[],
): string | undefined => {
  const trusted = entries.filter((e) => isTrusted(e) && keys.includes(e.key));
  const last = trusted.at(-1);
  // A bare boolean key (`[core] fsmonitor`) means "true".
  return last === undefined ? undefined : (last.value ?? "true");
};

const pinnedOverrides = (
  entries: readonly GitConfigEntry[],
): (readonly [string, string])[] =>
  PINNED_GROUPS.flatMap(([keys, neutral]) => {
    const value = lastTrustedValue(entries, keys) ?? neutral;
    return keys.map((key) => [key, value] as const);
  });

const neutralForRepoSetKey = (key: string): string | undefined => {
  const exact = REPO_SET_KEYS.get(key);
  if (exact !== undefined) {
    return exact;
  }
  const named = namedKeyClass(key);
  return named === undefined ? undefined : NAMED_KEYS.get(named);
};

const repoSetOverrides = (
  entries: readonly GitConfigEntry[],
): (readonly [string, string])[] => {
  const repoKeys = new Set(
    entries.filter((e) => !isTrusted(e)).map((e) => e.key),
  );
  const overrides: (readonly [string, string])[] = [];
  for (const key of repoKeys) {
    const neutral = neutralForRepoSetKey(key);
    if (neutral !== undefined) {
      overrides.push([key, lastTrustedValue(entries, [key]) ?? neutral]);
    }
  }
  if (repoKeys.has("core.gitproxy")) {
    // `core.gitProxy` is a first-match list, so it can't be overridden by
    // appending; refuse the git:// transport it applies to instead.
    overrides.push(["protocol.git.allow", "never"]);
  }
  return overrides;
};

/**
 * Credential helpers form one list across `credential.helper` and every
 * matching `credential.<url>.helper`, and an empty value clears it. So clear
 * through every helper key first, then add the trusted helpers back in their
 * original order.
 */
const credentialOverrides = (
  entries: readonly GitConfigEntry[],
): (readonly [string, string])[] => {
  const keys = new Set([
    "credential.helper",
    ...entries.map((e) => e.key).filter((key) => isCredentialHelperKey(key)),
  ]);
  return [
    ...[...keys].map((key) => [key, ""] as const),
    ...entries
      .filter((e) => isTrusted(e) && keys.has(e.key))
      .map((e) => [e.key, e.value ?? ""] as const),
  ];
};

/**
 * The `GIT_CONFIG_*` overrides that neutralise every program-running config
 * key the repository could have set, given the effective config as listed by
 * `git config --list --show-scope`. Exported for tests.
 */
export const hardeningOverrides = (
  entries: readonly GitConfigEntry[],
): (readonly [string, string])[] => [
  ...pinnedOverrides(entries),
  ...repoSetOverrides(entries),
  ...credentialOverrides(entries),
];

/** Parses `git config --list --show-scope -z`. */
export const parseConfigList = (output: string): GitConfigEntry[] => {
  const fields = output.split("\0");
  const entries: GitConfigEntry[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope = fields[i] ?? "";
    const entry = fields[i + 1] ?? "";
    const newline = entry.indexOf("\n");
    entries.push(
      newline === -1
        ? { scope, key: entry, value: undefined }
        : {
            scope,
            key: entry.slice(0, newline),
            value: entry.slice(newline + 1),
          },
    );
  }
  return entries;
};

/** Appends `overrides` after any `GIT_CONFIG_*` entries already in `env`. */
export const withConfigOverrides = (
  env: Env,
  overrides: readonly (readonly [string, string])[],
): Env => {
  const existing = Number(env["GIT_CONFIG_COUNT"] ?? "0");
  const start = Number.isInteger(existing) && existing > 0 ? existing : 0;
  const result: Record<string, string | undefined> = {
    ...env,
    GIT_CONFIG_COUNT: String(start + overrides.length),
  };
  for (const [offset, [key, value]] of overrides.entries()) {
    result[`GIT_CONFIG_KEY_${start + offset}`] = key;
    result[`GIT_CONFIG_VALUE_${start + offset}`] = value;
  }
  return result;
};
