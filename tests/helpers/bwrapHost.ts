import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";

// What the bwrap() tests look at from the host (its processes and files),
// and a separate Node process that creates a sandbox and detaches from it.
// Linux only (it reads /proc).

export const exists = async (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

/** The host processes whose command line holds `text`. */
export const processesMentioning = async (text: string): Promise<string[]> => {
  const entries = await readdir("/proc");
  const pids = entries.filter((name) => /^\d+$/u.test(name));
  const lines = await Promise.all(
    pids.map(async (pid) =>
      readFile(`/proc/${pid}/cmdline`, "utf8").then(
        (line) => (line.includes(text) ? [pid] : []),
        () => [],
      ),
    ),
  );
  return lines.flat();
};

/** Resolves once `check` holds, polling; rejects after `ms`. */
export const eventually = async (
  check: () => Promise<boolean>,
  ms: number,
): Promise<void> => {
  if (await check()) {
    return;
  }
  if (ms <= 0) {
    throw new Error("still not true");
  }
  await sleep(200);
  await eventually(check, ms - 200);
};

/** tsx's loader and the tests' tsconfig, so a separate Node process loads Sandcastle from src. */
const TSX_LOADER = pathToFileURL(
  createRequire(import.meta.url).resolve("tsx"),
).href;
const TESTS_TSCONFIG = path.join(import.meta.dirname, "..", "tsconfig.json");
/** A script handed to a subprocess, not an import. */
const DETACHER = path.join(import.meta.dirname, "detachBwrapSandbox.ts");

const Receipt = z.object({ sandboxId: z.string(), detachId: z.string() });

/**
 * Runs tests/helpers/detachBwrapSandbox.ts in a separate Node process, which
 * creates a sandbox, detaches with a finish report to `url` signed with
 * `secret`, and exits; resolves with its receipt once it has exited.
 */
export const detachFromNewProcess = async (
  url: string,
  secret: string,
): Promise<z.infer<typeof Receipt>> => {
  const child = spawn(
    process.execPath,
    ["--import", TSX_LOADER, DETACHER, url, secret],
    {
      env: { ...process.env, TSX_TSCONFIG_PATH: TESTS_TSCONFIG },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  await once(child, "exit");
  if (child.exitCode !== 0) {
    throw new Error(
      `the detaching process exited ${String(child.exitCode)}:\n${stderr}`,
    );
  }
  return Receipt.parse(JSON.parse(stdout));
};
/** Whether a host process's command line holds `text`. */
export const someProcessMentions = async (text: string): Promise<boolean> => {
  const pids = await processesMentioning(text);
  return pids.length > 0;
};

/** Whether `file` is gone. */
export const isGone = async (file: string): Promise<boolean> => {
  const there = await exists(file);
  return !there;
};
