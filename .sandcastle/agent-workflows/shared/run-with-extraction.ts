import {
  run,
  runMany,
  type OutputObjectDefinition,
  type RunManyOptions,
  type RunManyResult,
} from "@ai-hero/sandcastle";

export interface RunWithExtractionOptions<T> extends Omit<
  RunManyOptions,
  "maxIterations" | "completionSignal"
> {
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
): Promise<RunManyResult & { output: T }> {
  const {
    output,
    extractionPrompt,
    maxRetries = 2,
    ...produceOptions
  } = options;
  // The produce prompts end with `<promise>COMPLETE</promise>`. runMany()
  // (single iteration by default) is what watches for that signal, which keeps
  // ADR 0019 hang protection on the produce phase — one-shot run() no longer
  // looks for it.
  const produce = await runMany(produceOptions);
  const sessionId = produce.iterations.at(-1)?.sessionId;

  if (!sessionId) {
    throw new Error(
      "Cannot extract structured output because the produce run had no session id.",
    );
  }

  const { promptArgs: _promptArgs, ...extractionOptions } = produceOptions;
  // Extraction is one-shot run() with `output`: the `</tag>` closing tag now
  // opens the completion-timeout grace window (ADR 0021), replacing the old
  // `completionSignal: "</tag>"` workaround.
  const extraction = await run({
    ...extractionOptions,
    name: produceOptions.name ? `${produceOptions.name} (extract)` : undefined,
    promptFile: undefined,
    prompt: extractionPrompt,
    resumeSession: sessionId,
    output: { ...output, maxRetries },
  });

  return { ...produce, output: extraction.output };
}
