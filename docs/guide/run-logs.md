# Run logs

> **Run log**: A log file written to `.sandcastle/logs/` during a run session.

> **Log-to-file mode**: The display mode where Sandcastle writes iteration progress and agent output to a **run log**.

> **Terminal mode**: The display mode where Sandcastle renders an interactive UI in the terminal with spinners and styled status messages.

> **Agent stream event**: A single item in the **agent**'s output stream -- either a `text` chunk or a `toolCall` -- surfaced to the caller of `run()` so the stream can be forwarded to an external observability system. Available only in **log-to-file mode** via the `onAgentStreamEvent` callback on the `logging` option. Each event carries its `iteration` number and a `timestamp`.

Pass `logging` to `run()`. Here Sandcastle writes a run log and forwards each agent stream event to your own code:

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

- `{ type: "file", path }` is log-to-file mode, and the default: without `logging`, Sandcastle writes a run log under `.sandcastle/logs/`. `result.logFilePath` is its path.
- `{ type: "stdout" }` is terminal mode.
- `onAgentStreamEvent` is only available in log-to-file mode. It fires for each text chunk, tool call, and raw stdout line the agent produces. Errors thrown by the callback are swallowed so a broken forwarder cannot kill the run.
- `verbose: true` adds every raw stdout line the agent emits: to the log file in log-to-file mode, interleaved with the human-readable output, and to stdout in terminal mode. Intended for debugging stuck or unexpected agent behaviour.
- `name` sets a display name for the run, shown as a prefix in log output.

## Related terms

- [Iterations](./iterations.md): each agent stream event carries its iteration number
- [Init](./init.md): the config directory, whose `.gitignore` ignores `logs/`
- [`run()` reference](./run.md#all-options): the `logging` option in full
