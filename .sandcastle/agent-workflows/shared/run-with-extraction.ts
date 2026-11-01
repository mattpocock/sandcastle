import { run } from "@ai-hero/sandcastle";
import type {
  OutputObjectDefinition,
  RunOptions,
  RunResult,
} from "@ai-hero/sandcastle";

export interface RunWithExtractionOptions<T>
  extends Omit<RunOptions, "output"> {
  readonly output: OutputObjectDefinition<T>;
  readonly extractionPrompt: string;
  /**
   * Extra attempts after the first if extraction or validation fails. Forwarded
   * to `Output`'s built-in `maxRetries`, which resumes the extraction session
   * and feeds back the error so the agent can re-emit a corrected tag.
   * Default: `2` (three attempts total).
   */
  readonly maxRetries?: number;
}

export async function runWithExtraction<T>(
  options: RunWithExtractionOptions<T>,
): Promise<RunResult & { output: T }> {
  const {
    output,
    extractionPrompt,
    maxRetries = 2,
    ...produceOptions
  } = options;
  const produce = await run(produceOptions);
  const sessionId = produce.iterations.at(-1)?.sessionId;

  if (sessionId === undefined || sessionId === "") {
    throw new Error(
      "Cannot extract structured output because the produce run had no session id.",
    );
  }

  const { promptArgs: _promptArgs, ...extractionOptions } = produceOptions;
  const extraction = await run({
    ...extractionOptions,
    name:
      produceOptions.name !== undefined && produceOptions.name !== ""
        ? `${produceOptions.name} (extract)`
        : undefined,
    promptFile: undefined,
    prompt: extractionPrompt,
    // Extraction ends with the output tag, not `<promise>COMPLETE</promise>`.
    completionSignal: `</${output.tag}>`,
    resumeSession: sessionId,
    output: { ...output, maxRetries },
  });

  return { ...produce, output: extraction.output };
}
