import { DateTime, Either, Schema } from "effect";
import type { OutputDefinition } from "./Output.js";
import type {
  FinishReport,
  OutputMap,
  SessionReport,
  VerifyFinishReportOptions,
} from "./FinishReport.js";
import { FinishReportVerificationError } from "./FinishReportVerificationError.js";
import { FinishReportJson } from "./finishReportSchema.js";
import { signatureMatches, signingKey } from "./webhookSignature.js";

const DEFAULT_TOLERANCE_SECONDS = 300;

const decodeReport = Schema.decodeUnknownEither(FinishReportJson);

const reject = (
  reason: FinishReportVerificationError["reason"],
  message: string,
  cause?: unknown,
): FinishReportVerificationError =>
  new FinishReportVerificationError({
    message: `Finish report rejected: ${message}`,
    reason,
    ...(cause === undefined ? {} : { cause }),
  });

const header = (
  headers: VerifyFinishReportOptions["headers"],
  name: string,
): string | undefined => {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name,
  )?.[1];
  return typeof entry === "string" ? entry : entry?.[0];
};

/** Checks the signature and timestamp; throws when either is wrong. */
const checkSignature = (options: VerifyFinishReportOptions): string => {
  const id = header(options.headers, "webhook-id");
  const timestamp = header(options.headers, "webhook-timestamp");
  const signature = header(options.headers, "webhook-signature");
  if (id === undefined || timestamp === undefined || signature === undefined) {
    throw reject(
      "missing-headers",
      "it needs webhook-id, webhook-timestamp and webhook-signature headers",
    );
  }
  const key = signingKey(options.secret);
  if (key === undefined) {
    throw new TypeError(
      "verifyFinishReport: secret must be a Standard Webhooks secret: `whsec_` plus base64, or bare base64",
    );
  }
  if (
    !signatureMatches(key, { id, timestamp, body: options.body }, signature)
  ) {
    throw reject(
      "bad-signature",
      "its signature doesn't match the body and secret",
    );
  }
  const age = DateTime.unsafeNow().epochMillis / 1000 - Number(timestamp);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (!Number.isFinite(age) || Math.abs(age) > tolerance) {
    throw reject(
      "stale-timestamp",
      `it was signed ${Math.round(age)} seconds ago, outside the ${tolerance}-second tolerance`,
    );
  }
  return id;
};

/** A session's output, validated against its definition. */
const validOutput = async (
  session: SessionReport,
  definition: OutputDefinition,
): Promise<unknown> => {
  const { output, name } = session;
  if (definition._tag === "string") {
    if (typeof output !== "string") {
      throw reject("output-invalid", `session "${name}" has no string output`);
    }
    return output;
  }
  const validated = await definition.schema["~standard"].validate(output);
  if (validated.issues !== undefined) {
    throw reject(
      "output-invalid",
      `session "${name}"'s output <${definition.tag}> fails its schema`,
      validated.issues,
    );
  }
  return validated.value;
};

/** True when the session ended well, so its output, if any, is its result. */
const endedWell = (session: SessionReport): boolean =>
  session.exitReason === "completed" || session.exitReason === "closing-tag";

/**
 * The report's sessions, with each named in `outputs` validated. On a
 * succeeded report every one must be there; on a failed one, only the
 * sessions that ended well with an output are validated.
 */
const typedSessions = async (
  report: FinishReport,
  outputs: OutputMap,
): Promise<Record<string, SessionReport>> => {
  const { sessions } = report.data;
  const succeeded = report.data.status === "succeeded";
  const validated = await Promise.all(
    Object.entries(outputs).map(async ([name, definition]) => {
      const session = sessions[name];
      if (session === undefined) {
        if (succeeded) {
          throw reject("output-invalid", `it has no session named "${name}"`);
        }
        return [];
      }
      if (!succeeded && (!endedWell(session) || session.output === undefined)) {
        return [[name, { ...session, output: undefined }] as const];
      }
      const output = await validOutput(session, definition);
      return [[name, { ...session, output }] as const];
    }),
  );
  return { ...sessions, ...Object.fromEntries(validated.flat()) };
};

/**
 * Checks a finish report's Standard Webhooks signature and timestamp, and
 * returns it parsed. Pass `outputs`, the same `Output` definitions you gave
 * the sessions, by session name, to validate each one's structured output
 * and get it typed. On a failed report, only the sessions that ended well
 * with an output are validated; the rest have `undefined`. Rejects with
 * `FinishReportVerificationError`. Replays inside the tolerance window
 * aren't caught here: dedupe on `data.detachId`.
 */
export async function verifyFinishReport<const O extends OutputMap>(
  options: VerifyFinishReportOptions & { readonly outputs: O },
): Promise<FinishReport<O>>;
export async function verifyFinishReport(
  options: VerifyFinishReportOptions,
): Promise<FinishReport>;
export async function verifyFinishReport(
  options: VerifyFinishReportOptions & { readonly outputs?: OutputMap },
): Promise<FinishReport> {
  const id = checkSignature(options);
  const decoded = decodeReport(options.body);
  if (Either.isLeft(decoded)) {
    throw reject(
      "malformed-body",
      "its body isn't a finish report",
      decoded.left,
    );
  }
  const report: FinishReport = {
    ...decoded.right,
    data: {
      ...decoded.right.data,
      sessions: Object.fromEntries(
        Object.entries(decoded.right.data.sessions).map(([name, session]) => [
          name,
          { ...session, output: session.output },
        ]),
      ),
    },
  };
  if (report.data.detachId !== id) {
    throw reject("malformed-body", "its detach id isn't its webhook-id");
  }
  const sessions = await typedSessions(report, options.outputs ?? {});
  return { ...report, data: { ...report.data, sessions } };
}
