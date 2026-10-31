import { Effect } from "effect";
import { Display } from "./Display.js";
import { PromptError } from "./errors.js";
import { SHELL_BLOCK_MARKER } from "./PromptPreprocessor.js";

const SHELL_BLOCK_PATTERN = /!`([^`]+)`/g;

/**
 * A map of named values used for prompt argument substitution.
 * Each key corresponds to a `{{KEY}}` placeholder in the prompt; the value
 * replaces it before the prompt is passed to the agent.
 */
export type PromptArgs = Record<string, string | number | boolean>;

/**
 * Prompt argument keys that Sandcastle injects automatically.
 * These cannot be overridden via `promptArgs`.
 */
export const BUILT_IN_PROMPT_ARG_KEYS = [
  "SOURCE_BRANCH",
  "TARGET_BRANCH",
] as const;

const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Validates that the user has not provided any built-in prompt argument keys.
 * Fails with a PromptError if any built-in key is found in `args`.
 */
/**
 * Fails if the user passed any `promptArgs` alongside an inline prompt.
 * Inline prompts are delivered to the agent verbatim, so `promptArgs` would
 * silently do nothing. An empty object is treated as absent.
 */
export const validateNoArgsWithInlinePrompt = (
  args: PromptArgs,
): Effect.Effect<void, PromptError> => {
  if (Object.keys(args).length === 0) {
    return Effect.void;
  }
  return Effect.fail(
    new PromptError({
      message:
        'promptArgs is only supported with promptFile. Inline prompts (prompt: "...") are passed to the agent as-is — interpolate values directly in JavaScript, or switch to promptFile to use {{KEY}} substitution.',
    }),
  );
};

export const validateNoBuiltInArgOverride = (
  args: PromptArgs,
): Effect.Effect<void, PromptError> => {
  for (const key of BUILT_IN_PROMPT_ARG_KEYS) {
    if (key in args) {
      return Effect.fail(
        new PromptError({
          message: `"${key}" is a built-in prompt argument and cannot be overridden via promptArgs`,
        }),
      );
    }
  }
  return Effect.void;
};

/**
 * Scans a prompt for `{{KEY}}` placeholders and returns the keys that are
 * missing from `providedArgs`, excluding built-in keys.
 */
export const findMissingPromptArgKeys = (
  prompt: string,
  providedArgs: PromptArgs,
): string[] => {
  const matches = [...prompt.matchAll(PLACEHOLDER_PATTERN)];
  const builtInSet = new Set<string>(BUILT_IN_PROMPT_ARG_KEYS);
  const seen = new Set<string>();
  const missing: string[] = [];

  for (const m of matches) {
    const key = m[1]!;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (builtInSet.has(key)) {
      continue;
    }
    if (key in providedArgs && providedArgs[key] != null) {
      continue;
    }
    missing.push(key);
  }

  return missing;
};

const HTML_COMMENT_PATTERN = /<!--[\s\S]*?(?:-->|$)/g;

const markShellBlocks = (prompt: string): string => {
  const commentRanges = [...prompt.matchAll(HTML_COMMENT_PATTERN)].map(
    (m) => [m.index, m.index + m[0].length] as const,
  );
  return prompt.replaceAll(SHELL_BLOCK_PATTERN, (block, command, offset) =>
    commentRanges.some(([start, end]) => offset >= start && offset < end)
      ? block
      : `!${SHELL_BLOCK_MARKER}\`${command}\``,
  );
};

export const substitutePromptArgs = (
  prompt: string,
  args: PromptArgs,
  silentKeys?: ReadonlySet<string>,
): Effect.Effect<string, PromptError, Display> => {
  // Mark shell blocks written in the raw template so the preprocessor can
  // distinguish them from `!`...`` patterns that arrive via arg substitution.
  // Shell blocks inside HTML comments stay unmarked, so commented-out examples
  // never run. Comment ranges come from the raw template, so an arg value
  // can't open or close one. Strip any markers already present in raw input
  // so they can't be forged.
  const markedPrompt = markShellBlocks(
    prompt.replaceAll(SHELL_BLOCK_MARKER, ""),
  );
  const sanitizedArgs: PromptArgs = Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      typeof value === "string"
        ? value.replaceAll(SHELL_BLOCK_MARKER, "")
        : value,
    ]),
  );
  const matches = [...markedPrompt.matchAll(PLACEHOLDER_PATTERN)];

  if (matches.length === 0 && Object.keys(sanitizedArgs).length === 0) {
    return Effect.succeed(markedPrompt);
  }

  return Effect.gen(function* () {
    const display = yield* Display;

    // Collect all keys referenced in the prompt
    const referencedKeys = new Set(matches.map((m) => m[1]!));

    // Check for missing keys (placeholder in prompt but no matching arg, or
    // a present-but-nullish value supplied by an untyped caller — e.g. an
    // orchestrator building args from JSON.parse).
    for (const key of referencedKeys) {
      if (!(key in sanitizedArgs)) {
        return yield* Effect.fail(
          new PromptError({
            message: `Prompt argument "{{${key}}}" has no matching value in promptArgs`,
          }),
        );
      }
      const value = sanitizedArgs[key];
      if (value == null) {
        return yield* Effect.fail(
          new PromptError({
            message: `Prompt argument "{{${key}}}" has value ${value === null ? "null" : "undefined"} in promptArgs`,
          }),
        );
      }
    }

    // Warn about unused keys (arg provided but no matching placeholder)
    // Skip keys listed in silentKeys (e.g. built-in args)
    for (const key of Object.keys(sanitizedArgs)) {
      if (!referencedKeys.has(key) && !silentKeys?.has(key)) {
        yield* display.status(
          `Prompt argument "${key}" was provided but not referenced in the prompt`,
          "warn",
        );
      }
    }

    // Replace all placeholders with their values
    const result = markedPrompt.replaceAll(PLACEHOLDER_PATTERN, (_match, key) =>
      sanitizedArgs[key as string]!.toString(),
    );

    return result;
  });
};
