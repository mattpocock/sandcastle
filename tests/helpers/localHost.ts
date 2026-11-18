import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import type { Server } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";

// What the local providers' (bwrap(), seatbelt()) tests look at from the
// host (its processes and files), and a separate Node process that creates
// a sandbox and detaches from it, and what seatbelt()'s run in a sandbox to
// see what it can reach. Linux (it reads /proc) and macOS (`ps`).

export const exists = async (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

/** On macOS, the host processes whose command line holds `text`, from `ps`. */
const psMentioning = async (text: string): Promise<string[]> => {
  const ps = spawn("/bin/ps", ["-A", "-ww", "-o", "pid=,command="], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let stdout = "";
  ps.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  await once(ps, "close");
  return stdout.split("\n").flatMap((line) => {
    const row = /^\s*(?<pid>\d+)\s+(?<command>.*)$/u.exec(line)?.groups;
    return row?.["command"]?.includes(text) === true ? [row["pid"] ?? ""] : [];
  });
};

/** The host processes whose command line holds `text`. */
export const processesMentioning = async (text: string): Promise<string[]> => {
  if (process.platform === "darwin") {
    return psMentioning(text);
  }
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
const DETACHER = path.join(import.meta.dirname, "detachLocalSandbox.ts");

const Receipt = z.object({ sandboxId: z.string(), detachId: z.string() });

/**
 * Runs tests/helpers/detachLocalSandbox.ts in a separate Node process, which
 * creates a `provider` sandbox, detaches with a finish report to `url` signed with
 * `secret`, and exits; resolves with its receipt once it has exited.
 */
export const detachFromNewProcess = async (
  provider: "bwrap" | "seatbelt",
  url: string,
  secret: string,
): Promise<z.infer<typeof Receipt>> => {
  const child = spawn(
    process.execPath,
    ["--import", TSX_LOADER, DETACHER, provider, url, secret],
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

/** `node -e` that connects to `target` (a port on 127.0.0.1, or a socket path): exit 0 if it can, 3 if not. */
export const connectCommand = (target: number | string): string => {
  const to =
    typeof target === "number"
      ? `${String(target)}, "127.0.0.1"`
      : JSON.stringify(target);
  return `node -e 'require("net").connect(${to}).on("connect", () => process.exit(0)).on("error", () => process.exit(3))'`;
};

/** `node -e` that looks up a public name: exit 0 if it resolves, 3 if not. */
export const LOOKUP =
  'node -e \'require("dns").lookup("github.com", (error) => process.exit(error ? 3 : 0))\'';

/** A TCP server on the host's loopback, to reach from a sandbox, and its port. */
export const hostListener = async (): Promise<{
  readonly server: Server;
  readonly port: number;
}> => {
  const server = createServer((socket) => {
    socket.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new TypeError("the listener has no port");
  }
  return { server, port: address.port };
};
