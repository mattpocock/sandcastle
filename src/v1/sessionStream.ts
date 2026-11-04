import type { IterationUsage, ParsedStreamEvent } from "../AgentProvider.js";
import type { ContextWindow } from "../ContextWindow.js";
import {
  findLastTagContent,
  unwrapFences,
} from "../extractStructuredOutput.js";
import type { ExtractedOutput, SessionRequest } from "./supervisorProtocol.js";

// What the supervisor has learnt from an agent's stream so far. Pure: the
// session loop feeds it each parsed line and acts on the result.

/** What a session's stream has said so far. */
export interface StreamState {
  /** Every text and result the agent printed, scanned for the closing tag. */
  readonly text: string;
  /** The agent's own final result, when its stream reports one. */
  readonly result?: string;
  /** The last text the agent printed, the final message when there's no result. */
  readonly lastText?: string;
  readonly sessionId?: string;
  readonly usage?: IterationUsage;
  readonly contextWindow?: ContextWindow;
  /** The last failure the agent reported in its own stream. */
  readonly streamError?: string;
}

/** A stream with nothing in it yet. */
export const emptyStream: StreamState = { text: "" };

/** What an event the user sees looks like, if this parsed event is one. */
export type VisibleEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "toolCall"; readonly name: string; readonly args: string };

const applyEvent = (
  state: StreamState,
  event: ParsedStreamEvent,
): StreamState => {
  switch (event.type) {
    case "text": {
      return { ...state, text: state.text + event.text, lastText: event.text };
    }
    case "result": {
      return {
        ...state,
        text: state.text + event.result,
        result: event.result,
      };
    }
    case "session_id": {
      return { ...state, sessionId: event.sessionId };
    }
    case "usage": {
      return { ...state, usage: event.usage };
    }
    case "context_window": {
      return { ...state, contextWindow: event.contextWindow };
    }
    case "error": {
      return { ...state, streamError: event.message };
    }
    case "tool_call": {
      return state;
    }
  }
};

const visible = (event: ParsedStreamEvent): VisibleEvent[] => {
  if (event.type === "text") {
    return [{ type: "text", text: event.text }];
  }
  if (event.type === "tool_call") {
    return [{ type: "toolCall", name: event.name, args: event.args }];
  }
  return [];
};

/** Folds one line's parsed events into the state; returns the events to show. */
export const applyEvents = (
  state: StreamState,
  events: readonly ParsedStreamEvent[],
): { readonly state: StreamState; readonly visible: VisibleEvent[] } => ({
  state: events.reduce((folded, event) => applyEvent(folded, event), state),
  visible: events.flatMap((event) => visible(event)),
});

/** The agent's final message: its own result, else the last text it printed. */
export const finalMessage = (state: StreamState): string =>
  state.result ?? state.lastText ?? "";

const parseJson = (
  text: string,
): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

/**
 * Finds the last `<tag>…</tag>` the agent printed and, for an object output,
 * parses its JSON. Validating it against the schema is the host's job, where
 * the schema lives.
 */
export const extractOutput = (
  text: string,
  output: NonNullable<SessionRequest["output"]>,
): ExtractedOutput => {
  const raw = findLastTagContent(text, output.tag);
  if (raw === undefined) {
    return {
      found: false,
      problem: `Structured output tag <${output.tag}> not found in agent output`,
    };
  }
  if (output.kind === "string") {
    return { found: true, raw, value: raw.trim() };
  }
  const parsed = parseJson(unwrapFences(raw.trim()));
  return parsed.ok
    ? { found: true, raw, value: parsed.value }
    : {
        found: false,
        raw,
        problem: `Structured output tag <${output.tag}> contains invalid JSON`,
      };
};
