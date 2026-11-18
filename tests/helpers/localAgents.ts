import { Output } from "@ai-hero/sandcastle/v1";
import { fakeAgent } from "@ai-hero/sandcastle/v1/testing";
import { z } from "zod";
import { NATIVE_PROVIDERS, skipsHere } from "./nativeProviders.js";

// The local providers' (bwrap(), seatbelt()) suites' fake agents, and
// whether they run here.

/** The structured output the detach tests' fake agent gives. */
export const ANSWER = Output.object({
  tag: "answer",
  schema: z.object({ answer: z.number() }),
});

const INIT = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "s",
});

/** A fake agent that answers, then hangs until the completion timeout ends it. */
export const answeringAgent = () =>
  fakeAgent({
    lines: [
      INIT,
      JSON.stringify({
        type: "result",
        is_error: false,
        result: '<answer>{"answer": 42}</answer>',
      }),
    ],
    hang: true,
  });

/** A fake agent that starts, then hangs: a session still running. */
export const hangingAgent = () => fakeAgent({ lines: [INIT], hang: true });

const BWRAP = NATIVE_PROVIDERS.find((p) => p.name === "bwrap()");

/** Whether the bwrap() suites skip here: off Linux, or without a working bwrap outside CI. */
export const bwrapSkipsHere = (): boolean => {
  if (BWRAP === undefined) {
    throw new Error("NATIVE_PROVIDERS has no bwrap() entry");
  }
  return skipsHere(BWRAP);
};

const SEATBELT = NATIVE_PROVIDERS.find((p) => p.name === "seatbelt()");

/** Whether the seatbelt() suites skip here: off macOS, or without a working sandbox-exec outside CI. */
export const seatbeltSkipsHere = (): boolean => {
  if (SEATBELT === undefined) {
    throw new Error("NATIVE_PROVIDERS has no seatbelt() entry");
  }
  return skipsHere(SEATBELT);
};
