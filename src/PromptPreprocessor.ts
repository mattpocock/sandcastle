import { Effect } from "effect";
import { Display } from "./Display.js";
import { PromptError } from "./errors.js";
import type { ExecError } from "./errors.js";
import type { SandboxService } from "./SandboxFactory.js";

/**
 * Rough token estimate: 1 token ≈ 4 characters (Anthropic approximation).
 */
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export const preprocessPrompt = (
  prompt: string,
  sandbox: SandboxService,
  cwd: string,
): Effect.Effect<string, ExecError | PromptError, Display> => {
  const pattern = /!`([^`]+)`/g;
  const matches = [...prompt.matchAll(pattern)];

  if (matches.length === 0) {
    return Effect.succeed(prompt);
  }

  return Effect.gen(function* () {
    const display = yield* Display;
    return yield* display.taskLog("Expanding shell expressions", (message) =>
      Effect.gen(function* () {
        // Log all commands upfront in document order
        for (const match of matches) {
          message(match[1]!);
        }

        // Execute all commands in parallel
        const results = yield* Effect.all(
          matches.map((match) => {
            const command = match[1]!;
            return Effect.flatMap(
              sandbox.exec(command, { cwd }),
              (execResult) =>
                execResult.exitCode !== 0
                  ? Effect.fail(
                      new PromptError({
                        message: `Command \`${command}\` exited with code ${execResult.exitCode}: ${execResult.stderr}`,
                      }),
                    )
                  : Effect.succeed(execResult.stdout.trimEnd()),
            );
          }),
          { concurrency: "unbounded" },
        );

        // Log estimated token count from all resolved shell expression outputs
        const totalTokens = results.reduce(
          (sum, output) => sum + estimateTokens(output),
          0,
        );
        message(
          `~${totalTokens.toLocaleString()} tokens from shell expressions`,
        );

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
        return result;
      }),
    );
  });
};
