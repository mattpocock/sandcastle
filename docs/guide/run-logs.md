# Run logs

Pass `logging` to `run()`. Here Sandcastle writes a [run log](./glossary.md#run-log), a log file of the run's progress and the [agent](./glossary.md#agent)'s output, and forwards each [agent stream event](./glossary.md#agent-stream-event), one piece of that output such as a text chunk or a tool call, to your own code:

```typescript
import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const result = await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  promptFile: ".sandcastle/prompt.md",
  logging: {
    type: "file",
    path: ".sandcastle/logs/my-run.log",
    onAgentStreamEvent: (event) => {
      console.log(event.iteration, event.type);
    },
  },
});

console.log(result.logFilePath); // ".sandcastle/logs/my-run.log"
```

## The `logging` option

- `{ type: "file", path }` is [log-to-file mode](./glossary.md#log-to-file-mode), where progress goes to the run log instead of the terminal, and the default: without `logging`, Sandcastle writes a run log under `.sandcastle/logs/`. `result.logFilePath` is its path.
- `{ type: "stdout" }` is [terminal mode](./glossary.md#terminal-mode): progress shows in your terminal, with spinners and status messages.
- `onAgentStreamEvent` is only available in log-to-file mode. It fires for each text chunk, tool call, and raw stdout line the agent produces. Errors thrown by the callback are swallowed so a broken forwarder cannot kill the run.
- `verbose: true` adds every raw stdout line the agent emits: to the log file in log-to-file mode, interleaved with the human-readable output, and to stdout in terminal mode. Intended for debugging stuck or unexpected agent behaviour.
- `name` sets a display name for the run, shown as a prefix in log output.

## Related terms

- [Iterations](./iterations.md): each agent stream event carries its [iteration](./glossary.md#iteration) number
- [Init](./init.md): the [config directory](./glossary.md#config-directory), whose `.gitignore` ignores `logs/`
- [`run()` reference](./run.md#all-options): the `logging` option in full
