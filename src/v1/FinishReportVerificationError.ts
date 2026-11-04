import { Data } from "effect";

/** Why `verifyFinishReport` rejected a finish report. */
export type FinishReportVerificationFailure =
  | "missing-headers"
  | "bad-signature"
  | "stale-timestamp"
  | "malformed-body"
  | "output-invalid";

interface FinishReportVerificationErrorArgs {
  readonly message: string;
  readonly reason: FinishReportVerificationFailure;
  readonly cause?: unknown;
}

class FinishReportVerificationErrorImpl extends Data.TaggedError(
  "FinishReportVerificationError",
)<FinishReportVerificationErrorArgs> {}

/** `verifyFinishReport` rejects with this when a report can't be trusted or doesn't parse. */
export interface FinishReportVerificationError extends Error {
  readonly _tag: "FinishReportVerificationError";
  /**
   * - `missing-headers`: no `webhook-id`, `webhook-timestamp` or `webhook-signature`.
   * - `bad-signature`: the signature doesn't match the body and secret.
   * - `stale-timestamp`: signed too long ago (or too far ahead).
   * - `malformed-body`: signed correctly, but not a finish report.
   * - `output-invalid`: a session's structured output fails its `Output` definition.
   */
  readonly reason: FinishReportVerificationFailure;
  /** What went wrong underneath, e.g. the schema's issues for `output-invalid`. */
  readonly cause?: unknown;
}

interface FinishReportVerificationErrorConstructor {
  new (args: FinishReportVerificationErrorArgs): FinishReportVerificationError;
  readonly prototype: FinishReportVerificationError;
}

/** `verifyFinishReport` rejects with this when a report can't be trusted or doesn't parse. */
export const FinishReportVerificationError: FinishReportVerificationErrorConstructor =
  FinishReportVerificationErrorImpl;
