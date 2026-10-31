# Agents

Each is a factory `(model, options?) => AgentProvider` exported from `@ai-hero/sandcastle` (`src/AgentProvider.ts`).

- **Model:** every run uses the cheapest model. `doctor` prints the whole factory call for it, options included, and `VERIFY_MODEL` overrides the model.
  - Write that call into the main file exactly as printed. `init --model` sets only the model, so after `init`, add any options by hand.
  - pi's call carries `{ thinking: "off" }`. Without it, pi sends its default thinking (`medium`), and claude-haiku-5-5 rejects that with a 400.
- **Keys:** a missing key makes the run UNVERIFIABLE, naming the key. Matt adds keys with `.sandcastle/setup-verify-keys.sh`.
- **Image:** the agent's CLI lives in the image that `init --agent <x>` writes, so each agent needs its own world or its own `init`.

| Factory      | `init --agent` | Key (declare it empty in the world's `.sandcastle/.env`)                                       | CLI in the sandbox                                                                     | Session capture |
| ------------ | -------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------- |
| `claudeCode` | claude-code    | `CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY`                                              | `claude --print --output-format stream-json --model <m> -p -` (stdin)                  | yes             |
| `pi`         | pi             | `ANTHROPIC_API_KEY`                                                                            | `pi -p --mode json --model <provider/id>` (stdin)                                      | yes             |
| `codex`      | codex          | `CODEX_API_KEY`                                                                                | `codex exec --json -m <m>` (stdin)                                                     | yes             |
| `cursor`     | cursor         | `CURSOR_API_KEY`                                                                               | `agent --print --output-format stream-json --model <m> '<prompt>'` (argv, max 120 KiB) | yes             |
| `opencode`   | opencode       | `OPENCODE_API_KEY`                                                                             | `opencode run --format json --model <m> '<prompt>'` (argv)                             | no              |
| `copilot`    | copilot        | `COPILOT_GITHUB_TOKEN`, which wins over `GH_TOKEN`/`GITHUB_TOKEN` and needs "Copilot Requests" | `copilot -p '<prompt>' --output-format json --model <m>` (argv, max 120 KiB)           | yes             |

## Declare exactly the agent's key

Declare the agent's key empty (`KEY=`) so the value comes from the shell, and declare nothing else.

- An extra declared key reaches the sandbox. Ledger (e) reads a declared key as allowed, so an extra one hides a leak rather than revealing one.
- `ANTHROPIC_API_KEY` matters most: Claude Code uses it in place of the OAuth token when both are present.

## Proof, for every agent

- **The run:** exits 0, and the fixed artefact is committed where the strategy says it should be.
- **The model:** the agent really ran the cheap model. Read it from its own record:
  - claudeCode writes a session to `~/.claude/projects/<encoded cwd>/` on the host after each run (`src/SessionStore.ts`). In a world that HOME is the world's, so `grep -o '"model":"[^"]*"' <world>/home/.claude/projects/*/*.jsonl` shows the model.
  - pi and codex keep sessions in their own stores.
  - For the others, quote the stream.
- **Failure:** a non-zero agent exit fails the run with `<provider> exited with code <n>` (`src/Orchestrator.ts:191-204`). Quote it as the evidence.
- **The success signal in each stream** (`src/AgentProvider.ts`):

  | Agent      | Result event                   |
  | ---------- | ------------------------------ |
  | claudeCode | `{"type":"result"}`            |
  | pi         | `agent_end`                    |
  | codex      | `item.completed` agent_message |
  | opencode   | `text`                         |
  | copilot    | `assistant.message`            |
  | cursor     | claude-style `result`          |

  The orchestrator matches `<promise>COMPLETE</promise>` in the output only when the prompt asks for it.
