import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Data, Effect, Either } from "effect";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { LoggingOption } from "./run.js";
import {
  agentMapPage,
  agentMapScript,
  agentMapStyles,
} from "./AgentMapPage.js";

export class DashboardError extends Data.TaggedError("DashboardError")<{
  message: string;
  cause?: unknown;
}> {}

const decisionSchema = z.object({
  id: z.string(),
  disposition: z.string(),
  reason: z.string(),
  likelyAreas: z.array(z.string()),
  conflictsWith: z.array(z.string()).optional(),
});
const agentRoles = [
  "planner",
  "implementer",
  "reviewer",
  "merger",
  "readiness",
] as const;
const roleSchema = z.enum(agentRoles);
const nodeStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "blocked",
  "stopped",
  "failed",
  "skipped",
  "interrupted",
  "unknown",
]);
const sessionStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "interrupted",
  "unknown",
]);
const nodeSchema = z.object({
  id: z.string(),
  batch: z.number(),
  role: roleSchema,
  title: z.string(),
  issueId: z.string().optional(),
  branch: z.string(),
  status: nodeStatusSchema,
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  error: z.string().optional(),
  sessionId: z.string().optional(),
  commits: z.array(z.string()).default([]),
  usage: z
    .object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      cacheReadInputTokens: z.number(),
      cacheCreationInputTokens: z.number(),
    })
    .optional(),
  activity: z
    .array(
      z.object({ type: z.string(), text: z.string(), timestamp: z.string() }),
    )
    .default([]),
});

const resultSchema = z.object({
  branch: z.string().optional(),
  completionSignal: z.string().optional(),
  commits: z.array(z.object({ sha: z.string() })).optional(),
  iterations: z
    .array(
      z.object({
        sessionId: z.string().optional(),
        usage: nodeSchema.shape.usage,
      }),
    )
    .optional(),
});

/** Metadata locating an agent in the batch graph. */
export interface AgentMapTask {
  /** One-based batch number. */
  readonly batch: number;
  /** Workflow role, not a provider-native subagent relationship. */
  readonly role: (typeof agentRoles)[number];
  /** Tracker ID, absent for planner and merger. */
  readonly issueId?: string;
  /** Short task description. */
  readonly title: string;
  /** Source branch. */
  readonly branch: string;
  /** Provider-reported model, when known. */
  readonly model?: string;
  /** Agent provider name, when known. */
  readonly provider?: string;
}
const snapshotSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: sessionStatusSchema,
  startedAt: z.string(),
  updatedAt: z.string(),
  batches: z.array(
    z.object({ number: z.number(), decisions: z.array(decisionSchema) }),
  ),
  nodes: z.array(nodeSchema),
});

/** Selected tasks and the planner's explanation for every candidate. */
export interface AgentMapPlan {
  /** Tasks selected for this batch. */
  readonly issues: readonly {
    /** Tracker issue ID. */
    id: string;
    /** Short issue description. */
    title: string;
    /** Branch selected for implementation. */
    branch: string;
  }[];
  /** Decisions including blocked and deferred candidates. */
  readonly decisions: readonly {
    /** Tracker issue ID. */
    id: string;
    /** Planner classification, e.g. selected, blocked, parallel-conflict or unresolved-decision. */
    disposition: string;
    /** Human-readable explanation of this selection or deferral. */
    reason: string;
    /** Repository paths or subsystem names likely to change. */
    likelyAreas: readonly string[];
    /** Tracker IDs of issues whose overlapping work prevents parallel execution. */
    conflictsWith?: readonly string[];
  }[];
}

/** Persistent, host-side observation of one orchestration session. */
export interface AgentMap {
  /** Unique session identifier; each invocation has its own history. */
  readonly id: string;
  /** Record a validated plan and queue its implementer, reviewer and merger nodes. */
  recordPlan(batch: number, plan: AgentMapPlan): Promise<void>;
  /** Observe an agent call; pass the provided logging option to run(). Original return values and errors are preserved. */
  track<T>(
    task: AgentMapTask,
    execute: (logging: LoggingOption) => Promise<T>,
  ): Promise<T>;
  /** Mark nodes that never started as skipped when a batch ends. */
  finishBatch(batch: number): Promise<void>;
  /** End recording; this does not stop or resume any agent. */
  finish(status: "completed" | "failed"): Promise<void>;
}

const storeDirectory = (cwd: string) =>
  join(resolve(cwd), ".sandcastle", "runs");

// Best-effort filtering of common credentials in snapshots (not full run logs).
// Arbitrary agent text can still contain sensitive data: the dashboard is local-only.
const redact = (text: string): string =>
  text
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer <REDACTED>")
    .replace(
      /\b((?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)|api[_-]?key|password)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1<REDACTED>",
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, "$1<REDACTED>@")
    .slice(0, 4000);

/** Create an agent-map recording under the host project's .sandcastle/runs/. */
export const createAgentMap = (options: {
  /** Host repository directory. */
  cwd: string;
  /** Human-readable session name. */
  name: string;
}): Promise<AgentMap> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = storeDirectory(options.cwd);
      const now = new Date().toISOString();
      const state: z.infer<typeof snapshotSchema> = {
        id: randomUUID(),
        name: options.name,
        status: "running",
        startedAt: now,
        updatedAt: now,
        batches: [],
        nodes: [],
      };
      const lock = yield* Effect.makeSemaphore(1);
      const save = lock.withPermits(1)(
        Effect.gen(function* () {
          yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
          state.updatedAt = new Date().toISOString();
          const file = join(directory, `${state.id}.json`);
          const temporary = `${file}.${randomUUID()}.tmp`;
          yield* fs.writeFileString(temporary, JSON.stringify(state), {
            mode: 0o600,
          });
          yield* fs.rename(temporary, file);
        }),
      );
      let warned = false;
      let recordingAvailable = true;
      const publish = save.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            recordingAvailable = true;
          }),
        ),
        Effect.catchAll(() =>
          Effect.sync(() => {
            recordingAvailable = false;
            if (!warned)
              console.warn(
                "Agent map recording unavailable; agent execution continues.",
              );
            warned = true;
          }),
        ),
      );
      yield* publish;
      const heartbeat = setInterval(() => {
        void Effect.runPromise(publish);
      }, 2000);
      heartbeat.unref();
      const skipQueued = (batch?: number) => {
        for (const node of state.nodes) {
          if (
            node.status === "queued" &&
            (batch === undefined || node.batch === batch)
          )
            node.status = "skipped";
        }
      };
      return {
        id: state.id,
        recordPlan: (batch, plan) =>
          Effect.runPromise(
            Effect.gen(function* () {
              state.batches.push({
                number: batch,
                decisions: plan.decisions.map((d) => ({
                  ...d,
                  reason: redact(d.reason),
                  likelyAreas: d.likelyAreas.map(redact),
                  conflictsWith: d.conflictsWith && [...d.conflictsWith],
                })),
              });
              for (const issue of plan.issues) {
                for (const role of ["implementer", "reviewer"] as const) {
                  state.nodes.push({
                    id: `${batch}:${role}:${issue.id}`,
                    batch,
                    role,
                    issueId: issue.id,
                    title: redact(issue.title),
                    branch: issue.branch,
                    status: "queued",
                    activity: [],
                    commits: [],
                  });
                }
              }
              if (plan.issues.length)
                state.nodes.push({
                  id: `${batch}:merger`,
                  batch,
                  role: "merger",
                  title: "Integrate batch",
                  branch: "",
                  status: "queued",
                  activity: [],
                  commits: [],
                });
              yield* publish;
            }),
          ),
        track: <T>(
          task: AgentMapTask,
          execute: (logging: LoggingOption) => Promise<T>,
        ) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const key = `${task.batch}:${task.role}${task.issueId ? `:${task.issueId}` : ""}`;
              let node = state.nodes.find(
                (n) => n.id === key && n.status === "queued",
              );
              if (!node) {
                node = {
                  ...task,
                  title: redact(task.title),
                  id: state.nodes.some((n) => n.id === key)
                    ? `${key}:${randomUUID()}`
                    : key,
                  status: "queued",
                  activity: [],
                  commits: [],
                };
                state.nodes.push(node);
              }
              Object.assign(node, task, {
                title: redact(task.title),
                status: "running",
                startedAt: new Date().toISOString(),
              });
              const active = node;
              yield* publish;
              const result = yield* Effect.tryPromise({
                try: () =>
                  execute(
                    recordingAvailable
                      ? {
                          type: "file",
                          path: join(
                            directory,
                            `${state.id}-${randomUUID()}.log`,
                          ),
                          onAgentStreamEvent: (event) => {
                            if (event.type === "raw") return;
                            active.activity.push({
                              type: event.type,
                              timestamp: event.timestamp.toISOString(),
                              text: redact(
                                event.type === "text"
                                  ? event.message
                                  : `${event.name}: ${event.formattedArgs}`,
                              ),
                            });
                            if (active.activity.length > 150)
                              active.activity.shift();
                          },
                        }
                      : { type: "stdout" },
                  ),
                catch: (cause) =>
                  new DashboardError({
                    message: "Agent execution failed",
                    cause,
                  }),
              }).pipe(Effect.either);
              active.endedAt = new Date().toISOString();
              if (Either.isLeft(result)) {
                active.status = "failed";
                active.error = redact(String(result.left.cause));
              } else {
                const parsed = resultSchema.safeParse(result.right);
                const signal = parsed.success
                  ? parsed.data.completionSignal
                  : undefined;
                active.status = signal?.includes("BLOCKED")
                  ? "blocked"
                  : signal?.includes("COMPLETE") || task.role === "planner"
                    ? "completed"
                    : "stopped";
                if (parsed.success) {
                  active.branch = parsed.data.branch || active.branch;
                  active.commits = parsed.data.commits?.map((c) => c.sha) ?? [];
                  const last = parsed.data.iterations?.at(-1);
                  active.usage = parsed.data.iterations
                    ?.filter((iteration) => iteration.usage !== undefined)
                    .at(-1)?.usage;
                  active.sessionId = last?.sessionId;
                }
              }
              yield* publish;
              return result;
            }),
          ).then((result) => {
            if (Either.isLeft(result)) throw result.left.cause;
            return result.right;
          }),
        finishBatch: (batch) =>
          Effect.runPromise(
            Effect.gen(function* () {
              skipQueued(batch);
              yield* publish;
            }),
          ),
        finish: (status) =>
          Effect.runPromise(
            Effect.gen(function* () {
              clearInterval(heartbeat);
              state.status = status;
              skipQueued();
              yield* publish;
            }),
          ),
      } satisfies AgentMap;
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

/** Address and cleanup for the read-only host dashboard. */
export interface DashboardServer {
  /** Loopback URL to open in a browser. */
  readonly url: string;
  /** Close the HTTP listener and active connections. */
  close(): Promise<void>;
}

/** Serve recorded sessions on loopback only; no Docker connection is required. */
export const startDashboard = (options: {
  /** Host project whose .sandcastle/runs directory is displayed. */
  cwd: string;
  /** TCP port; 0 requests a free port. */
  port: number;
}): Promise<DashboardServer> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = storeDirectory(options.cwd);
      const read = (name: string) =>
        fs.readFileString(join(directory, name)).pipe(
          Effect.flatMap((text) =>
            Effect.try({
              try: () => snapshotSchema.parse(JSON.parse(text)),
              catch: (cause) =>
                new DashboardError({ message: "Invalid recording", cause }),
            }),
          ),
          Effect.map((snapshot) => {
            if (
              snapshot.status === "running" &&
              Date.now() - Date.parse(snapshot.updatedAt) > 15_000
            ) {
              snapshot.status = "unknown";
              for (const node of snapshot.nodes)
                if (node.status === "running") node.status = "unknown";
              return { ...snapshot, heartbeat: "stale" as const };
            }
            return { ...snapshot, heartbeat: "fresh" as const };
          }),
        );
      const server = createServer((request, response) => {
        void Effect.runPromise(
          Effect.gen(function* () {
            response.setHeader("Cache-Control", "no-store");
            response.setHeader("X-Content-Type-Options", "nosniff");
            response.setHeader(
              "Content-Security-Policy",
              "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
            );
            response.setHeader(
              "Content-Type",
              "application/json; charset=utf-8",
            );
            const address = server.address();
            const port =
              address && typeof address !== "string" ? address.port : -1;
            const host = request.headers.host;
            if (
              (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) ||
              (request.headers.origin &&
                request.headers.origin !== `http://${host}`)
            ) {
              response.writeHead(403);
              response.end();
              return;
            }
            const url = yield* Effect.try({
              try: () => new URL(request.url ?? "/", "http://127.0.0.1"),
              catch: (cause) =>
                new DashboardError({ message: "Invalid request", cause }),
            });
            if (request.method !== "GET") {
              response.writeHead(405);
              response.end();
              return;
            }
            const asset =
              url.pathname === "/"
                ? ["text/html", agentMapPage]
                : url.pathname === "/app.js"
                  ? ["text/javascript", agentMapScript]
                  : url.pathname === "/style.css"
                    ? ["text/css", agentMapStyles]
                    : undefined;
            if (asset) {
              response.setHeader("Content-Type", `${asset[0]}; charset=utf-8`);
              response.end(asset[1]);
              return;
            }
            if (url.pathname === "/api/runs") {
              const files = yield* fs
                .readDirectory(directory)
                .pipe(Effect.catchAll(() => Effect.succeed([] as string[])));
              const runs = yield* Effect.all(
                files
                  .filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))
                  .map((f) => read(f).pipe(Effect.option)),
              );
              response.end(
                JSON.stringify({
                  runs: runs
                    .flatMap((r) =>
                      r._tag === "Some"
                        ? [
                            {
                              id: r.value.id,
                              name: r.value.name,
                              status: r.value.status,
                              startedAt: r.value.startedAt,
                              updatedAt: r.value.updatedAt,
                            },
                          ]
                        : [],
                    )
                    .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
                }),
              );
            } else {
              const match = /^\/api\/runs\/([a-f0-9-]{36})$/.exec(url.pathname);
              if (!match) {
                response.writeHead(404);
                response.end();
                return;
              }
              const run = yield* read(`${match[1]}.json`);
              response.end(JSON.stringify(run));
            }
          }).pipe(
            Effect.catchAll(() =>
              Effect.sync(() => {
                response.writeHead(404);
                response.end();
              }),
            ),
          ),
        );
      });
      yield* Effect.async<void, DashboardError>((resume) => {
        server.once("error", (cause) =>
          resume(
            Effect.fail(
              new DashboardError({ message: "Cannot start dashboard", cause }),
            ),
          ),
        );
        server.listen(options.port, "127.0.0.1", () => resume(Effect.void));
      });
      const address = server.address();
      if (!address || typeof address === "string")
        return yield* Effect.fail(
          new DashboardError({ message: "Missing dashboard address" }),
        );
      return {
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          Effect.runPromise(
            Effect.async<void>((resume) => {
              server.closeAllConnections();
              server.close(() => resume(Effect.void));
            }),
          ),
      } satisfies DashboardServer;
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
