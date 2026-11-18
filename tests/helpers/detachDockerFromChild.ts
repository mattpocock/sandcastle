import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Runs tests/helpers/detachDocker.ts in a separate Node process: it creates a
// docker() (or podman()) sandbox, starts a session, detaches with a finish report and
// exits. What it made then has only the container to keep it going.

const TSX_LOADER = pathToFileURL(
  createRequire(import.meta.url).resolve("tsx"),
).href;
const TESTS_TSCONFIG = path.join(import.meta.dirname, "..", "tsconfig.json");
/** A script handed to a subprocess, not an import. */
const SCRIPT = path.join(import.meta.dirname, "detachDocker.ts");

/** What the child process detached from. */
export interface DetachedInChild {
  readonly sandboxId: string;
  readonly detachId: string;
}

const isDetached = (value: unknown): value is DetachedInChild =>
  typeof value === "object" &&
  value !== null &&
  "sandboxId" in value &&
  typeof value.sandboxId === "string" &&
  "detachId" in value &&
  typeof value.detachId === "string";

/**
 * Creates and detaches from a docker() sandbox (or a podman() one, with
 * `engine: "podman"`) in a child process (with this process's env, so the
 * same CLI on PATH), and resolves once that process has exited.
 */
export const detachDockerFromChild = async (options: {
  readonly engine?: "docker" | "podman";
  readonly image: string;
  readonly url: string;
  readonly secret: string;
}): Promise<DetachedInChild> => {
  const child = spawn(
    process.execPath,
    [
      "--import",
      TSX_LOADER,
      SCRIPT,
      options.engine ?? "docker",
      options.image,
      options.url,
      options.secret,
    ],
    {
      env: { ...process.env, TSX_TSCONFIG_PATH: TESTS_TSCONFIG },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited: Promise<unknown[]> = once(child, "exit");
  const [code] = await exited;
  const last = stdout.trim().split("\n").at(-1) ?? "";
  const parsed: unknown = code === 0 ? JSON.parse(last) : undefined;
  if (!isDetached(parsed)) {
    throw new Error(
      `the detaching process failed (exit ${String(code)}):\n${stdout}\n${stderr}`,
    );
  }
  return parsed;
};
