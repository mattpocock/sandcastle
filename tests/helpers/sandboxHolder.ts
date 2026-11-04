import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * tsx's loader as a file URL, and the tests' tsconfig, whose `paths` point
 * the package names at src: a separate Node process then loads Sandcastle
 * the way these tests do, without a build.
 */
const TSX_LOADER = pathToFileURL(
  createRequire(import.meta.url).resolve("tsx"),
).href;
const TESTS_TSCONFIG = path.join(import.meta.dirname, "..", "tsconfig.json");
/** A script handed to a subprocess, not an import. */
const HOLDER = path.join(import.meta.dirname, "holdNativeSandbox.ts");

/**
 * Starts a separate Node process (tests/helpers/holdNativeSandbox.ts) that
 * opens the named provider's sandbox on `repo` and starts `sleep <seconds>`
 * in it, and resolves once it has called `exec`. Nothing in that process
 * closes the sandbox: the caller kills it.
 */
export const spawnSandboxHolder = async (
  providerName: string,
  repo: string,
  seconds: string,
): Promise<ChildProcess> => {
  const holder = spawn(
    process.execPath,
    ["--import", TSX_LOADER, HOLDER, providerName, repo, seconds],
    {
      env: { ...process.env, TSX_TSCONFIG_PATH: TESTS_TSCONFIG },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  holder.stdout.setEncoding("utf8");
  holder.stderr.setEncoding("utf8");
  holder.stderr.on("data", (chunk: string) => {
    output += chunk;
  });
  const exited = once(holder, "exit").then(() => {
    throw new Error(`The sandbox holder exited early:\n${output}`);
  });
  const ready = (async (): Promise<void> => {
    for await (const chunk of holder.stdout) {
      output += String(chunk);
      if (output.includes("ready")) {
        return;
      }
    }
  })();
  await Promise.race([ready, exited]);
  return holder;
};
