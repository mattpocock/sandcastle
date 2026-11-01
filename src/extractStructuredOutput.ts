import { StructuredOutputError } from "./Output.js";
import type {
  OutputDefinition,
  OutputObjectDefinition,
  OutputStringDefinition,
} from "./Output.js";

interface ExtractionContext {
  readonly commits: { sha: string }[];
  readonly branch: string;
  readonly preservedWorktreePath?: string;
  readonly sessionId?: string;
  readonly sessionFilePath?: string;
}

/**
 * Extract and validate structured output from the agent's stdout.
 *
 * - Finds the **last** occurrence of `<tag>...</tag>` in stdout.
 * - For `Output.object`: unwraps optional Markdown fences, JSON-parses,
 *   and validates against the Standard Schema.
 * - For `Output.string`: trims whitespace only.
 *
 * Throws `StructuredOutputError` on missing tag, invalid JSON, or schema failure.
 */
export const extractStructuredOutput = async (
  stdout: string,
  definition: OutputDefinition,
  context: ExtractionContext,
): Promise<unknown> => {
  if (definition._tag === "object") {
    return extractObject(stdout, definition, context);
  }
  return extractString(stdout, definition, context);
};

// ---------------------------------------------------------------------------
// Object extraction
// ---------------------------------------------------------------------------

const extractObject = async <T>(
  stdout: string,
  definition: OutputObjectDefinition<T>,
  context: ExtractionContext,
): Promise<T> => {
  const raw = findLastTagContent(stdout, definition.tag);

  if (raw === undefined) {
    throw new StructuredOutputError(
      `Structured output tag <${definition.tag}> not found in agent output`,
      { tag: definition.tag, rawMatched: undefined, ...context },
    );
  }

  // Fence-aware unwrap + JSON parse
  const unwrapped = unwrapFences(raw.trim());

  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapped);
  } catch (error) {
    throw new StructuredOutputError(
      `Structured output tag <${definition.tag}> contains invalid JSON`,
      { tag: definition.tag, rawMatched: raw, cause: error, ...context },
    );
  }

  // Standard Schema validation
  const result = await definition.schema["~standard"].validate(parsed);

  if (result.issues) {
    throw new StructuredOutputError(
      `Structured output tag <${definition.tag}> failed schema validation`,
      {
        tag: definition.tag,
        rawMatched: raw,
        cause: result.issues,
        ...context,
      },
    );
  }

  return result.value;
};

// ---------------------------------------------------------------------------
// String extraction
// ---------------------------------------------------------------------------

const extractString = (
  stdout: string,
  definition: OutputStringDefinition,
  context: ExtractionContext,
): string => {
  const raw = findLastTagContent(stdout, definition.tag);

  if (raw === undefined) {
    throw new StructuredOutputError(
      `Structured output tag <${definition.tag}> not found in agent output`,
      { tag: definition.tag, rawMatched: undefined, ...context },
    );
  }

  return raw.trim();
};

// ---------------------------------------------------------------------------
// Tag extraction — last match wins
// ---------------------------------------------------------------------------

/**
 * Find the content between the **last** `<tag>` and `</tag>` pair in text.
 * Returns `undefined` if the tag is not found.
 */
const findLastTagContent = (text: string, tag: string): string | undefined => {
  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;

  let lastContent: string | undefined;
  let searchFrom = 0;

  while (true) {
    const openIdx = text.indexOf(openTag, searchFrom);
    if (openIdx === -1) {
      break;
    }

    const contentStart = openIdx + openTag.length;
    const closeIdx = text.indexOf(closeTag, contentStart);
    if (closeIdx === -1) {
      break;
    }

    lastContent = text.slice(contentStart, closeIdx);
    searchFrom = closeIdx + closeTag.length;
  }

  return lastContent;
};

// ---------------------------------------------------------------------------
// Fence-aware unwrap (object mode only)
// ---------------------------------------------------------------------------

/**
 * Strip an optional Markdown code fence from text.
 *
 * Recognises:
 * - ` ```json\n...\n``` `
 * - ` ```\n...\n``` `
 *
 * If no fence is detected, returns the input unchanged (already trimmed by caller).
 */
const unwrapFences = (text: string): string => {
  // Match ```json ... ``` or ``` ... ``` (with optional language hint)
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/u.exec(text)?.[1];
  if (fenced !== undefined) {
    return fenced.trim();
  }
  return text;
};
