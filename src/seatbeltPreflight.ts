/**
 * The `seatbelt()` construction check (src/sandboxes/seatbelt.ts): can this
 * host run a Seatbelt sandbox, and if not, why. Runs once per process. Used
 * only by `seatbelt()`.
 *
 * Synchronous on purpose: `seatbelt()` is a synchronous constructor, and it
 * must throw before anything else (a worktree, a temp dir) exists.
 */

/* oxlint-disable node/no-sync -- seatbelt() throws at construction, which is synchronous (allowlisted in scripts/lint-ratchet-config.ts). */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { release } from "node:os";
import { NativeSandboxUnavailableError } from "./NativeSandboxUnavailableError.js";

/** The system `sandbox-exec`, always by absolute path, never one found on `PATH`. */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Darwin 23 is macOS 14, the oldest macOS `seatbelt()` supports. */
const MIN_DARWIN_MAJOR = 23;

const USE_DOCKER = "Use docker() instead.";

/** Runs a trivial profile; returns why it failed, or undefined when it works. */
const probe = (): string | undefined => {
  if (!existsSync(SANDBOX_EXEC)) {
    return `seatbelt() needs macOS's ${SANDBOX_EXEC}, and it's missing. ${USE_DOCKER}`;
  }
  const result = spawnSync(
    SANDBOX_EXEC,
    ["-p", "(version 1)(allow default)", "--", "/usr/bin/true"],
    { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 30_000 },
  );
  if (result.status === 0) {
    return undefined;
  }
  const stderr = (result.stderr ?? "").trim();
  const reason =
    stderr === ""
      ? (result.error?.message ?? `exit code ${String(result.status)}`)
      : stderr;
  const nested = /Operation not permitted/iu.test(stderr)
    ? " This process may already be inside a Seatbelt sandbox, and macOS refuses to nest them."
    : "";
  return `seatbelt() can't start a sandbox: \`${SANDBOX_EXEC}\` failed: ${reason}.${nested} ${USE_DOCKER}`;
};

const check = (): string | undefined => {
  if (process.platform !== "darwin") {
    return "seatbelt() needs macOS; on Linux or WSL2 use bwrap()";
  }
  const major = Number(release().split(".")[0]);
  if (Number.isFinite(major) && major < MIN_DARWIN_MAJOR) {
    return `seatbelt() needs macOS 14 or later. ${USE_DOCKER}`;
  }
  return probe();
};

let outcome: { readonly unavailable: string | undefined } | undefined;

/**
 * Throws `NativeSandboxUnavailableError` when this host can't run a Seatbelt
 * sandbox. There's no install command on macOS, so the error never has a
 * `fixCommand`. Checks on the first call only; later calls give the same
 * answer.
 */
export const assertSeatbeltUsable = (): void => {
  outcome ??= { unavailable: check() };
  if (outcome.unavailable !== undefined) {
    throw new NativeSandboxUnavailableError({
      message: outcome.unavailable,
    });
  }
};
