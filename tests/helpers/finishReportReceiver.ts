import { once } from "node:events";
import { readdir, readFile, readlink } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { FakeSandboxProvider } from "@ai-hero/sandcastle/v1/testing";

// A local HTTP server standing in for a finish-report receiver, and what a
// detach test reads from a fake sandbox's session supervisor. POSIX only.

/** One POST the receiver got. */
export interface Delivery {
  readonly headers: Record<string, string>;
  readonly body: string;
}

const flatHeaders = (headers: IncomingHttpHeaders): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).flatMap(([key, value]) =>
      typeof value === "string" ? [[key, value]] : [],
    ),
  );

/** A receiver that answers with `statuses` in turn, then 200, always with `Retry-After: 0`. */
export const finishReportReceiver = async (
  statuses: readonly number[] = [],
) => {
  const deliveries: Delivery[] = [];
  const arrivals = new EventTarget();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const status = statuses[deliveries.length] ?? 200;
      deliveries.push({
        headers: flatHeaders(request.headers),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(status, { "retry-after": "0" }).end();
      arrivals.dispatchEvent(new Event("delivery"));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the receiver has no port");
  }
  const received = async (count: number): Promise<Delivery[]> => {
    if (deliveries.length >= count) {
      return deliveries;
    }
    await once(arrivals, "delivery");
    return received(count);
  };
  return {
    url: `http://127.0.0.1:${address.port}/finished`,
    deliveries,
    /** Resolves once `count` deliveries have arrived. */
    received,
    /** The first delivery, once it has arrived. */
    first: async (): Promise<Delivery> => {
      const [delivery] = await received(1);
      if (delivery === undefined) {
        throw new Error("no delivery");
      }
      return delivery;
    },
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
};

/** A finish-report receiver. */
export type FinishReportReceiver = Awaited<
  ReturnType<typeof finishReportReceiver>
>;

/** The session supervisor's directory in a fake sandbox. */
export const supervisorDir = (
  provider: FakeSandboxProvider,
  sandboxId: string,
): string =>
  path.join(
    provider.pathOf(sandboxId),
    "home",
    ".sandcastle",
    "supervisor",
    sandboxId,
  );

/** Resolves once the supervisor's log reports its finish report as `outcome`. */
export const supervisorSays = async (
  provider: FakeSandboxProvider,
  sandboxId: string,
  outcome: "delivered" | "gone" | "written",
): Promise<void> => {
  const log = path.join(supervisorDir(provider, sandboxId), "supervisor.log");
  const poll = async (triesLeft: number): Promise<void> => {
    const text = await readFile(log, "utf8").catch(() => "");
    if (text.includes(`: ${outcome}`)) {
      return;
    }
    if (triesLeft === 0) {
      throw new Error(`the supervisor never said "${outcome}"`);
    }
    await delay(50);
    await poll(triesLeft - 1);
  };
  await poll(200);
};

/** The env and argv of each process whose working directory is `dir` (Linux /proc). */
export const procfsOf = async (dir: string): Promise<string[]> => {
  const entries = await readdir("/proc");
  const pids = entries.filter((name) => /^\d+$/u.test(name));
  const found = await Promise.all(
    pids.map(async (pid) => {
      const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => "");
      return cwd === dir
        ? Promise.all(
            ["environ", "cmdline"].map(async (file) =>
              readFile(`/proc/${pid}/${file}`, "utf8").catch(() => ""),
            ),
          )
        : [];
    }),
  );
  return found.flat();
};

/** The host's PATH, for a session that must still find `sh` and friends. */
export const hostPath = (): string => process.env.PATH ?? "/usr/bin:/bin";
