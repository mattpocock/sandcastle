import {
  planProjectMigration,
  applyProjectMigration,
  rollbackProjectMigration,
} from "./OperatorMigration.js";
import {
  planRuntimeUpdate,
  installRuntimeUpdate,
  rollbackRuntimeUpdate,
  claimRuntimeRun,
} from "./OperatorUpdates.js";
import { inspectWorkflow, saveWorkflowConfig } from "./OperatorWorkflow.js";
import { resolveEnv } from "./EnvResolver.js";
import { ensureProviderInstructions } from "./ReviewProviders.js";
import {
  inspectEnvironment,
  saveEnvironmentConfig,
  loadEnvironmentConfig,
  buildEnvironmentEffect,
  preflightEnvironmentEffect,
  type EnvironmentPolicy,
} from "./OperatorEnvironment.js";
import { loadProjectPrompts, saveProjectPrompt } from "./OperatorPrompts.js";
import { NodeFileSystem } from "@effect/platform-node";
import { Cause, Effect, Option, Runtime } from "effect";
import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import { startDashboard, type DashboardServer } from "./AgentMap.js";
import {
  codexCapability,
  providerCapabilities,
  loadRoleConfig,
  OperatorError,
  saveRoleConfig,
} from "./Operator.js";
import {
  createProjectRuntime,
  type ProjectRuntime,
  type ProjectRuntimeOptions,
} from "./OperatorRuntime.js";
import {
  operatorPage,
  operatorScript,
  operatorStyles,
} from "./operatorAssets.js";

/** Project-owned execution policy; HTTP can only request this fixed workflow. */
export interface OperatorProjectAdapter {
  /** Trusted Docker preflight declarations for custom project sandbox policy. */
  environment?: EnvironmentPolicy;
  /** Project prompt paths; never supplied by HTTP. */
  promptFiles: ProjectRuntimeOptions["promptFiles"];
  /** Resolve the sandbox identity before admitting the run. */
  sandboxIdentity(): Promise<string>;
  /** Run the project workflow with the already frozen runtime, preserving its gates. */
  run(runtime: ProjectRuntime): Promise<void>;
}
class RequestError extends OperatorError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super({ message });
  }
}
const requestBody = (request: IncomingMessage) =>
  Effect.tryPromise({
    try: async () => {
      if (request.headers["content-type"] !== "application/json")
        throw new RequestError(415, "Use Content-Type: application/json");
      let body = "";
      for await (const chunk of request) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 16_384)
          throw new RequestError(413, "Request exceeds 16 KiB");
      }
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new RequestError(400, "Invalid JSON request");
      }
    },
    catch: (error) =>
      error instanceof RequestError
        ? error
        : new RequestError(400, "Cannot read request body"),
  });
const attempt = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => {
      if (error instanceof OperatorError) return error;
      const failure = Runtime.isFiberFailure(error)
        ? Cause.failureOption(error[Runtime.FiberFailureCauseId])
        : Option.none();
      return Option.isSome(failure) && failure.value instanceof OperatorError
        ? failure.value
        : new OperatorError({
            message:
              "Project operation failed; check project paths, adapter and permissions",
          });
    },
  });
/** Serve an explicit project on loopback with session-protected mutations and read-only run observation. */
export const startOperator = (options: {
  /** Host project directory; requests cannot override it. */
  cwd: string;
  /** Loopback port; zero selects a free port. */
  port: number;
  /** Trusted project adapter, configured by the SDK caller. */
  adapter: OperatorProjectAdapter;
}): Promise<DashboardServer> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const cwd = resolve(options.cwd);
      yield* attempt(() => loadRoleConfig({ cwd }));
      const dashboard = yield* attempt(() => startDashboard({ cwd, port: 0 }));
      const token = randomBytes(32).toString("hex");
      type Job = {
        id: string;
        kind: "build" | "preflight";
        status:
          | "running"
          | "cancelling"
          | "promoting"
          | "completed"
          | "failed"
          | "cancelled";
        config: Awaited<ReturnType<typeof loadEnvironmentConfig>>;
        logs: string;
        identity?: string;
        error?: string;
      };
      type EnvironmentJob = {
        state: Job;
        controller: AbortController;
        listeners: Set<ServerResponse>;
        done: Promise<void>;
      };
      const jobs = new Map<string, EnvironmentJob>();
      const notify = (job: EnvironmentJob) => {
        for (const response of job.listeners) {
          if (response.writableLength > 131072) {
            response.destroy();
            continue;
          }
          response.write(`data: ${JSON.stringify(job.state)}\n\n`);
          if (
            !["running", "cancelling", "promoting"].includes(job.state.status)
          )
            response.end();
        }
      };
      type UpdateJob = {
        id: string;
        status: "running" | "completed" | "failed";
        logs: string[];
        error?: string;
      };
      let updateJob: UpdateJob | null = null;
      let updateDone = Promise.resolve();
      let running = false;
      let runDone = Promise.resolve();
      let current:
        | {
            runtime: ProjectRuntime;
            status: "running" | "completed" | "failed";
          }
        | undefined;
      const lock = yield* Effect.makeSemaphore(1);
      const server = createServer((request, response) => {
        void Effect.runPromise(
          Effect.gen(function* () {
            response.setHeader("Cache-Control", "no-store");
            response.setHeader("X-Content-Type-Options", "nosniff");
            response.setHeader(
              "Content-Security-Policy",
              "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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
            )
              return yield* Effect.fail(
                new RequestError(
                  403,
                  "Only the operator's local origin and host are allowed",
                ),
              );
            const url = yield* Effect.try({
              try: () => new URL(request.url ?? "/", "http://127.0.0.1"),
              catch: () => new RequestError(400, "Invalid request URL"),
            });
            if (url.search)
              return yield* Effect.fail(
                new RequestError(
                  400,
                  "Project and command overrides are not accepted",
                ),
              );
            const mutation = request.method !== "GET";
            if (
              mutation &&
              (request.headers.origin !== `http://${host}` ||
                !request.headers.cookie
                  ?.split(";")
                  .some(
                    (cookie) =>
                      cookie.trim() === `sandcastle-session-${port}=${token}`,
                  ))
            )
              return yield* Effect.fail(
                new RequestError(
                  403,
                  "Open the operator UI to establish a local session; send its exact Origin",
                ),
              );
            if (request.method === "GET" && url.pathname === "/") {
              response.setHeader(
                "Set-Cookie",
                `sandcastle-session-${port}=${token}; HttpOnly; SameSite=Strict; Path=/`,
              );
              response.setHeader("Content-Type", "text/html; charset=utf-8");
              response.end(operatorPage);
              return;
            }
            if (
              request.method === "GET" &&
              (url.pathname === "/app.js" || url.pathname === "/style.css")
            ) {
              response.setHeader(
                "Content-Type",
                url.pathname === "/app.js" ? "text/javascript" : "text/css",
              );
              response.end(
                url.pathname === "/app.js" ? operatorScript : operatorStyles,
              );
              return;
            }
            if (request.method === "GET" && url.pathname === "/dashboard") {
              response.writeHead(302, { Location: dashboard.url });
              response.end();
              return;
            }
            if (
              url.pathname === "/api/migrations/plan" &&
              request.method === "GET"
            ) {
              const plan = yield* attempt(() => planProjectMigration({ cwd }));
              const declaredEnv = yield* resolveEnv(cwd).pipe(
                Effect.provide(NodeFileSystem.layer),
              );
              const secrets = Object.entries({ ...process.env, ...declaredEnv })
                .filter(
                  ([key, value]) =>
                    /token|secret|password|api_key/i.test(key) && value,
                )
                .map(([, value]) => value!);
              const redactText = (value: string) => {
                for (const secret of secrets)
                  value = value.split(secret).join("[redacted]");
                return value.replace(
                  /([A-Za-z0-9_]*(?:token|secret|password|api_?key)[A-Za-z0-9_]*["']?\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/gi,
                  '$1"[redacted]"',
                );
              };
              const redactJson = (value: unknown): unknown => {
                if (typeof value === "string") return redactText(value);
                if (Array.isArray(value)) return value.map(redactJson);
                if (value && typeof value === "object")
                  return Object.fromEntries(
                    Object.entries(value).map(([key, item]) => [
                      key,
                      /token|secret|password|api_?key/i.test(key)
                        ? "[redacted]"
                        : redactJson(item),
                    ]),
                  );
                return value;
              };
              const redact = (value: string) => {
                // Decode managed JSON before redacting embedded prompt/source
                // strings, whose escaped quotes hide literals in the wire text.
                try {
                  const parsed: unknown = JSON.parse(value);
                  if (parsed && typeof parsed === "object")
                    return JSON.stringify(redactJson(parsed), null, 2);
                } catch {
                  // Workflow and Markdown files are plain text.
                }
                return redactText(value);
              };
              response.end(
                JSON.stringify({
                  ...plan,
                  files: plan.files.map((file) => ({
                    ...file,
                    before: file.before === null ? null : redact(file.before),
                    after: file.after === null ? null : redact(file.after),
                  })),
                  prompts: plan.prompts.map((prompt) => ({
                    ...prompt,
                    base: redact(prompt.base),
                    default: redact(prompt.default),
                    override: redact(prompt.override),
                  })),
                }),
              );
              return;
            }
            if (
              ["/api/migrations/apply", "/api/migrations/rollback"].includes(
                url.pathname,
              ) &&
              request.method === "POST"
            ) {
              const rollback = url.pathname.endsWith("/rollback");
              const body = yield* requestBody(request);
              const value = body as {
                revision: string;
                preserveOverrides: boolean;
              };
              const keys =
                body && typeof body === "object" && !Array.isArray(body)
                  ? Object.keys(body).sort().join(",")
                  : "invalid";
              if (
                keys !== (rollback ? "" : "preserveOverrides,revision") ||
                (!rollback &&
                  (typeof value.revision !== "string" ||
                    !/^[a-f0-9]{64}$/.test(value.revision) ||
                    typeof value.preserveOverrides !== "boolean"))
              )
                return yield* Effect.fail(
                  new RequestError(
                    400,
                    "Migration accepts only a reviewed revision and explicit prompt preservation; project paths and commands cannot be overridden",
                  ),
                );
              const result = yield* lock.withPermits(1)(
                Effect.gen(function* () {
                  if (running || updateJob?.status === "running")
                    return yield* Effect.fail(
                      new RequestError(
                        409,
                        "Active project run or runtime update; finish it before migration",
                      ),
                    );
                  if (rollback) {
                    yield* attempt(() => rollbackProjectMigration({ cwd }));
                    return { status: "rolled-back" };
                  }
                  return yield* attempt(() =>
                    applyProjectMigration({
                      cwd,
                      expectedRevision: value.revision,
                      preserveOverrides: value.preserveOverrides,
                      onProgress: () => {},
                    }),
                  );
                }),
              );
              response.end(JSON.stringify(result));
              return;
            }
            if (
              url.pathname === "/api/updates/job" &&
              request.method === "GET"
            ) {
              response.end(JSON.stringify({ job: updateJob }));
              return;
            }
            if (url.pathname === "/api/updates" && request.method === "GET") {
              response.end(
                JSON.stringify(
                  yield* attempt(() =>
                    planRuntimeUpdate({ cwd, version: null }),
                  ),
                ),
              );
              return;
            }
            if (
              [
                "/api/updates/plan",
                "/api/updates/install",
                "/api/updates/rollback",
              ].includes(url.pathname) &&
              request.method === "POST"
            ) {
              const body = yield* requestBody(request);
              const value = body as {
                version: string | null;
                revision: string;
              };
              const rollback = url.pathname.endsWith("/rollback"),
                install = url.pathname.endsWith("/install");
              const keys =
                body && typeof body === "object" && !Array.isArray(body)
                  ? Object.keys(body).sort().join(",")
                  : "invalid";
              if (
                keys !==
                  (rollback ? "" : install ? "revision,version" : "version") ||
                (!rollback &&
                  value.version !== null &&
                  typeof value.version !== "string") ||
                (install &&
                  (typeof value.revision !== "string" ||
                    !/^[a-f0-9]{64}$/.test(value.revision)))
              )
                return yield* Effect.fail(
                  new RequestError(
                    400,
                    "Updates accepts only selected version and reviewed revision; project identity and execution policy cannot be overridden",
                  ),
                );
              if (!install && !rollback) {
                const plan = yield* attempt(() =>
                  planRuntimeUpdate({ cwd, version: value.version }),
                );
                response.end(JSON.stringify(plan));
                return;
              }
              const state = yield* lock.withPermits(1)(
                Effect.gen(function* () {
                  if (running)
                    return yield* Effect.fail(
                      new RequestError(
                        409,
                        "Active project run; finish it before changing the installed runtime",
                      ),
                    );
                  if (updateJob?.status === "running")
                    return yield* Effect.fail(
                      new RequestError(
                        409,
                        "A runtime update job is already active",
                      ),
                    );
                  const state: UpdateJob = {
                    id: randomUUID(),
                    status: "running",
                    logs: [
                      rollback
                        ? "Restoring previous runtime"
                        : "Starting reviewed runtime installation",
                    ],
                  };
                  updateJob = state;
                  return state;
                }),
              );
              updateDone = Effect.runPromise(
                attempt(async () => {
                  if (rollback) await rollbackRuntimeUpdate({ cwd });
                  else
                    await installRuntimeUpdate({
                      cwd,
                      version: value.version,
                      expectedRevision: value.revision,
                      onProgress: (phase) => {
                        state.logs.push(phase);
                        state.logs = state.logs.slice(-20);
                      },
                    });
                }).pipe(
                  Effect.match({
                    onSuccess: () => {
                      state.status = "completed";
                      state.logs.push(
                        rollback
                          ? "Rollback completed"
                          : "Installation completed; restart the operator to load the installed runtime",
                      );
                    },
                    onFailure: (error) => {
                      state.status = "failed";
                      state.error = error.message;
                    },
                  }),
                ),
              );
              response.writeHead(202);
              response.end(JSON.stringify(state));
              return;
            }
            if (
              url.pathname === "/api/environment/jobs" &&
              request.method === "GET"
            ) {
              response.end(
                JSON.stringify({
                  jobs: [...jobs.values()].map((job) => job.state),
                }),
              );
              return;
            }
            if (
              url.pathname === "/api/environment/jobs" &&
              request.method === "POST"
            ) {
              const body = yield* requestBody(request);
              if (
                !body ||
                typeof body !== "object" ||
                Array.isArray(body) ||
                Object.keys(body).join(",") !== "kind" ||
                !["build", "preflight"].includes(
                  (body as { kind: string }).kind,
                )
              )
                return yield* Effect.fail(
                  new RequestError(
                    400,
                    "Job accepts exactly kind: build or preflight",
                  ),
                );
              const job = yield* lock.withPermits(1)(
                Effect.gen(function* () {
                  if (
                    [...jobs.values()].some((job) =>
                      ["running", "cancelling", "promoting"].includes(
                        job.state.status,
                      ),
                    )
                  )
                    return yield* Effect.fail(
                      new RequestError(
                        409,
                        "An environment job is already active",
                      ),
                    );
                  const config = yield* attempt(() =>
                    loadEnvironmentConfig({ cwd }),
                  );
                  const id = randomUUID();
                  const state: Job = {
                    id,
                    kind: (body as { kind: "build" | "preflight" }).kind,
                    status: "running",
                    config,
                    logs: "",
                  };
                  const job: EnvironmentJob = {
                    state,
                    controller: new AbortController(),
                    listeners: new Set<ServerResponse>(),
                    done: Promise.resolve(),
                  };
                  jobs.set(id, job);
                  return job;
                }),
              );
              const { state } = job;
              const { config, id } = state;
              // Retain a bounded session history; never evict the active job.
              if (jobs.size > 20) jobs.delete(jobs.keys().next().value!);
              const declaredEnv = yield* resolveEnv(cwd).pipe(
                Effect.provide(NodeFileSystem.layer),
              );
              const secrets = Object.entries({ ...process.env, ...declaredEnv })
                .filter(
                  ([key, value]) =>
                    /token|secret|password|api_key/i.test(key) &&
                    value &&
                    value.length > 0,
                )
                .flatMap(([, value]) =>
                  value!.split(/[\r\n]+/).filter(Boolean),
                );
              const onLog = (text: string) => {
                for (const secret of secrets)
                  text = text.split(secret).join("[redacted]");
                state.logs = (state.logs + text).slice(-65536);
                notify(job);
              };
              job.done = Effect.runPromise(
                (state.kind === "build"
                  ? buildEnvironmentEffect(
                      cwd,
                      config,
                      id,
                      job.controller.signal,
                      onLog,
                      () => {
                        state.status = "promoting";
                        notify(job);
                      },
                      secrets,
                    )
                  : preflightEnvironmentEffect(
                      cwd,
                      config,
                      id,
                      job.controller.signal,
                      onLog,
                      options.adapter.environment,
                    )
                ).pipe(
                  Effect.provide(NodeFileSystem.layer),
                  Effect.catchAllCause((cause) => {
                    const failure = Cause.failureOption(cause);
                    return Effect.fail(
                      Option.isSome(failure) &&
                        failure.value instanceof OperatorError
                        ? failure.value
                        : new OperatorError({
                            message:
                              "Environment operation failed; check project declarations and Docker",
                          }),
                    );
                  }),
                  Effect.match({
                    onSuccess: (identity) => {
                      state.identity = identity;
                      state.status = "completed";
                    },
                    onFailure: (error) => {
                      state.status = job.controller.signal.aborted
                        ? "cancelled"
                        : "failed";
                      state.error =
                        state.status === "cancelled"
                          ? "Environment job cancelled; previous image/configuration retained"
                          : error instanceof OperatorError
                            ? error.message
                            : "Environment job failed; check Dockerfile and project permissions";
                    },
                  }),
                  Effect.tap(() => Effect.sync(() => notify(job))),
                ),
              );
              response.writeHead(202);
              response.end(JSON.stringify(state));
              return;
            }
            const jobRoute =
              /^\/api\/environment\/jobs\/([a-f0-9-]+)(?:\/(events|cancel))?$/.exec(
                url.pathname,
              );
            if (jobRoute) {
              const job = jobs.get(jobRoute[1]!);
              if (!job)
                return yield* Effect.fail(
                  new RequestError(404, "Unknown environment job"),
                );
              if (request.method === "GET" && !jobRoute[2]) {
                response.end(JSON.stringify(job.state));
                return;
              }
              if (request.method === "GET" && jobRoute[2] === "events") {
                response.setHeader("Content-Type", "text/event-stream");
                response.write(`data: ${JSON.stringify(job.state)}\n\n`);
                if (
                  !["running", "cancelling", "promoting"].includes(
                    job.state.status,
                  )
                )
                  response.end();
                else {
                  job.listeners.add(response);
                  response.on("close", () => job.listeners.delete(response));
                }
                return;
              }
              if (request.method === "POST" && jobRoute[2] === "cancel") {
                const body = yield* requestBody(request);
                if (
                  !body ||
                  typeof body !== "object" ||
                  Array.isArray(body) ||
                  Object.keys(body).length
                )
                  return yield* Effect.fail(
                    new RequestError(400, "Cancel accepts an empty object"),
                  );
                if (job.state.status === "promoting")
                  return yield* Effect.fail(
                    new RequestError(
                      409,
                      "Image promotion is already committing; wait for the terminal result",
                    ),
                  );
                if (job.state.status === "running") {
                  job.state.status = "cancelling";
                  job.controller.abort();
                  notify(job);
                }
                response.writeHead(202);
                response.end(JSON.stringify(job.state));
                return;
              }
            }
            if (url.pathname === "/api/environment") {
              if (request.method === "GET") {
                response.end(
                  JSON.stringify(yield* attempt(() => inspectEnvironment(cwd))),
                );
                return;
              }
              if (request.method === "PUT") {
                const config = yield* requestBody(request);
                const saved = yield* lock.withPermits(1)(
                  attempt(() => saveEnvironmentConfig({ cwd, config })),
                );
                response.end(JSON.stringify({ config: saved }));
                return;
              }
            }
            if (url.pathname === "/api/prompts") {
              const promptOptions = {
                cwd,
                promptFiles: options.adapter.promptFiles,
              };
              if (request.method === "GET") {
                response.end(
                  JSON.stringify({
                    prompts: yield* attempt(() =>
                      loadProjectPrompts(promptOptions),
                    ),
                  }),
                );
                return;
              }
              if (request.method === "PUT") {
                const body = yield* requestBody(request);
                if (
                  !body ||
                  typeof body !== "object" ||
                  Array.isArray(body) ||
                  Object.keys(body).sort().join(",") !== "content,role" ||
                  typeof (body as { role: unknown }).role !== "string" ||
                  !(
                    (body as { content: unknown }).content === null ||
                    typeof (body as { content: unknown }).content === "string"
                  )
                )
                  return yield* Effect.fail(
                    new RequestError(
                      400,
                      "Prompt save accepts exactly role and content (null resets); paths/auth are not editable",
                    ),
                  );
                const input = body as { role: string; content: string | null };
                yield* lock.withPermits(1)(
                  attempt(() =>
                    saveProjectPrompt({ ...promptOptions, ...input }),
                  ),
                );
                response.end(
                  JSON.stringify({
                    prompts: yield* attempt(() =>
                      loadProjectPrompts(promptOptions),
                    ),
                  }),
                );
                return;
              }
            }
            if (url.pathname === "/api/workflow") {
              if (request.method === "GET") {
                response.end(
                  JSON.stringify(
                    yield* attempt(() => inspectWorkflow({ cwd })),
                  ),
                );
                return;
              }
              if (request.method === "PUT") {
                const config = yield* requestBody(request);
                const saved = yield* lock.withPermits(1)(
                  attempt(() => saveWorkflowConfig({ cwd, config })),
                );
                response.end(JSON.stringify({ config: saved }));
                return;
              }
            }
            if (url.pathname === "/api/config") {
              if (request.method === "GET") {
                const config = yield* attempt(() => loadRoleConfig({ cwd }));
                response.end(
                  JSON.stringify({
                    config,
                    capability: codexCapability,
                    providers: providerCapabilities,
                    project: cwd,
                  }),
                );
                return;
              }
              if (request.method === "PUT") {
                const body = yield* requestBody(request);
                const config = yield* lock.withPermits(1)(
                  attempt(() => saveRoleConfig({ cwd, config: body })),
                );
                const instructions = yield* attempt(() =>
                  ensureProviderInstructions({ cwd, config }),
                );
                response.end(JSON.stringify({ config, instructions }));
                return;
              }
            }
            if (url.pathname === "/api/run") {
              if (request.method === "GET") {
                if (current && current.status !== "running")
                  yield* attempt(() => runDone);
                const record = current?.runtime.record;
                response.end(
                  JSON.stringify({
                    run: record
                      ? {
                          id: record.id,
                          config: record.config,
                          workflow: record.workflow?.config,
                          diagnostics: yield* attempt(() =>
                            current!.runtime.diagnostics(),
                          ),
                          runtimeVersion: record.runtimeVersion,
                          sandboxIdentity: record.sandboxIdentity,
                          status: current!.status,
                        }
                      : null,
                  }),
                );
                return;
              }
              if (request.method === "POST") {
                const body = yield* requestBody(request);
                if (
                  !body ||
                  typeof body !== "object" ||
                  Array.isArray(body) ||
                  Object.keys(body).length
                )
                  return yield* Effect.fail(
                    new RequestError(
                      400,
                      "Run accepts only an empty JSON object; the project owns execution policy",
                    ),
                  );
                if (updateJob?.status === "running")
                  return yield* Effect.fail(
                    new RequestError(
                      409,
                      "A runtime update is active; wait before starting a run",
                    ),
                  );
                if (running)
                  return yield* Effect.fail(
                    new RequestError(409, "A project run is already active"),
                  );
                let releaseRun: (() => Promise<void>) | null = null;
                running = true;
                const runtime = yield* lock
                  .withPermits(1)(
                    Effect.gen(function* () {
                      releaseRun = yield* attempt(() =>
                        claimRuntimeRun(cwd),
                      ).pipe(
                        Effect.mapError(
                          (error) => new RequestError(409, error.message),
                        ),
                      );
                      const sandboxIdentity = yield* attempt(() =>
                        options.adapter.sandboxIdentity(),
                      );
                      return yield* attempt(() =>
                        createProjectRuntime({
                          cwd,
                          promptFiles: options.adapter.promptFiles,
                          sandboxIdentity,
                        }),
                      );
                    }),
                  )
                  .pipe(
                    Effect.tapError(() =>
                      Effect.gen(function* () {
                        if (releaseRun) yield* attempt(releaseRun);
                        running = false;
                      }),
                    ),
                  );
                current = { runtime, status: "running" };
                runDone = Effect.runPromise(
                  attempt(() => options.adapter.run(runtime)).pipe(
                    Effect.match({
                      onFailure: () => {
                        current!.status = "failed";
                      },
                      onSuccess: () => {
                        current!.status = "completed";
                      },
                    }),
                    Effect.ensuring(
                      Effect.gen(function* () {
                        if (releaseRun)
                          yield* attempt(releaseRun).pipe(Effect.orDie);
                        running = false;
                      }),
                    ),
                  ),
                );
                response.writeHead(202);
                response.end(
                  JSON.stringify({
                    id: runtime.record.id,
                    revision: runtime.record.config.revision,
                  }),
                );
                return;
              }
            }
            return yield* Effect.fail(
              new RequestError(
                mutation ? 405 : 404,
                "Unsupported operator route or method",
              ),
            );
          }).pipe(
            Effect.catchAll((error) =>
              Effect.sync(() => {
                if (!response.headersSent)
                  response.writeHead(
                    error instanceof RequestError ? error.status : 400,
                  );
                response.end(JSON.stringify({ error: error.message }));
              }),
            ),
          ),
        );
      });
      yield* Effect.async<void, OperatorError>((resume) => {
        server.once("error", () =>
          resume(
            Effect.fail(
              new OperatorError({
                message: "Cannot bind operator loopback port",
              }),
            ),
          ),
        );
        server.listen(options.port, "127.0.0.1", () => resume(Effect.void));
      }).pipe(Effect.tapError(() => attempt(() => dashboard.close())));
      const address = server.address();
      if (!address || typeof address === "string")
        return yield* Effect.fail(
          new OperatorError({ message: "Missing operator address" }),
        );
      return {
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          Effect.runPromise(
            Effect.gen(function* () {
              yield* attempt(() => updateDone);
              if (current && current.status !== "running")
                yield* attempt(() => runDone);
              for (const job of jobs.values())
                if (job.state.status === "running") job.controller.abort();
              yield* attempt(() =>
                Promise.all([...jobs.values()].map((job) => job.done)),
              );
              yield* Effect.async<void>((resume) => {
                server.closeAllConnections();
                server.close(() => resume(Effect.void));
              });
              yield* attempt(() => dashboard.close());
              // The project workflow owns cancellation; closing observation does not stop it.
            }),
          ),
      };
    }),
  );
