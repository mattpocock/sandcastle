/**
 * Fails a test file that leaves processes running.
 *
 * Each test file gets its own `TMPDIR` inside the run's (see
 * src/testGlobalSetup.ts), so everything it makes under `tmpdir()` names that
 * directory. Once the file's tests are done, any live process whose command
 * line still names it was left behind: an agent the session supervisor put in
 * a process group of its own, say, that outlived its sandbox. Left running,
 * such processes pile up over runs and slow every later test.
 *
 * The check kills what it finds, by process group, so one failing run doesn't
 * load the next. It fails only the v1 suites (`tests/v1-*`): the 0.x `bwrap()`
 * tests sometimes leave a `bwrap` behind for a while after `close()`, which
 * is 0.x's to fix, so other files get a warning. Runs in each e2e worker, via
 * vitest `setupFiles`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, expect } from "vitest";
import type { HostProcess } from "./processTree.js";
import { listProcesses } from "./processTree.js";

// A worker runs several files, and each sets TMPDIR for the next: keep the
// run's directory, so the files' directories sit side by side in it. "f-" is
// FILE_DIR_PREFIX in src/testGlobalSetup.ts, short for a reason given there.
process.env.SANDCASTLE_TEST_RUN_TMPDIR ??= tmpdir();
const runTmpdir = process.env.SANDCASTLE_TEST_RUN_TMPDIR;
const fileTmpdir = mkdtempSync(path.join(runTmpdir, "f-"));
process.env.TMPDIR = fileTmpdir;

/** How long a process killed by the file's last cleanup gets to go. */
const SETTLE_MS = 5000;
const POLL_MS = 100;

const leftBehind = (): readonly HostProcess[] =>
  listProcesses().filter(
    ({ pid, args }) =>
      pid !== process.pid && args.includes(`${fileTmpdir}${path.sep}`),
  );

const settled = async (
  deadline = Date.now() + SETTLE_MS,
): Promise<readonly HostProcess[]> => {
  const left = leftBehind();
  if (left.length === 0 || Date.now() > deadline) {
    return left;
  }
  await delay(POLL_MS);
  return settled(deadline);
};

const kill = (target: number): void => {
  try {
    process.kill(target, "SIGKILL");
  } catch {
    // Already gone.
  }
};

afterAll(async () => {
  if (process.platform === "win32") {
    return;
  }
  const left = await settled();
  if (left.length === 0) {
    return;
  }
  const ownGroup = listProcesses().find(({ pid }) => pid === process.pid)?.pgid;
  for (const { pid, pgid } of left) {
    kill(pgid === ownGroup ? pid : -pgid);
  }
  const message = [
    `This file left ${left.length} process${left.length === 1 ? "" : "es"} running ` +
      "(now killed). Close every sandbox a test opens, and kill what its " +
      "processes started:",
    ...left
      .slice(0, 3)
      .map(({ pid, args }) => `  ${pid}: ${args.slice(0, 400)}`),
  ].join("\n");
  const file = expect.getState().testPath ?? "";
  if (!path.basename(file).startsWith("v1-")) {
    console.warn(message);
    return;
  }
  throw new Error(message);
}, SETTLE_MS + 5000);
