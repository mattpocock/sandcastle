import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePrompt } from "./PromptResolver.js";
import { PromptError } from "./errors.js";

const run = <A, E>(effect: Effect.Effect<A, E, NodeContext.NodeContext>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeContext.layer)));

describe("PromptResolver", () => {
  it("returns inline prompt when prompt is provided", async () => {
    const result = await run(resolvePrompt({ prompt: "do some work" }));
    expect(result).toEqual({ text: "do some work", source: "inline" });
  });

  it("reads prompt from promptFile when provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prompt-resolver-"));
    const promptPath = join(dir, "custom-prompt.md");
    await writeFile(promptPath, "prompt from file");

    const result = await run(resolvePrompt({ promptFile: promptPath }));
    expect(result).toEqual({ text: "prompt from file", source: "template" });
  });

  it("errors when both prompt and promptFile are provided", async () => {
    const error = await run(
      resolvePrompt({ prompt: "inline", promptFile: "/some/file.md" }).pipe(
        Effect.flip,
      ),
    );
    expect(error).toBeInstanceOf(PromptError);
    expect(error.message).toBe("Cannot provide both prompt and promptFile");
  });

  it("errors when neither prompt nor promptFile is provided", async () => {
    const error = await run(resolvePrompt({}).pipe(Effect.flip));
    expect(error).toBeInstanceOf(PromptError);
    expect(error.message).toContain("prompt");
  });
});
