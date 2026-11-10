import { DateTime } from "effect";
import type { SendReceipt, SessionSendOptions } from "./Session.js";
import { SessionInputError } from "./SessionInputError.js";
import type { SupervisorLink } from "./supervisorHost.js";
import type { Reply } from "./supervisorProtocol.js";

// Host side of `send()`: one `input` request to the session supervisor,
// answered `accepted` once the message is written to the agent's stdin, or
// `refused` with why not (ADR 0032).

/** Which running session a message is for: a held process's id, a name, or the only one. */
export interface SendTarget {
  readonly id?: string;
  readonly name?: string;
}

type Answer = Extract<Reply, { type: "accepted" | "refused" | "error" }>;

const isAnswer = (reply: Reply): reply is Answer =>
  reply.type === "accepted" ||
  reply.type === "refused" ||
  reply.type === "error";

/** Checks what `send()` was given, the way the type says it. */
const checked = (options: SessionSendOptions): SessionSendOptions => {
  if (typeof options.text !== "string" || options.text.trim() === "") {
    throw new TypeError("send: `text` must be a non-empty string");
  }
  if (options.from !== undefined && options.from.trim() === "") {
    throw new TypeError("send: `from` must not be empty when given");
  }
  return options;
};

/** Sends one message to a running session's agent through the supervisor. */
export const sendTo = async (
  link: SupervisorLink,
  target: SendTarget,
  options: SessionSendOptions,
): Promise<SendReceipt> => {
  const { text, interrupt = false, from } = checked(options);
  let answer: Answer | undefined;
  try {
    await link.call(
      {
        type: "input",
        ...target,
        text,
        interrupt,
        ...(from === undefined ? {} : { from }),
      },
      (reply) => {
        if (isAnswer(reply)) {
          answer = reply;
        }
      },
    );
  } catch (error) {
    throw new SessionInputError({
      reason: "no-such-session",
      message:
        "No session is running to send to: the session supervisor didn't answer (it has exited, or can't be reached).",
      cause: error,
    });
  }
  if (answer === undefined || answer.type === "error") {
    throw new Error(
      `send: the session supervisor didn't take the message${answer === undefined ? "" : `: ${answer.message}`}`,
    );
  }
  if (answer.type === "refused") {
    throw new SessionInputError({
      reason: answer.reason,
      message: answer.message,
    });
  }
  return {
    session: answer.name,
    at: DateTime.toDate(DateTime.unsafeMake(answer.at)),
    interrupted: answer.interrupted,
  };
};
