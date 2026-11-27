/**
 * Overrides for config-defined hooks (git 2.54+). See `hostGit.ts`.
 */

import type { GitConfigEntry } from "./hostGitEntries.js";
import { isTrusted, lastTrustedValue } from "./hostGitEntries.js";

/** `<name>` and `<variable>` of a `hook.<name>.<variable>` key. */
const hookKeyParts = (
  key: string,
): { readonly name: string; readonly variable: string } | undefined => {
  const last = key.lastIndexOf(".");
  return key.startsWith("hook.") && last > "hook.".length
    ? { name: key.slice("hook.".length, last), variable: key.slice(last + 1) }
    : undefined;
};

/** Hook variables that make a named hook run something on an event. */
const RUNNING_HOOK_VARIABLES: ReadonlySet<string> = new Set([
  "command",
  "event",
  "parallel",
]);

/**
 * Overrides for one config-defined hook (git 2.54+) the repository touches.
 * A hook whose command only the repository defines is disabled. A hook the
 * user defined keeps the user's own command, events and `enabled`, so the
 * repository can't swap its command or add events to it. A name the
 * repository only sets `enabled` on (`hook.<event>.enabled` included) keeps
 * the user's value, if any.
 */
const overridesForHook = (
  entries: readonly GitConfigEntry[],
  name: string,
  repoVariables: ReadonlySet<string>,
): (readonly [string, string])[] => {
  const key = (variable: string): string => `hook.${name}.${variable}`;
  const enabled = lastTrustedValue(entries, [key("enabled")]);
  const command = lastTrustedValue(entries, [key("command")]);
  if (command !== undefined) {
    const events = entries
      .filter((e) => isTrusted(e) && e.key === key("event"))
      .map((e) => [key("event"), e.value ?? ""] as const);
    return [
      [key("command"), command],
      // An empty event clears the list; then the user's events, in order.
      [key("event"), ""],
      ...events,
      [key("enabled"), enabled ?? "true"],
    ];
  }
  if ([...repoVariables].some((v) => RUNNING_HOOK_VARIABLES.has(v))) {
    return [[key("enabled"), "false"]];
  }
  return enabled === undefined ? [] : [[key("enabled"), enabled]];
};

/**
 * Config-defined hooks (`hook.<name>.command` and `.event`, git 2.54+) run
 * whatever command they name, so every hook the repository defines or
 * changes is overridden by name (`overridesForHook`). The user's own hooks,
 * from system or global config, still run. An override per event
 * (`hook.<event>.enabled=false`) is not used: it would silence the user's
 * hooks too, git 2.54 does not have it, and from 2.55 a repository can turn
 * it back into a per-hook switch by defining a hook named after the event.
 */
export const hookOverrides = (
  entries: readonly GitConfigEntry[],
): (readonly [string, string])[] => {
  const repoVariables = new Map<string, Set<string>>();
  for (const entry of entries) {
    const parts = isTrusted(entry) ? undefined : hookKeyParts(entry.key);
    if (parts !== undefined) {
      const variables = repoVariables.get(parts.name) ?? new Set<string>();
      variables.add(parts.variable);
      repoVariables.set(parts.name, variables);
    }
  }
  return [...repoVariables].flatMap(([name, variables]) =>
    overridesForHook(entries, name, variables),
  );
};
