import type { IterationResult } from "./Orchestrator.js";

const RUN_ABORT_METADATA = Symbol.for("@ai-hero/sandcastle/run-abort-metadata");

export interface RunAbortMetadata {
  readonly iterations: IterationResult[];
}

const isObjectLike = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

export const attachAbortMetadata = (
  reason: unknown,
  metadata: RunAbortMetadata,
): void => {
  if (!isObjectLike(reason)) return;
  Object.defineProperty(reason, RUN_ABORT_METADATA, {
    value: metadata,
    configurable: true,
    enumerable: false,
    writable: true,
  });
};

export const getAbortMetadata = (
  error: unknown,
): RunAbortMetadata | undefined => {
  if (!isObjectLike(error)) return undefined;
  const metadata = error[RUN_ABORT_METADATA];
  if (
    typeof metadata === "object" &&
    metadata !== null &&
    Array.isArray((metadata as RunAbortMetadata).iterations)
  ) {
    return metadata as RunAbortMetadata;
  }
  return undefined;
};
