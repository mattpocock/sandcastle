import type { Effect } from "effect";

export type Severity = "info" | "success" | "warn" | "error";

export type DisplayEntry =
  | { readonly _tag: "intro"; readonly title: string }
  | {
      readonly _tag: "status";
      readonly message: string;
      readonly severity: Severity;
    }
  | { readonly _tag: "spinner"; readonly message: string }
  | {
      readonly _tag: "summary";
      readonly title: string;
      readonly rows: Record<string, string>;
    }
  | {
      readonly _tag: "taskLog";
      readonly title: string;
      readonly messages: readonly string[];
    }
  | { readonly _tag: "text"; readonly message: string }
  | { readonly _tag: "textChunk"; readonly message: string }
  | {
      readonly _tag: "toolCall";
      readonly name: string;
      readonly formattedArgs: string;
    };

export interface DisplayService {
  readonly intro: (title: string) => Effect.Effect<void>;

  readonly status: (message: string, severity: Severity) => Effect.Effect<void>;

  readonly spinner: <A, E, R>(
    message: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;

  readonly summary: (
    title: string,
    rows: Record<string, string>,
  ) => Effect.Effect<void>;

  readonly taskLog: <A, E, R>(
    title: string,
    effect: (message: (msg: string) => void) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;

  readonly text: (message: string) => Effect.Effect<void>;

  /**
   * Writes a raw streaming chunk with no implied line break. Used for
   * token-by-token agent output, where consecutive chunks must flow together
   * as contiguous prose rather than each landing on its own line.
   */
  readonly textChunk: (chunk: string) => Effect.Effect<void>;

  readonly toolCall: (
    name: string,
    formattedArgs: string,
  ) => Effect.Effect<void>;
}
