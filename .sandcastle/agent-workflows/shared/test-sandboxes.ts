import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// The providers the workflows' sandbox runs on (shared/sandbox.ts), for the
// tests that run each case on both. bwrap() is skipped off Linux and where
// Bubblewrap can't run, but fails rather than skips when CI is set: the ci
// job installs it, so a broken install shows up there.

/** A provider `WORKFLOW_SANDBOX` names, and whether its tests skip here. */
export interface WorkflowSandboxCase {
  readonly name: "host" | "bwrap";
  readonly skip: boolean;
}

const bwrapRuns = (): boolean =>
  spawnSync("bwrap", ["--ro-bind", "/", "/", "true"], { stdio: "ignore" })
    .status === 0;

const ciIsSet = (): boolean =>
  process.env.CI !== undefined && process.env.CI !== "";

/** Each provider, `host` first. host() is POSIX-only in these tests. */
export const WORKFLOW_SANDBOXES: readonly WorkflowSandboxCase[] = [
  { name: "host", skip: process.platform === "win32" },
  {
    name: "bwrap",
    skip: process.platform !== "linux" || (!ciIsSet() && !bwrapRuns()),
  },
];

/**
 * Points `openSandbox()` at `name` for one test, with a short
 * `XDG_STATE_HOME` of its own (bwrap()'s keeper socket path has room for
 * only 107 characters). Returns the cleanup.
 */
export const useWorkflowSandbox = async (
  name: WorkflowSandboxCase["name"],
): Promise<() => Promise<void>> => {
  const state = await mkdtemp(path.join(tmpdir(), "st-"));
  process.env.WORKFLOW_SANDBOX = name;
  process.env.XDG_STATE_HOME = state;
  return async () => rm(state, { recursive: true, force: true });
};
