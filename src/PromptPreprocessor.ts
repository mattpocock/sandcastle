import { Clock, Duration, Effect, Option } from "effect";
import { Display } from "./Display.js";
import { PromptError, PromptExpansionTimeoutError } from "./errors.js";
import type { ExecError } from "./errors.js";
import type { SandboxService } from "./SandboxFactory.js";

const PROMPT_EXPANSION_TIMEOUT_MS = 30_000;

/**
 * @internal
 * Marker inserted between `!` and the opening backtick for shell blocks that
 * appear in the raw template. The preprocessor only executes marked blocks, so
 * `!`...`` patterns arriving via argument substitution are treated as data.
 * Used only by `substitutePromptArgs`; not part of the public API.
 */
export const SHELL_BLOCK_MARKER = "\u0001";

const MARKED_SHELL_BLOCK_PATTERN = new RegExp(
  `!${SHELL_BLOCK_MARKER}\`([^\`]+)\``,
  "gu",
);

export const preprocessPrompt = (
  prompt: string,
  sandbox: SandboxService,
  cwd: string,
): Effect.Effect<
  string,
  ExecError | PromptError | PromptExpansionTimeoutError,
  Display
> => {
  // The capture group is required, so the `?? ""` fallback never applies.
  const blocks = [...prompt.matchAll(MARKED_SHELL_BLOCK_PATTERN)].map(
    (match) => ({
      text: match[0],
      command: match[1] ?? "",
      index: match.index,
    }),
  );

  if (blocks.length === 0) {
    return Effect.succeed(prompt.replaceAll(SHELL_BLOCK_MARKER, ""));
  }

  return Effect.gen(function* () {
    const display = yield* Display;
    return yield* display.taskLog("Expanding shell expressions", (message) =>
      Effect.gen(function* () {
        // Execute all commands in parallel
        const expanded = yield* Effect.all(
          blocks.map((block) => {
            const { command } = block;
            return Effect.gen(function* () {
              const start = yield* Clock.currentTimeMillis;
              const maybeResult = yield* sandbox
                .exec(command, { cwd })
                .pipe(
                  Effect.timeoutOption(
                    Duration.millis(PROMPT_EXPANSION_TIMEOUT_MS),
                  ),
                );
              if (Option.isNone(maybeResult)) {
                const elapsedMs = (yield* Clock.currentTimeMillis) - start;
                return yield* new PromptExpansionTimeoutError({
                  message: `Shell expression \`${command}\` timed out after ${elapsedMs}ms`,
                  timeoutMs: PROMPT_EXPANSION_TIMEOUT_MS,
                  expression: command,
                  elapsedMs,
                });
              }
              const execResult = maybeResult.value;
              if (execResult.exitCode !== 0) {
                return yield* new PromptError({
                  message: `Command \`${command}\` exited with code ${execResult.exitCode}: ${execResult.stderr}`,
                  exitCode: execResult.exitCode,
                });
              }
              return { ...block, output: execResult.stdout.trimEnd() };
            });
          }),
          { concurrency: "unbounded" },
        );

        // Log per-command token counts
        for (const { command, output } of expanded) {
          const tokens = Math.ceil(output.length / 4);
          message(`${command} → ~${tokens} tokens`);
        }

        // Splice each output in place of its block. Blocks are in prompt
        // order and don't overlap, so one forward pass over `prompt` works.
        let result = "";
        let cursor = 0;
        for (const { index, text, output } of expanded) {
          result += prompt.slice(cursor, index) + output;
          cursor = index + text.length;
        }
        result += prompt.slice(cursor);
        return result.replaceAll(SHELL_BLOCK_MARKER, "");
      }),
    );
  });
};
