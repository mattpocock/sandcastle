import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { PromptError } from "./errors.js";

export interface ResolvePromptOptions {
  readonly prompt?: string;
  readonly promptFile?: string;
}

/**
 * The resolved prompt text plus the source it came from.
 *
 * - `inline`: came from `prompt: "..."` — delivered to the agent verbatim.
 *   No prompt argument substitution, no prompt expansion, no built-in args.
 * - `template`: came from `promptFile` — eligible for `{{KEY}}` substitution
 *   and `` !`command` `` expansion.
 */
export interface ResolvedPrompt {
  readonly text: string;
  readonly source: "inline" | "template";
}

export const resolvePrompt = (
  options: ResolvePromptOptions,
): Effect.Effect<ResolvedPrompt, PromptError, FileSystem.FileSystem> => {
  const { prompt, promptFile } = options;

  if (prompt !== undefined && promptFile !== undefined) {
    return Effect.fail(
      new PromptError({
        message: "Cannot provide both prompt and promptFile",
      }),
    );
  }

  if (prompt !== undefined) {
    return Effect.succeed({ text: prompt, source: "inline" });
  }

  if (promptFile === undefined) {
    return Effect.fail(
      new PromptError({
        message:
          "Must provide either prompt or promptFile. Pass prompt: '...' or promptFile: './.sandcastle/prompt.md' to run().",
      }),
    );
  }

  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(promptFile).pipe(
      Effect.catchAll((e) =>
        Effect.fail(
          new PromptError({
            message: `Failed to read prompt from ${promptFile}: ${String(e)}`,
          }),
        ),
      ),
    );
    return { text, source: "template" as const };
  });
};
