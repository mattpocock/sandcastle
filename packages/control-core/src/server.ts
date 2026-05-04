import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { URL } from "node:url";
import {
  zPostQuestForgeEngageRequest,
  zPostQuestForgeParseRequest,
  zPostReposRequest,
  zPostRunDecisionRequest,
  zPostRunsRequest,
} from "@sandcastle/protocol";
import type { FleetState } from "@sandcastle/protocol";
import { ActivityFeed } from "./activity/ActivityFeed.js";
import { resolveToken } from "./auth/token.js";
import { DeckLoader } from "./deck/DeckLoader.js";
import { BudgetExceededError } from "./fleet/FleetBudgetService.js";
import { OperativeStore } from "./operatives/OperativeStore.js";
import { SnapshotProjector } from "./projector/SnapshotProjector.js";
import { QuestForgeParser } from "./quest-forge/QuestForgeParser.js";
import { RepoRegistry } from "./repos/RepoRegistry.js";
import { RunSupervisor } from "./runs/RunSupervisor.js";
import { SqliteStore } from "./telemetry/SqliteStore.js";
import { TelemetryIndexer } from "./telemetry/TelemetryIndexer.js";
import { WsHub } from "./ws/WsHub.js";
import { XpLedger } from "./xp/XpLedger.js";

export interface StartServerOptions {
  readonly port?: number;
  readonly token?: string;
  readonly repo?: string;
  readonly runSupervisor?: RunSupervisor;
  readonly repoRegistry?: RepoRegistry;
  readonly store?: SqliteStore;
  readonly deckLoader?: DeckLoader;
  readonly operativeStore?: OperativeStore;
}

export type startServerOptions = StartServerOptions;

export interface AppContext {
  readonly token: string;
  readonly repoRegistry: RepoRegistry;
  readonly runSupervisor: RunSupervisor;
  readonly store: SqliteStore;
  readonly deckLoader: DeckLoader;
  readonly operativeStore: OperativeStore;
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
  const operativeStore = options?.operativeStore ?? new OperativeStore();
  const runSupervisor =
    options?.runSupervisor ??
    new RunSupervisor({ repoRoot: repoRegistry.root, store, operativeStore });
  const deckLoader = options?.deckLoader ?? new DeckLoader();
  const snapshotProjector = new SnapshotProjector(
    repoRegistry,
    runSupervisor,
    deckLoader,
    operativeStore,
  );
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
      store,
      deckLoader,
      operativeStore,
      snapshotProjector,
    });
  };

  return {
    token,
    repoRegistry,
    runSupervisor,
    store,
    deckLoader,
    operativeStore,
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
  readonly store: SqliteStore;
  readonly deckLoader: DeckLoader;
  readonly operativeStore: OperativeStore;
  readonly snapshotProjector: SnapshotProjector;
}): Promise<void> => {
  const { req, res } = ctx;

  // CORS: the bearer token gates every real route, so the origin reflection
  // is safe — without it the @sandcastle/web build cannot reach the local
  // control server from a different port. Preflight short-circuits before
  // auth so browsers can probe the endpoint with a token they haven't
  // sent yet.
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "access-control-allow-headers",
      req.headers["access-control-request-headers"] ??
        "authorization, content-type",
    );
    res.setHeader("access-control-max-age", "600");
    res.writeHead(204);
    res.end();
    return;
  }

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

    if (req.method === "POST" && url.pathname === "/quest-forge/parse") {
      const body = zPostQuestForgeParseRequest.parse(await readJson(req));
      writeJson(res, 200, {
        phases: new QuestForgeParser().parse(body.directive),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/quest-forge/engage") {
      const body = zPostQuestForgeEngageRequest.parse(await readJson(req));
      writeJson(res, 200, await ctx.runSupervisor.startPhasedRun(body));
      return;
    }

    if (req.method === "POST" && url.pathname === "/merge-all-green") {
      writeJson(res, 200, await ctx.runSupervisor.mergeAllGreen());
      return;
    }

    if (req.method === "GET" && url.pathname === "/repos") {
      writeJson(res, 200, { repos: ctx.repoRegistry.listRepos() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/repos") {
      const body = zPostReposRequest.parse(await readJson(req));
      const repo = ctx.repoRegistry.registerRepo(body.root);
      writeJson(res, 200, repo);
      return;
    }

    const repoMatch = url.pathname.match(/^\/repos\/([^/]+)$/);
    if (req.method === "DELETE" && repoMatch) {
      writeJson(res, 200, {
        removed: ctx.repoRegistry.removeRepo(decodeURIComponent(repoMatch[1]!)),
      });
      return;
    }

    const repoDeckMatch = url.pathname.match(/^\/repos\/([^/]+)\/deck$/);
    if (req.method === "GET" && repoDeckMatch) {
      const repo = ctx.repoRegistry.getRepoById(
        decodeURIComponent(repoDeckMatch[1]!),
      );
      if (!repo) {
        writeJson(res, 404, {
          error: { code: "NOT_FOUND", message: "Repo not found" },
        });
        return;
      }
      writeJson(res, 200, ctx.deckLoader.loadDeck(repo.root));
      return;
    }

    const repoTelemetryMatch = url.pathname.match(
      /^\/repos\/([^/]+)\/telemetry$/,
    );
    if (req.method === "GET" && repoTelemetryMatch) {
      const repo = ctx.repoRegistry.getRepoById(
        decodeURIComponent(repoTelemetryMatch[1]!),
      );
      if (!repo) {
        writeJson(res, 404, {
          error: { code: "NOT_FOUND", message: "Repo not found" },
        });
        return;
      }
      const telemetryStore =
        repo.root === ctx.repoRegistry.root
          ? ctx.store
          : new SqliteStore(repo.root);
      try {
        writeJson(
          res,
          200,
          await new TelemetryIndexer(telemetryStore).getTelemetry(repo, {
            force: url.searchParams.get("force") === "true",
          }),
        );
      } finally {
        if (telemetryStore !== ctx.store) telemetryStore.close();
      }
      return;
    }

    const repoActivityMatch = url.pathname.match(
      /^\/repos\/([^/]+)\/activity$/,
    );
    if (req.method === "GET" && repoActivityMatch) {
      const repo = ctx.repoRegistry.getRepoById(
        decodeURIComponent(repoActivityMatch[1]!),
      );
      if (!repo) {
        writeJson(res, 404, {
          error: { code: "NOT_FOUND", message: "Repo not found" },
        });
        return;
      }
      const activityStore =
        repo.root === ctx.repoRegistry.root
          ? ctx.store
          : new SqliteStore(repo.root);
      try {
        writeJson(res, 200, {
          events: new ActivityFeed(activityStore).getRecent(
            repo.root,
            Number(url.searchParams.get("limit") ?? 50),
          ),
        });
      } finally {
        if (activityStore !== ctx.store) activityStore.close();
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/operatives") {
      writeJson(res, 200, {
        operatives: ctx.operativeStore.listIdentities(),
      });
      return;
    }

    const operativeMatch = url.pathname.match(/^\/operatives\/([^/]+)$/);
    if (req.method === "GET" && operativeMatch) {
      const id = decodeURIComponent(operativeMatch[1]!);
      const identity = ctx.operativeStore.getIdentity(id);
      if (!identity) {
        writeJson(res, 404, {
          error: { code: "NOT_FOUND", message: "Operative not found" },
        });
        return;
      }
      const repoRecord = ctx.operativeStore.getRepoRecord(
        ctx.repoRegistry.root,
        id,
      );
      writeJson(res, 200, repoRecord ? { ...identity, repoRecord } : identity);
      return;
    }

    const operativeXpMatch = url.pathname.match(/^\/operatives\/([^/]+)\/xp$/);
    if (req.method === "GET" && operativeXpMatch) {
      const id = decodeURIComponent(operativeXpMatch[1]!);
      writeJson(res, 200, new XpLedger(ctx.store).getOperativeXp(id));
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

    const decideMatch = url.pathname.match(/^\/runs\/([^/]+)\/decide$/);
    if (req.method === "POST" && decideMatch) {
      const runId = decodeURIComponent(decideMatch[1]!);
      const body = zPostRunDecisionRequest.parse(await readJson(req));
      const result = await ctx.runSupervisor.decideRun(runId, body);
      if (!result) {
        writeJson(res, 404, {
          error: { code: "NOT_FOUND", message: "Run not found" },
        });
        return;
      }
      writeJson(res, 200, result);
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
    if (error instanceof BudgetExceededError) {
      writeJson(res, 429, { error: error.toJSON() });
      return;
    }
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
