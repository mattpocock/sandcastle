import {
  run as sandcastleRun,
  codex,
  claudeCode,
  createBindMountSandboxProvider,
  opencode,
  pi,
  type AgentProvider,
  type SandboxProvider,
} from "@ai-hero/sandcastle";
import type { PostRunsRequest, Run, RunEvent } from "@sandcastle/protocol";
import { allocateRunId } from "./RunIdAllocator.js";
import { RunEventProjector } from "./RunEventProjector.js";
import type { SqliteStore } from "../telemetry/SqliteStore.js";
import { spawn, type StdioOptions } from "node:child_process";
import { createInterface } from "node:readline";

export type EngineAgentStreamEvent = RunEvent;

type RunImpl = typeof sandcastleRun;

type Subscriber = (runId: string, event: RunEvent) => void;

export interface RunSupervisorOptions {
  readonly repoRoot: string;
  readonly store: SqliteStore;
  readonly runImpl?: RunImpl;
  readonly agentFactory?: (request: PostRunsRequest) => AgentProvider;
  readonly sandboxFactory?: () => SandboxProvider;
}

const toProvider = (request: PostRunsRequest): AgentProvider => {
  const model =
    request.model ?? process.env.SANDCASTLE_CONTROL_MODEL ?? "gpt-5.4";
  switch (request.provider ?? "codex") {
    case "claude-code":
      return claudeCode(model, { captureSessions: false });
    case "pi":
      return pi(model);
    case "opencode":
      return opencode(model);
    case "codex":
      return codex(model);
  }
};

const hostSandbox = (): SandboxProvider =>
  createBindMountSandboxProvider({
    name: "host-bind-mount",
    create: async (createOptions) => ({
      worktreePath: createOptions.worktreePath,
      exec: (command, opts) =>
        new Promise((resolveExec, reject) => {
          const proc = spawn(
            process.platform === "win32" ? "cmd.exe" : "sh",
            process.platform === "win32"
              ? ["/d", "/s", "/c", command]
              : ["-c", command],
            {
              cwd: opts?.cwd ?? createOptions.worktreePath,
              env: { ...process.env, ...createOptions.env },
              stdio: [
                opts?.stdin !== undefined ? "pipe" : "ignore",
                "pipe",
                "pipe",
              ],
            },
          );
          if (opts?.stdin !== undefined) {
            proc.stdin?.write(opts.stdin);
            proc.stdin?.end();
          }
          const stdoutChunks: string[] = [];
          const stderrChunks: string[] = [];
          if (opts?.onLine) {
            const rl = createInterface({ input: proc.stdout! });
            rl.on("line", (line) => {
              stdoutChunks.push(line);
              opts.onLine?.(line);
            });
          } else {
            proc.stdout?.on("data", (chunk: Buffer) =>
              stdoutChunks.push(chunk.toString()),
            );
          }
          proc.stderr?.on("data", (chunk: Buffer) =>
            stderrChunks.push(chunk.toString()),
          );
          proc.on("error", reject);
          proc.on("close", (code) =>
            resolveExec({
              stdout: stdoutChunks.join(opts?.onLine ? "\n" : ""),
              stderr: stderrChunks.join(""),
              exitCode: code ?? 0,
            }),
          );
        }),
      interactiveExec: (args, opts) =>
        new Promise((resolveExec, reject) => {
          const [cmd, ...rest] = args;
          const proc = spawn(cmd!, rest, {
            cwd: opts.cwd ?? createOptions.worktreePath,
            env: { ...process.env, ...createOptions.env },
            stdio: [opts.stdin, opts.stdout, opts.stderr] as StdioOptions,
          });
          proc.on("error", reject);
          proc.on("close", (code) => resolveExec({ exitCode: code ?? 0 }));
        }),
      copyFileIn: async () => {},
      copyFileOut: async () => {},
      close: async () => {},
    }),
  });

export class RunSupervisor {
  private readonly projector = new RunEventProjector();
  private readonly subscribers = new Set<Subscriber>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly runImpl: RunImpl;
  private readonly agentFactory: (request: PostRunsRequest) => AgentProvider;
  private readonly sandboxFactory: () => SandboxProvider;

  constructor(private readonly options: RunSupervisorOptions) {
    this.runImpl = options.runImpl ?? sandcastleRun;
    this.agentFactory = options.agentFactory ?? toProvider;
    this.sandboxFactory = options.sandboxFactory ?? hostSandbox;
    for (const run of options.store.listRuns()) {
      this.projector.createQueued({
        id: run.id,
        directive: run.directive,
        branch: run.branch,
        provider: run.provider,
        sandboxProvider: run.sandboxProvider,
        startedAt: run.startedAt,
      });
    }
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  listRuns(): Run[] {
    const projected = this.projector.listRuns();
    const stored = this.options.store.listRuns();
    const byId = new Map(stored.map((run) => [run.id, run]));
    for (const run of projected) byId.set(run.id, run);
    return [...byId.values()];
  }

  getRun(id: string): Run | undefined {
    return this.projector.getRun(id) ?? this.options.store.getRun(id);
  }

  async startRun(request: PostRunsRequest): Promise<{ runId: string }> {
    const runId = allocateRunId();
    const branch = await currentBranch(this.options.repoRoot).catch(
      () => "unknown",
    );
    const queued = this.projector.createQueued({
      id: runId,
      directive: request.directive,
      branch,
      provider: request.provider,
      sandboxProvider: "host-bind-mount",
    });
    this.options.store.upsertRun(queued);

    const controller = new AbortController();
    this.controllers.set(runId, controller);
    const agent = this.agentFactory(request);
    const sandbox = this.sandboxFactory();

    void this.runImpl({
      cwd: this.options.repoRoot,
      agent,
      sandbox,
      prompt: request.directive,
      maxIterations: request.maxIterations,
      completionSignal: request.completionSignal,
      branchStrategy: { type: "head" },
      name: runId,
      signal: controller.signal,
      logging: {
        type: "file",
        path: `${this.options.repoRoot}/.sandcastle/logs/${runId}.log`,
        onAgentStreamEvent: (event: unknown) =>
          this.handleEngineEvent(runId, event as EngineAgentStreamEvent),
      },
    })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        this.handleEvent(runId, {
          type: "run.resolved",
          runId,
          result: "defeat",
          xpDelta: 0,
          iteration: 0,
          timestamp: new Date(),
        });
        console.error("[sandcastle-control] run failed", error);
      })
      .finally(() => {
        this.controllers.delete(runId);
      });

    return { runId };
  }

  cancelRun(runId: string): boolean {
    const controller = this.controllers.get(runId);
    if (!controller) return false;
    this.handleEvent(runId, {
      type: "intervention.used",
      action: "cancel",
      iteration: 0,
      timestamp: new Date(),
    });
    controller.abort(new DOMException("Run cancelled", "AbortError"));
    this.handleEvent(runId, {
      type: "run.resolved",
      runId,
      result: "aborted",
      xpDelta: 0,
      iteration: 0,
      timestamp: new Date(),
    });
    return true;
  }

  private handleEngineEvent(
    runId: string,
    event: EngineAgentStreamEvent,
  ): void {
    this.handleEvent(runId, normalizeRunId(runId, event));
  }

  private handleEvent(runId: string, event: RunEvent): void {
    const run = this.projector.project(event, runId);
    if (run) this.options.store.upsertRun(run);
    this.options.store.appendEvent(runId, event);
    for (const subscriber of this.subscribers) subscriber(runId, event);
  }
}

const normalizeRunId = (runId: string, event: RunEvent): RunEvent => {
  if ("runId" in event && event.runId === runId) return event;
  if ("runId" in event) return { ...event, runId } as RunEvent;
  return event;
};

const currentBranch = async (cwd: string): Promise<string> => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd },
  );
  return stdout.trim();
};
