import * as fs from "node:fs";
import type { Sandbox } from "@ai-hero/sandcastle/v1";
import { quote, run } from "./sandbox";

// A v1 session's prompt is used exactly as written, so the workflows render
// their own: `{{KEY}}` placeholders become the args, and a line that is only
// !`command` becomes that command's output, run in the sandbox before the
// session starts. Commands are read from the template alone: an arg's value
// (a PR body, say) is never scanned for !`…`, so it can't run anything, and
// an arg inside a command is single-quoted.

const PLACEHOLDER = /\{\{(?<key>[A-Z0-9_]+)\}\}/gu;
const COMMAND_LINE = /^!`(?<command>.+)`$/u;

/** `text` with each `{{KEY}}` replaced by `args[KEY]`; a key with no arg is an error. */
const substitute = (
  text: string,
  args: Readonly<Record<string, string>>,
  escape: (value: string) => string = (value) => value,
): string =>
  text.replaceAll(PLACEHOLDER, (_match, key: string) => {
    const value = args[key];
    if (value === undefined) {
      throw new Error(`prompt: no value for {{${key}}}`);
    }
    return escape(value);
  });

/** The prompt in `file`, its placeholders filled from `args` and its !`command` lines run in `sandbox`. */
export const renderPrompt = async (
  file: string,
  args: Readonly<Record<string, string>>,
  sandbox: Sandbox,
): Promise<string> => {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  // One at a time, in the order the prompt reads.
  const rendered = await lines.reduce<Promise<string[]>>(async (done, line) => {
    const before = await done;
    const command = COMMAND_LINE.exec(line.trim())?.groups?.["command"];
    if (command === undefined) {
      return [...before, substitute(line, args)];
    }
    const output = await run(sandbox, substitute(command, args, quote));
    return [...before, output.trimEnd()];
  }, Promise.resolve([]));
  return rendered.join("\n");
};
