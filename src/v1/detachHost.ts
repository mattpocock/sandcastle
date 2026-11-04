import { randomUUID } from "node:crypto";
import { DateTime } from "effect";
import { DetachError } from "./DetachError.js";
import type { DetachOptions, DetachReceipt } from "./Sandbox.js";
import type { ProviderSandbox } from "./SandboxProvider.js";
import { SandboxDetachedError } from "./SandboxDetachedError.js";
import { sealSecret } from "./sealedSecret.js";
import type { SupervisorLink } from "./supervisorHost.js";
import type { DetachRequest } from "./supervisorProtocol.js";
import { signingKey } from "./webhookSignature.js";

// Host side of `detach()`: checks it can let go, hands the running sessions
// to the supervisor with the deadline and the sealed finish-report secret,
// and lets go once the supervisor confirms it holds them (ADR 0028).

const MARGIN_MINUTES = 5;

/**
 * The default deadline: the kill time minus a margin to deliver the report.
 * The margin is 5 minutes, or a quarter of the time limit when that's
 * shorter, so a seconds-long sandbox still gets a deadline before its end.
 */
export const defaultDeadlineMs = (
  killTime: Date,
  timeLimitMinutes: number,
): number =>
  killTime.getTime() - Math.min(MARGIN_MINUTES, timeLimitMinutes / 4) * 60_000;

/** What `detach()` needs from the handle. */
export interface DetachContext {
  readonly sandbox: ProviderSandbox;
  readonly link: SupervisorLink;
  readonly timeLimitMinutes: number;
  /** A bundled task's default deadline for this handle, if one started on it. */
  readonly taskDeadline: () => number | undefined;
  /** Awaited calls on the handle that haven't settled. */
  readonly pendingCalls: () => number;
  /** Sessions the host is following. */
  readonly runningSessions: () => number;
  /** Called once the supervisor holds the work: the handle lets go. */
  readonly letGo: (error: SandboxDetachedError) => void;
}

const checkOptions = (options: DetachOptions): void => {
  const { deadlineMinutes, finishReport } = options;
  if (
    deadlineMinutes !== undefined &&
    (!Number.isFinite(deadlineMinutes) || deadlineMinutes <= 0)
  ) {
    throw new RangeError(
      `detach: deadlineMinutes must be a positive number, got ${deadlineMinutes}`,
    );
  }
  if (finishReport === undefined) {
    return;
  }
  const protocol = URL.canParse(finishReport.url)
    ? new URL(finishReport.url).protocol
    : "";
  if (protocol !== "https:" && protocol !== "http:") {
    throw new TypeError(
      "detach: finishReport.url must be an http: or https: URL",
    );
  }
  if (signingKey(finishReport.secret) === undefined) {
    throw new TypeError(
      "detach: finishReport.secret must be a Standard Webhooks secret: `whsec_` plus base64, or bare base64",
    );
  }
};

const refuse = (
  reason: DetachError["reason"],
  message: string,
  cause?: unknown,
): DetachError =>
  new DetachError({
    message: `Can't detach: ${message}`,
    reason,
    ...(cause === undefined ? {} : { cause }),
  });

const checkReady = (context: DetachContext): void => {
  if (context.pendingCalls() > 0) {
    throw refuse(
      "awaited-call-pending",
      "an awaited call on the handle hasn't settled. Detach once it has, or spawn the work instead.",
    );
  }
  if (context.runningSessions() === 0) {
    throw refuse(
      "nothing-running",
      "no spawned session is running, so nothing would carry on. Close the sandbox instead.",
    );
  }
};

/** Asks the supervisor to carry the work on; resolves with what it holds. */
const handOver = async (
  context: DetachContext,
  request: DetachRequest,
  abortSignal: AbortSignal | undefined,
): Promise<readonly { readonly name: string; readonly agent: string }[]> => {
  let carried: readonly { name: string; agent: string }[] | undefined;
  let problem = "it didn't answer";
  await context.link
    .call(
      request,
      (reply) => {
        if (reply.type === "detached") {
          carried = reply.carriedOn;
        } else if (reply.type === "error") {
          problem = reply.message;
        }
      },
      abortSignal,
    )
    .catch((error: unknown) => {
      abortSignal?.throwIfAborted();
      throw refuse(
        "supervisor-unreachable",
        "the session supervisor didn't confirm it holds the work",
        error,
      );
    });
  abortSignal?.throwIfAborted();
  if (carried === undefined) {
    throw refuse(
      "supervisor-unreachable",
      `the session supervisor refused: ${problem}`,
    );
  }
  if (carried.length === 0) {
    throw refuse(
      "nothing-running",
      "every session had already ended, so nothing would carry on.",
    );
  }
  return carried;
};

/** The supervisor's detach request, and the deadline as the host's clock has it. */
const detachRequest = (
  context: DetachContext,
  options: DetachOptions,
): { readonly request: DetachRequest; readonly deadline: number } => {
  const { sandbox } = context;
  const now = DateTime.unsafeNow().epochMillis;
  const latest = defaultDeadlineMs(sandbox.killTime, context.timeLimitMinutes);
  const deadline =
    options.deadlineMinutes === undefined
      ? Math.min(latest, context.taskDeadline() ?? latest)
      : Math.min(latest, now + options.deadlineMinutes * 60_000);
  const { finishReport } = options;
  const request: DetachRequest = {
    type: "detach",
    detachId: randomUUID(),
    sandboxId: sandbox.sandboxId,
    deadlineMs: Math.max(0, deadline - now),
    giveUpMs: Math.max(0, sandbox.killTime.getTime() - now),
    ...(finishReport === undefined
      ? {}
      : {
          finishReport: {
            url: finishReport.url,
            sealedSecret: sealSecret(
              context.link.publicKey,
              finishReport.secret,
            ),
          },
        }),
  };
  return { request, deadline };
};

/** `detach()` for one handle. */
export const detachFrom =
  (context: DetachContext) =>
  async (options: DetachOptions = {}): Promise<DetachReceipt> => {
    checkOptions(options);
    options.abortSignal?.throwIfAborted();
    checkReady(context);
    const { sandboxId } = context.sandbox;
    const { request, deadline } = detachRequest(context, options);
    const { detachId } = request;
    const carried = await handOver(context, request, options.abortSignal);
    context.letGo(
      new SandboxDetachedError({
        message: `Sandbox ${sandboxId} was detached from (detach ${detachId}): its work carries on without this handle, and its result arrives in the finish report.`,
        sandboxId,
        detachId,
      }),
    );
    return {
      sandboxId,
      detachId,
      deadline: DateTime.toDateUtc(DateTime.unsafeMake(deadline)),
      carriedOn: carried.map(({ name, agent }) => ({
        kind: "session",
        name,
        agent,
      })),
      reportsTo: options.finishReport?.url ?? false,
    };
  };
