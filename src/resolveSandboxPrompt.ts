import type { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import type { Display } from "./Display.js";
import type { PromptError, WorktreeError } from "./errors.js";
import {
  BUILT_IN_PROMPT_ARG_KEYS,
  substitutePromptArgs,
  validateNoArgsWithInlinePrompt,
  validateNoBuiltInArgOverride,
} from "./PromptArgumentSubstitution.js";
import type { PromptArgs } from "./PromptArgumentSubstitution.js";
import { resolvePrompt } from "./PromptResolver.js";
import { getCurrentBranch } from "./WorktreeManager.js";

/** @internal Inputs for resolving a `sandbox.run()` prompt. */
export interface ResolveSandboxPromptOptions {
  readonly prompt: string | undefined;
  readonly promptFile: string | undefined;
  readonly promptArgs: PromptArgs | undefined;
  /** The sandbox's branch, exposed to templates as `SOURCE_BRANCH`. */
  readonly branch: string;
  /** Host repo whose current branch is exposed to templates as `TARGET_BRANCH`. */
  readonly hostRepoDir: string;
}

/** @internal A prompt ready for the agent, plus whether it was given inline. */
export interface ResolvedSandboxPrompt {
  readonly text: string;
  /** Inline prompts skip argument substitution and prompt expansion. */
  readonly isInline: boolean;
}

/**
 * @internal Resolves a long-lived sandbox's prompt: reads the prompt or
 * prompt file, then substitutes `{{KEY}}` arguments (with the built-in
 * `SOURCE_BRANCH` / `TARGET_BRANCH`) for templates. Inline prompts must not
 * carry arguments and are returned verbatim.
 */
export const resolveSandboxPrompt = (
  options: ResolveSandboxPromptOptions,
): Effect.Effect<
  ResolvedSandboxPrompt,
  PromptError | WorktreeError,
  FileSystem.FileSystem | Display
> =>
  Effect.gen(function* () {
    const resolved = yield* resolvePrompt({
      prompt: options.prompt,
      promptFile: options.promptFile,
    });
    const isInline = resolved.source === "inline";
    const userArgs = options.promptArgs ?? {};
    const currentHostBranch = yield* getCurrentBranch(options.hostRepoDir);

    if (isInline) {
      yield* validateNoArgsWithInlinePrompt(userArgs);
      return { text: resolved.text, isInline };
    }
    yield* validateNoBuiltInArgOverride(userArgs);
    const text = yield* substitutePromptArgs(
      resolved.text,
      {
        SOURCE_BRANCH: options.branch,
        TARGET_BRANCH: currentHostBranch,
        ...userArgs,
      },
      new Set<string>(BUILT_IN_PROMPT_ARG_KEYS),
    );
    return { text, isInline };
  });
