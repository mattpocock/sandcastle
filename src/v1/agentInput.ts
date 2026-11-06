import { Option, Schema } from "effect";
import type { AgentDescriptor } from "./supervisorProtocol.js";

// How a running agent takes messages after its prompt. Only Claude Code does,
// through its streaming input: started with `--input-format stream-json`, its
// stdin stays open and takes one JSON message per line, the prompt being the
// first. A message written while it works is read at its next tool result, in
// the same turn, or once the turn ends, as a new one. `--replay-user-messages`
// makes it print each message back (`isReplay`) when the model reads it, so
// the supervisor can tell when every message it wrote has been read, and only
// then close stdin, which lets the agent exit after its last turn. A
// `control_request` interrupt stops the running turn, which ends with an
// error result; the process stays up for the next message.

/** Whether the agent with this id takes messages while it runs. */
export const acceptsInput = (id: AgentDescriptor["id"]): boolean =>
  id === "claude-code";

/** The flags that keep Claude Code's stdin open for messages. */
export const STREAMING_INPUT_FLAGS =
  " --input-format stream-json --replay-user-messages";

/** What the model reads: the text, after who sent it when that's known. */
export const messageText = (text: string, from: string | undefined): string =>
  from === undefined ? text : `[from ${from}] ${text}`;

/** One user message on the agent's stdin. */
export const userLine = (text: string): string =>
  `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;

/** A request on the agent's stdin to stop its current turn. */
export const interruptLine = (requestId: string): string =>
  `${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } })}\n`;

const InputLine = Schema.parseJson(
  Schema.Union(
    Schema.Struct({
      type: Schema.Literal("user"),
      isReplay: Schema.Literal(true),
    }),
    Schema.Struct({ type: Schema.Literal("result") }),
    Schema.Struct({
      type: Schema.Literal("control_response"),
      response: Schema.Struct({ request_id: Schema.String }),
    }),
  ),
);

const decodeInputLine = Schema.decodeUnknownOption(InputLine);

/** What a line of the agent's stdout says about its input. */
export type InputSignal =
  /** It has read one more of the messages written to it. */
  | { readonly type: "read" }
  /** A turn has ended. */
  | { readonly type: "turn-ended" }
  /** It has acted on the control request with this id. */
  | { readonly type: "control-response"; readonly requestId: string };

/** What a line of the agent's stdout says about its input, if anything. */
export const inputSignal = (line: string): InputSignal | undefined => {
  if (!line.startsWith("{")) {
    return undefined;
  }
  const decoded = decodeInputLine(line);
  if (Option.isNone(decoded)) {
    return undefined;
  }
  const { value } = decoded;
  switch (value.type) {
    case "user": {
      return { type: "read" };
    }
    case "result": {
      return { type: "turn-ended" };
    }
    case "control_response": {
      return {
        type: "control-response",
        requestId: value.response.request_id,
      };
    }
  }
};
