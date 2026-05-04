import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { URL } from "node:url";
import { resolve } from "node:path";
import { zPostRunsRequest } from "@sandcastle/protocol";
import type { FleetState } from "@sandcastle/protocol";
import { resolveToken } from "./auth/token.js";
import { SnapshotProjector } from "./projector/SnapshotProjector.js";
import { RepoRegistry } from "./repos/RepoRegistry.js";
import { RunSupervisor } from "./runs/RunSupervisor.js";
import { SqliteStore } from "./telemetry/SqliteStore.js";
import { WsHub } from "./ws/WsHub.js";

export interface StartServerOptions {
  readonly port?: number;
  readonly token?: string;
  readonly repo?: string;
  readonly runSupervisor?: RunSupervisor;
  readonly repoRegistry?: RepoRegistry;
  readonly store?: SqliteStore;
}

export type startServerOptions = StartServerOptions;

export interface AppContext {
  readonly token: string;
  readonly repoRegistry: RepoRegistry;
  readonly runSupervisor: RunSupervisor;
  readonly store: SqliteStore;
  readonly snapshotProjector: SnapshotProjector;
  readonly wsHub: WsHub;
  readonly handle: (req: IncomingMessage, res: ServerResponse) => void;
  readonly close: () => void;
}

export interface StartedServer {
  readonly port: number;
  readonly token: string;
  readonly pid: number;
  readonly server: Server;
  readonly app: AppContext;
  readonly close: () => Promise<void>;
}

export const createApp = (options?: StartServerOptions): AppContext => {
  const token = resolveToken(options?.token);
  const repoRegistry =
    options?.repoRegistry ?? new RepoRegistry(options?.repo ?? process.cwd());
  const store = options?.store ?? new SqliteStore(repoRegistry.root);
  const runSupervisor =
    options?.runSupervisor ??
    new RunSupervisor({ repoRoot: repoRegistry.root, store });
  const snapshotProjector = new SnapshotProjector(repoRegistry, runSupervisor);
  const wsHub = new WsHub({
    getFleetSnapshot: () => snapshotProjector.getFleetState(),
  });
  runSupervisor.subscribe((runId, event) => wsHub.publish(runId, event));

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    void handleRequest({
      req,
      res,
      token,
      repoRegistry,
      runSupervisor,
      snapshotProjector,
    });
  };

  return {
    token,
    repoRegistry,
    runSupervisor,
    store,
    snapshotProjector,
    wsHub,
    handle,
    close: () => {
      wsHub.close();
      store.close();
    },
  };
};

export const startServer = async (
  options?: StartServerOptions,
): Promise<StartedServer> => {
  const app = createApp(options);
  const server = createServer(app.handle);
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "127.0.0.1"}`,
    );
    if (url.searchParams.get("token") !== app.token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    app.wsHub.wss.handleUpgrade(req, socket, head, (ws) => {
      app.wsHub.wss.emit("connection", ws, req);
    });
  });

  await new Promise<void>((resolveListen) => {
    server.listen(options?.port ?? 0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Failed to bind control server");
  return {
    port: address.port,
    token: app.token,
    pid: process.pid,
    server,
    app,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        app.close();
        server.close((error) => (error ? reject(error) : resolveClose()));
      }),
  };
};

const handleRequest = async (ctx: {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly token: string;
  readonly repoRegistry: RepoRegistry;
  readonly runSupervisor: RunSupervisor;
  readonly snapshotProjector: SnapshotProjector;
}): Promise<void> => {
  const { req, res } = ctx;
  if (!isAuthorized(req, ctx.token)) {
    writeJson(res, 401, {
      error: {
        code: "UNAUTHORIZED",
        message: "Missing or invalid bearer token",
      },
    });
    return;
  }

  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "127.0.0.1"}`,
  );
  try {
    if (req.method === "POST" && url.pathname === "/runs") {
      const body = zPostRunsRequest.parse(await readJson(req));
      writeJson(res, 200, await ctx.runSupervisor.startRun(body));
      return;
    }

    const cancelMatch = url.pathname.match(/^\/runs\/([^/]+)\/cancel$/);
    if (req.method === "POST" && cancelMatch) {
      const runId = decodeURIComponent(cancelMatch[1]!);
      writeJson(res, 200, {
        runId,
        cancelled: ctx.runSupervisor.cancelRun(runId),
      });
      return;
    }

    const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
    if (req.method === "GET" && runMatch) {
      const run = ctx.runSupervisor.getRun(decodeURIComponent(runMatch[1]!));
      if (!run) {
        writeJson(res, 404, {
          error: { code: "NOT_FOUND", message: "Run not found" },
        });
        return;
      }
      writeJson(res, 200, run);
      return;
    }

    if (req.method === "GET" && url.pathname === "/fleet") {
      const fleet: FleetState = await ctx.snapshotProjector.getFleetState();
      writeJson(res, 200, fleet);
      return;
    }

    if (req.method === "GET" && url.pathname === "/repo") {
      const repo = await ctx.repoRegistry.getRepo();
      writeJson(res, 200, { root: repo.root, branch: repo.branch });
      return;
    }

    writeJson(res, 404, {
      error: { code: "NOT_FOUND", message: "Route not found" },
    });
  } catch (error) {
    writeJson(res, 400, {
      error: {
        code: "BAD_REQUEST",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
};

const isAuthorized = (req: IncomingMessage, token: string): boolean =>
  req.headers.authorization === `Bearer ${token}`;

const readJson = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
};

const writeJson = (
  res: ServerResponse,
  status: number,
  body: unknown,
): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
