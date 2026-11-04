import type { OutputDefinition } from "./Output.js";
import type { Tracker } from "./skills/Skill.js";
import { trackerDoc } from "./skills/trackerDoc.js";

// The parts of a bundled task's prompt that every task carries: the tracker
// instructions, the output tag and the headless rule.

const TRACKER_PRECEDENCE =
  "Where these issue tracker instructions disagree with the repository's CLAUDE.md or AGENTS.md, follow these.";

const HEADLESS =
  "No human is watching this run: never ask a question or wait for an answer. If you can't proceed, end your final message with `blocked` and the reason.";

const outputInstruction = (output: OutputDefinition): string =>
  output._tag === "object"
    ? `When you're done, end your final message with your result as JSON between <${output.tag}> and </${output.tag}>.`
    : `When you're done, end your final message with your result between <${output.tag}> and </${output.tag}>.`;

/** The task's own prompt, then the tracker instructions, the output tag and the headless rule. */
export const taskPrompt = (options: {
  readonly body: string;
  readonly tracker: Tracker;
  readonly output: OutputDefinition | undefined;
}): string =>
  [
    options.body.trim(),
    `${TRACKER_PRECEDENCE}\n\n${trackerDoc(options.tracker)}`,
    ...(options.output === undefined
      ? []
      : [outputInstruction(options.output)]),
    HEADLESS,
  ].join("\n\n");
