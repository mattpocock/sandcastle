import type {
  AgentProvider,
  OutputDefinition,
  OutputObjectDefinition,
  OutputType,
  Sandbox,
  SessionOptions,
  SessionResult,
} from "@ai-hero/sandcastle/v1";
import { StructuredOutputError } from "@ai-hero/sandcastle/v1";
import { logEvent } from "./sandbox";

// Two sessions in one sandbox: the produce session does the work, then an
// extraction session continues its conversation and hands back the
// structured output. A v1 session never retries its output, so a failed
// extraction is retried here: another extraction session, continuing the
// produce session again, told what was wrong with the last attempt.

export interface RunWithExtractionOptions<T> {
  readonly sandbox: Sandbox;
  readonly name: string;
  readonly agent: AgentProvider;
  /** The produce session's prompt, already rendered. */
  readonly prompt: string;
  readonly output: OutputObjectDefinition<T>;
  readonly extractionPrompt: string;
  /** Extra extraction attempts after the first, when the output is missing or invalid. Default `2`. */
  readonly maxRetries?: number;
}

/** Runs a session, printing what the agent does as it goes. */
export const runSession = async <
  const O extends OutputDefinition | undefined = undefined,
>(
  sandbox: Sandbox,
  options: SessionOptions<O>,
): Promise<SessionResult<OutputType<O>>> => {
  const spawned = await sandbox.spawnSession(options);
  for await (const event of spawned.events) {
    logEvent(event);
  }
  return spawned.wait();
};

interface ExtractionAttempt {
  readonly produce: SessionResult;
  /** 1 for the first attempt. */
  readonly attempt: number;
  /** Why the last attempt was rejected. */
  readonly lastError?: string;
}

const extract = async <T>(
  options: RunWithExtractionOptions<T>,
  { produce, attempt, lastError }: ExtractionAttempt,
): Promise<T> => {
  const prompt =
    lastError === undefined
      ? options.extractionPrompt
      : `${options.extractionPrompt}\n\nYour last attempt was rejected: ${lastError}\nEmit the corrected <${options.output.tag}> block.`;
  try {
    const extraction = await runSession(options.sandbox, {
      name: `${options.name}-extract-${String(attempt)}`,
      agent: options.agent,
      prompt,
      output: options.output,
      continueSession: produce,
    });
    return extraction.output;
  } catch (error) {
    if (
      !(error instanceof StructuredOutputError) ||
      attempt > (options.maxRetries ?? 2)
    ) {
      throw error;
    }
    return extract(options, {
      produce,
      attempt: attempt + 1,
      lastError: error.message,
    });
  }
};

/** The produce session, then its structured output from an extraction session. */
export const runWithExtraction = async <T>(
  options: RunWithExtractionOptions<T>,
): Promise<{ readonly produce: SessionResult; readonly output: T }> => {
  const produce = await runSession(options.sandbox, {
    name: options.name,
    agent: options.agent,
    prompt: options.prompt,
  });
  if (produce.sessionId === undefined || produce.sessionId === "") {
    throw new Error(
      "Cannot extract structured output because the produce session had no session id.",
    );
  }
  const output = await extract(options, { produce, attempt: 1 });
  return { produce, output };
};
