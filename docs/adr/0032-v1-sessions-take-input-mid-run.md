# v1 sessions take input mid-run: `send()`, through Claude Code's streaming input

Status: accepted for the v1 pre-release line.

## Context

A host (a person at a terminal, or a monitoring agent) watching a running session with `follow()` ([ADR 0031](0031-v1-follow-reads-the-session-events-file.md)) often sees it heading the wrong way: it missed a requirement, it's stuck in a loop, or it should stop and hand in what it has. Until now the only lever was `kill()` or `close()`, which throw the session's work away. The host wants the reverse of `follow()`: say something to the running agent, and have it act on it in the same session.

The session supervisor wrote the prompt to the agent's stdin and closed it at once, and its protocol had no request for anything after the start. The channel to reach the supervisor after a detach already existed: a request file plus `node supervisor.mjs call` ([ADR 0027](0027-v1-session-supervisor-channel.md)).

Claude Code can take input mid-run, checked against the real CLI (2.1.x) before this was built. Started with `--input-format stream-json`, it reads one JSON message per line on stdin, the prompt being the first, and keeps running between turns until stdin closes:

- A user message written while a tool runs is read when the tool returns, in the same turn; the turn's answer takes it into account. One written while the model is writing its final answer, with no tool boundary left, starts a second turn after the first `result`.
- With `--replay-user-messages`, each message is printed back as a `user` line with `isReplay: true` at the moment the model reads it, the prompt included.
- A `control_request` with subtype `interrupt` stops the running tool and turn within a fraction of a second; the CLI answers with a `control_response`, ends the turn with a `result` of subtype `error_during_execution` (`is_error: true`, no `result` text), and stays up. The next message starts a new turn in the same conversation.
- Closing stdin after the last `result` makes it exit 0.

Codex's `codex exec`, which Sandcastle runs, takes one prompt and documents no further input. Its separate `app-server` mode has turn steering and interrupts, but over its own JSON-RPC stream: a second Codex integration, not a flag.

## Decision

- **`send({ session?, text, interrupt?, from? })` on a detachable handle**, and `send({ text, interrupt?, from? })` on a held `SessionProcess`. One `input` request to the supervisor, naming the session by request id (a held process) or by name (any handle; default the only running session). It resolves with `{ session, at, interrupted }` once the message is written to the agent's stdin: "on its way", not "acted on". It works held, after a detach and reattached, like `follow()`, as long as the supervisor runs. It rejects with `SessionInputError` (`no-such-session`, `ambiguous-session`, `stopped-taking-input`, `agent-takes-no-input`). A held process's `send()` rejects with `SandboxDetachedError` after a detach, like its `kill()`: use the handle's.
- **Claude Code always runs with streaming input**: `--input-format stream-json --replay-user-messages`, the prompt as the first message, no opt-in. Steering a session nobody planned to steer is the point. This is v1 only; 0.x's `run()` is unchanged.
- **The supervisor closes stdin only when nothing it wrote is unread.** It counts the messages it writes after the prompt and the `isReplay` lines it sees after the prompt's. At each `result`, if every message has been read, it closes stdin and the agent exits as it did before; otherwise it leaves stdin open for the turn that will read the rest. The prompt counts as read by the first `result` whether or not it was printed back, so a session nobody talks to ends after its one turn exactly as before, even under a CLI (or a stand-in) that prints nothing back; only a message sent with `send()` needs its `isReplay` line. Once stdin is closed, `send()` is refused with `stopped-taking-input`, even if the process lingers (a background task can keep the CLI up after its last turn).
- **An interrupt is acknowledged before the message goes.** The supervisor writes the `control_request`, waits for its `control_response` (or up to 10 seconds, or stdin closing), then writes the message. The message is counted before the interrupt goes out, so the interrupted turn's `result` doesn't close stdin under it. That `result` carries no `result` text, so it isn't read as the agent reporting a failure: the session's outcome comes from its last turn.
- **The completion timeout waits for unread messages.** After the output's closing tag ([ADR 0026](0026-v1-session-completion-timeout-on-output-closing-tag.md)), the completion timeout applies only while every message has been read; with one unread, the idle timeout applies, so a message sent after the closing tag isn't cut off mid-turn.
- **Who sent it reaches the model.** With `from`, the agent reads `[from <from>] <text>`, so it can weigh guidance from a person against a monitor's. Without it, the text goes as it is.
- **It's recorded.** Each message is a new `RecordedEvent`, `{ type: "input", text, from?, interrupt, at }`, written when the supervisor hands it to stdin, redacted like the other events, in the events file `follow()` reads and in the session record. `text` is the message as sent, without the prefix. The event stream's version stays 1: v1 hasn't shipped, so the change is cheap now. A held session's `events` iterable is unchanged: it shows what the agent does.
- **`acceptsInput` on every agent**, read-only, from its id: `true` for `claudeCode()` (and a fake agent in its format), `false` for the rest. `send()` to a session whose agent takes no input is refused with `agent-takes-no-input`.
- **The fake agent holds a conversation.** In `claude-code` format, started with streaming input, it prints each message back as read and answers by repeating it, so tests see exactly what the model would read; `inputDelaySeconds` delays reading a message sent while a turn hangs, like one sent during a long tool call; an interrupt stops a hanging turn with the CLI's error result.

## Considered options

- **Opt-in streaming input per session.** Rejected: the session that needs steering is the one nobody expected to steer.
- **Close stdin at the first `result`, as before, and refuse anything later.** Rejected: a message sent while the model writes its final answer would be lost, though the CLI would have read it.
- **Resolve `send()` when the agent reads the message.** Rejected: that can take as long as a tool call. The `isReplay` line marks the read in the native transcript, and the `input` event marks when it was sent.
- **Codex through `codex app-server` now.** Deferred: a second integration with its own stream; `send()` fails clearly for Codex sessions until then.
- **Queue messages for a session that hasn't started, or has ended.** Rejected: it needs storage and a second delivery path. Start a new session, or continue the ended one.

## Consequences

- Every Claude Code session's stdin protocol changed: the prompt arrives as a JSON line, and stdin closes only after the first `result`. A stand-in `claude` that reads stdin to its end before printing anything now waits forever; it must read the first line. Sandcastle needs a Claude Code that supports streaming input; a message sent to one that doesn't print messages back is never counted as read, so its session keeps stdin open and ends on the idle timeout.
- An agent may be talked into more turns than it would have taken; the detach deadline still bounds it.
- The control socket now also takes input ([ADR 0027](0027-v1-session-supervisor-channel.md)'s open trust question): any process as the sandbox user, the agent included, can send a session a message.
