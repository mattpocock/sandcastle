/**
 * Entries of `git config --list`, and which of them the sandbox could have
 * written. See `hostGit.ts`.
 */

/** One entry of `git config --list --show-scope --show-origin`. */
export interface GitConfigEntry {
  readonly scope: string;
  /** Where git read it: `file:<path>`, `command line:` and so on. */
  readonly origin: string;
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

/** Whether `entry` comes from config the sandbox cannot write. */
export const isTrusted = (entry: GitConfigEntry): boolean =>
  TRUSTED_SCOPES.has(entry.scope);

/** The last trusted value of any of `keys`, a bare boolean as "true". */
export const lastTrustedValue = (
  entries: readonly GitConfigEntry[],
  keys: readonly string[],
): string | undefined => {
  const trusted = entries.filter((e) => isTrusted(e) && keys.includes(e.key));
  const last = trusted.at(-1);
  // A bare boolean key (`[core] fsmonitor`) means "true".
  return last === undefined ? undefined : (last.value ?? "true");
};

/** Splits `<key>\n<value>` (or a bare `<key>`) from `git config -z`. */
const keyAndValue = (entry: string): Pick<GitConfigEntry, "key" | "value"> => {
  const newline = entry.indexOf("\n");
  return newline === -1
    ? { key: entry, value: undefined }
    : { key: entry.slice(0, newline), value: entry.slice(newline + 1) };
};

/** Parses `git config --list --show-scope --show-origin -z`. */
export const parseConfigList = (output: string): GitConfigEntry[] => {
  const fields = output.split("\0");
  const entries: GitConfigEntry[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    entries.push({
      scope: fields[i] ?? "",
      origin: fields[i + 1] ?? "",
      ...keyAndValue(fields[i + 2] ?? ""),
    });
  }
  return entries;
};

/**
 * Parses `git config --file <file> --no-includes --list -z` as entries of
 * `scope`, read from `file`.
 */
export const parseFileConfigList = (
  output: string,
  file: string,
  scope: string,
): GitConfigEntry[] =>
  output
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => {
      const { key, value } = keyAndValue(entry);
      return { scope, origin: `file:${file}`, key, value };
    });
