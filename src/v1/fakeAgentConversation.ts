import { createInterface } from "node:readline";
import { Duration, Effect, Option, Schema } from "effect";

// A fake Claude Code taking streaming input (`--input-format stream-json`),
// shaped on the real CLI's: it reads its prompt as the first message on
// stdin, prints each message back with `isReplay` when it reads it, and
// keeps running between turns until stdin closes. A message sent while a
// turn runs is read when the turn reaches a tool result (here: at once, or
// after the script's input delay); one sent after a turn has ended starts a
// new turn. Either way the fake answers by repeating the message, as its last
// text and its result, so a test sees exactly what the model read. An
// interrupt stops a running turn with the CLI's error result.

/** What the conversation replays. */
export interface Conversation {
  /** The recorded lines of the first turn. */
  readonly lines: readonly string[];
  readonly exitCode: number;
  /** The first turn doesn't end on its own, like one in a long tool call. */
  readonly hang: boolean;
  /** How long a message sent while a turn runs waits before it's read. */
  readonly inputDelayMs: number;
  readonly sessionId: string | undefined;
  /** Called with the prompt before the first turn's lines are printed. */
  readonly onPrompt: (prompt: string) => Promise<void>;
}

const Incoming = Schema.parseJson(
  Schema.Union(
    Schema.Struct({
      type: Schema.Literal("user"),
      message: Schema.Struct({ content: Schema.String }),
    }),
    Schema.Struct({
      type: Schema.Literal("control_request"),
      request_id: Schema.String,
      request: Schema.Struct({ subtype: Schema.String }),
    }),
  ),
);

type Incoming = typeof Incoming.Type;

const decodeIncoming = Schema.decodeUnknownOption(Incoming);

const print = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const sleep = async (ms: number): Promise<void> =>
  Effect.runPromise(Effect.sleep(Duration.millis(ms)));

const isResult = (line: string): boolean =>
  Option.isSome(
    Schema.decodeUnknownOption(
      Schema.parseJson(Schema.Struct({ type: Schema.Literal("result") })),
    )(line),
  );

/** Prints a message back as read, then answers it by repeating it. */
const readAndAnswer = (content: string, sessionId: string | undefined) => {
  const session = sessionId === undefined ? {} : { session_id: sessionId };
  print({
    type: "user",
    message: { role: "user", content },
    isReplay: true,
    ...session,
  });
  print({
    type: "assistant",
    message: { content: [{ type: "text", text: content }] },
    ...session,
  });
  print({
    type: "result",
    subtype: "success",
    is_error: false,
    result: content,
    ...session,
  });
};

/** What the conversation does with one message; its turn is idle after. */
const handle = async (
  conversation: Conversation,
  incoming: Incoming,
  busy: boolean,
): Promise<void> => {
  const session =
    conversation.sessionId === undefined
      ? {}
      : { session_id: conversation.sessionId };
  if (incoming.type === "control_request") {
    print({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: incoming.request_id,
        response: { still_queued: [] },
      },
    });
    if (busy) {
      print({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        // As the real CLI prints it: no `result` text, so no failure is read from it.
        errors: [
          "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
        ],
        ...session,
      });
    }
    return;
  }
  if (busy) {
    await sleep(conversation.inputDelayMs);
  } else {
    print({ type: "system", subtype: "init", ...session });
  }
  readAndAnswer(incoming.message.content, conversation.sessionId);
};

/** Reads the prompt (the first message), prints it back as read, and returns it. */
const readPrompt = async (
  conversation: Conversation,
  messages: AsyncIterator<string>,
): Promise<void> => {
  const first = await messages.next();
  const decoded =
    first.done === true ? Option.none() : decodeIncoming(first.value);
  const prompt =
    Option.isSome(decoded) && decoded.value.type === "user"
      ? decoded.value.message.content
      : "";
  await conversation.onPrompt(prompt);
  print({
    type: "user",
    message: { role: "user", content: prompt },
    isReplay: true,
    ...(conversation.sessionId === undefined
      ? {}
      : { session_id: conversation.sessionId }),
  });
};

/** Takes messages until stdin closes; resolves with whether a turn is still running. */
const takeMessages = async (
  conversation: Conversation,
  messages: AsyncIterator<string>,
  busy: boolean,
): Promise<boolean> => {
  const next = await messages.next();
  if (next.done === true) {
    return busy;
  }
  const incoming = decodeIncoming(next.value);
  if (Option.isNone(incoming)) {
    return takeMessages(conversation, messages, busy);
  }
  await handle(conversation, incoming.value, busy);
  return takeMessages(conversation, messages, false);
};

const talk = async (
  conversation: Conversation,
  messages: AsyncIterator<string>,
): Promise<number> => {
  await readPrompt(conversation, messages);
  for (const line of conversation.lines) {
    process.stdout.write(`${line}\n`);
  }
  const endsTurn = conversation.lines.some((line) => isResult(line));
  if (conversation.exitCode !== 0 || (!endsTurn && !conversation.hang)) {
    return conversation.exitCode;
  }
  if (await takeMessages(conversation, messages, conversation.hang)) {
    // Still in its turn, like a CLI that finishes its work before it exits.
    await sleep(Duration.toMillis(Duration.days(1)));
  }
  return conversation.exitCode;
};

/** Runs the conversation until stdin closes; resolves with the exit code. */
export const converse = async (conversation: Conversation): Promise<number> => {
  const input = createInterface({ input: process.stdin });
  try {
    return await talk(conversation, input[Symbol.asyncIterator]());
  } finally {
    // An open stdin would keep the process alive past its exit code.
    input.close();
    process.stdin.destroy();
  }
};
