import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Engine } from "./engines.js";

/**
 * tsx's loader as a file URL, and the tests' tsconfig, whose `paths` point
 * the package names at src: the holder loads Sandcastle the way these tests
 * do, without a build.
 */
const TSX_LOADER = pathToFileURL(
  createRequire(import.meta.url).resolve("tsx"),
).href;
const TESTS_TSCONFIG = path.join(
  import.meta.dirname,
  "..",
  "..",
  "tsconfig.json",
);
/** A script handed to a subprocess, not an import. */
const HOLDER = path.join(import.meta.dirname, "holdContainerSandbox.ts");

/** A holder process and the container it holds open. */
export interface ContainerHolder {
  readonly process: ChildProcess;
  readonly containerName: string;
}

/**
 * Starts a separate Node process (holdContainerSandbox.ts) that opens a
 * sandbox from `image` on `dir`, and resolves with its container's name once
 * the container is up. Nothing in that process closes the sandbox.
 */
export const spawnContainerHolder = async (
  engine: Engine,
  image: string,
  dir: string,
): Promise<ContainerHolder> => {
  const holder = spawn(
    process.execPath,
    ["--import", TSX_LOADER, HOLDER, engine, image, dir],
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
  const exited = once(holder, "exit").then((): never => {
    throw new Error(`The container holder exited early:\n${output}`);
  });
  const ready = (async (): Promise<string> => {
    for await (const chunk of holder.stdout) {
      output += String(chunk);
      const name = /ready (?<name>\S+)/u.exec(output)?.groups?.["name"];
      if (name !== undefined) {
        return name;
      }
    }
    throw new Error(`The container holder never got ready:\n${output}`);
  })();
  const containerName = await Promise.race([ready, exited]);
  return { process: holder, containerName };
};
