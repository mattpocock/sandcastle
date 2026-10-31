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
  "g",
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
  const matches = [...prompt.matchAll(MARKED_SHELL_BLOCK_PATTERN)];

  if (matches.length === 0) {
    return Effect.succeed(prompt.replaceAll(SHELL_BLOCK_MARKER, ""));
  }

  return Effect.gen(function* () {
    const display = yield* Display;
    return yield* display.taskLog("Expanding shell expressions", (message) =>
      Effect.gen(function* () {
        // Execute all commands in parallel
        const results = yield* Effect.all(
          matches.map((match) => {
            const command = match[1]!;
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
                return yield* Effect.fail(
                  new PromptExpansionTimeoutError({
                    message: `Shell expression \`${command}\` timed out after ${elapsedMs}ms`,
                    timeoutMs: PROMPT_EXPANSION_TIMEOUT_MS,
                    expression: command,
                    elapsedMs,
                  }),
                );
              }
              const execResult = maybeResult.value;
              if (execResult.exitCode !== 0) {
                return yield* Effect.fail(
                  new PromptError({
                    message: `Command \`${command}\` exited with code ${execResult.exitCode}: ${execResult.stderr}`,
                    exitCode: execResult.exitCode,
                  }),
                );
              }
              return execResult.stdout.trimEnd();
            });
          }),
          { concurrency: "unbounded" },
        );

        // Log per-command token counts
        for (let i = 0; i < matches.length; i++) {
          const command = matches[i]![1]!;
          const tokens = Math.ceil(results[i]!.length / 4);
          message(`${command} → ~${tokens} tokens`);
        }

        // Replace all matches using original indices (process in reverse to preserve positions)
        let result = prompt;
        for (let i = matches.length - 1; i >= 0; i--) {
          const match = matches[i]!;
          const index = match.index!;
          result =
            result.slice(0, index) +
            results[i] +
            result.slice(index + match[0].length);
        }
        return result.replaceAll(SHELL_BLOCK_MARKER, "");
      }),
    );
  });
};
