# Structured output

[Structured output](./glossary.md#structured-output) is a typed answer from the [agent](./glossary.md#agent): it prints JSON inside an XML tag you choose, and Sandcastle parses it, checks it, and returns it on `result.output`. Ask for it with `Output.object()`, passing the tag and an [output schema](./glossary.md#output-schema), the validator the JSON must pass. The schema can be any [Standard Schema](https://standardschema.dev) validator — the examples below use [Zod](https://zod.dev), but Valibot, ArkType, and others work identically.

```ts
import { run, Output, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { z } from "zod";

const result = await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  prompt: `Analyze the code, and output the result as JSON inside <result> tags.
    The result must match this schema:
    { summary: string; score: string }
  `,
  output: Output.object({
    tag: "result",
    schema: z.object({ summary: z.string(), score: z.number() }),
  }),
});

console.log(result.output.summary); // typed as string
console.log(result.output.score); // typed as number
```

`Output.string({ tag })` extracts the tag contents as a plain string (trimmed, no JSON parsing). Both helpers require `maxIterations` to be `1` (the default). The resolved [prompt](./glossary.md#prompt) must contain the configured opening tag literal.

The tag can span several assistant messages. Some agents, such as Claude Code, continue a long reply across messages and then repeat only the last one as their final result. Sandcastle reads the whole reply in order, without the repeated last message, so a tag or a JSON string can continue from one message to the next.

When extraction or validation fails, `run()` throws a `StructuredOutputError`. Alongside `tag`, `rawMatched`, `cause`, `commits`, `branch`, and `preservedWorktreePath`, the error carries the `sessionId` (and `sessionFilePath`, when the session was captured) of the run that produced the bad output.

Pass `maxRetries` to have Sandcastle handle the retry loop for you. Each retry resumes the same [agent session](./glossary.md#agent-session) and feeds back a token-efficient description of the error, so the agent can re-emit a corrected tag without redoing the work. Retries require an [agent provider](./glossary.md#agent-provider) that supports session resumption (`claudeCode`, `codex`, `pi`, `copilot`, `cursor`, `opencode`) — every built-in agent provider resumes. Calling `run()` with `maxRetries > 0` against a custom provider without `sessionStorage` throws immediately.

```ts
const result = await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  prompt: "Analyze the code and emit JSON inside <result> tags.",
  output: Output.object({
    tag: "result",
    schema: z.object({ summary: z.string(), score: z.number() }),
    maxRetries: 2, // 2 retries on top of the initial attempt
  }),
});
```

If you need to drive the retry loop manually — for example, to customise the feedback prompt or rotate models on each attempt — leave `maxRetries` at its default of `0` and resume the failed session yourself:

```ts
import { run, Output, StructuredOutputError } from "@ai-hero/sandcastle";

try {
  return await run({ ...opts, output });
} catch (e) {
  if (e instanceof StructuredOutputError && e.sessionId) {
    return await run({
      ...opts,
      output,
      resumeSession: e.sessionId,
      prompt: `Your previous output failed: ${e.message}. Re-emit it inside <${e.tag}> tags.`,
    });
  }
  throw e;
}
```

## Related terms

- [Iterations](./iterations.md): the [completion signal](./glossary.md#completion-signal), which carries no payload
- [Agent sessions](./agent-sessions.md#session-resume): resuming a session, which `maxRetries` uses
- [Prompts](./prompts.md): the prompt must contain the configured tag
- [`run()` reference](./run.md#runoptions): the `output` option and `RunResult.output`
