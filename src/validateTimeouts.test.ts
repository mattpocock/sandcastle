import { describe, expect, it } from "vitest";
import { validateTimeoutOptions } from "./validateTimeouts.js";

describe("validateTimeoutOptions", () => {
  it("accepts unset options and positive values", () => {
    expect(() => {
      validateTimeoutOptions({});
    }).not.toThrow();
    expect(() => {
      validateTimeoutOptions({
        idleTimeoutSeconds: 0.1,
        completionTimeoutSeconds: 5,
        timeouts: {
          copyToWorktreeMs: 1,
          gitSetupMs: 10_000,
          commitCollectionMs: 30_000,
          mergeToHostMs: 30_000,
        },
      });
    }).not.toThrow();
  });

  it.each([0, -1, Number.NaN])(
    "rejects idleTimeoutSeconds: %s, naming the option",
    (value) => {
      expect(() => {
        validateTimeoutOptions({ idleTimeoutSeconds: value });
      }).toThrow(
        `idleTimeoutSeconds must be a positive number of seconds. Received: ${value}`,
      );
    },
  );

  it.each([0, -1, Number.NaN])(
    "rejects completionTimeoutSeconds: %s, naming the option",
    (value) => {
      expect(() => {
        validateTimeoutOptions({ completionTimeoutSeconds: value });
      }).toThrow(
        `completionTimeoutSeconds must be a positive number of seconds. Received: ${value}`,
      );
    },
  );

  it.each([
    "copyToWorktreeMs",
    "gitSetupMs",
    "commitCollectionMs",
    "mergeToHostMs",
  ] as const)("rejects timeouts.%s of 0, -1 or NaN", (key) => {
    for (const value of [0, -1, Number.NaN]) {
      expect(() => {
        validateTimeoutOptions({ timeouts: { [key]: value } });
      }).toThrow(
        `timeouts.${key} must be a positive number of milliseconds. Received: ${value}`,
      );
    }
  });

  it("rejects a non-number from untyped callers", () => {
    expect(() => {
      validateTimeoutOptions({
        idleTimeoutSeconds: "30" as unknown as number,
      });
    }).toThrow("idleTimeoutSeconds must be a positive number of seconds");
  });
});
