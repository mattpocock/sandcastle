import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

// Runs tests/helpers/holdHostSandbox.ts in a separate Node process, which
// makes a host() sandbox in `rootDir` with a command running forever in it,
// and then ends with that work still running: by exiting, or by `SIGTERM`.

const TSX_LOADER = pathToFileURL(
  createRequire(import.meta.url).resolve("tsx"),
).href;
const TESTS_TSCONFIG = path.join(import.meta.dirname, "..", "tsconfig.json");
/** A script handed to a subprocess, not an import. */
const HOLDER = path.join(import.meta.dirname, "holdHostSandbox.ts");

const Held = z.object({ folder: z.string() });

/** How the holding process ends. */
export type HolderEnding = "exit" | "SIGTERM";

/**
 * Starts the holder, and resolves with its sandbox's folder once the
 * command in it has written its pid to `pidFile` and the holder has ended
 * as `ending` says.
 */
export const holdThenEnd = async (
  rootDir: string,
  pidFile: string,
  ending: HolderEnding,
): Promise<string> => {
  const child = spawn(
    process.execPath,
    [
      "--import",
      TSX_LOADER,
      HOLDER,
      rootDir,
      pidFile,
      ending === "exit" ? "exit" : "wait",
    ],
    {
      env: { ...process.env, TSX_TSCONFIG_PATH: TESTS_TSCONFIG },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const exited = once(child, "exit");
  const received: unknown[] = await once(child.stdout, "data");
  const { folder } = Held.parse(JSON.parse(String(received[0])));
  if (ending === "SIGTERM") {
    child.kill("SIGTERM");
  }
  await exited;
  return folder;
};
