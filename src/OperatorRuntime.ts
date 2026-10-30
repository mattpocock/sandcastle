import { execFile } from "node:child_process";
import type { ReadinessVerificationInput } from "./Readiness.js";
import {
  loadWorkflowSnapshotEffect,
  workflowSnapshotSchema,
  workflowConfigRevision,
  type WorkflowSnapshot,
} from "./OperatorWorkflow.js";
import { loadProjectPromptsEffect } from "./OperatorPrompts.js";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Data, Effect } from "effect";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { AgentProvider } from "./AgentProvider.js";
import {
  buildRoleAgent,
  buildRoleAgentWithFallback,
  type RoleAgentOptions,
} from "./RoleAgents.js";
import { createAgentMap, type AgentMap } from "./AgentMap.js";
import {
  loadRoleConfigEffect,
  operatorRoles,
  OperatorError,
  roleSetting,
  type RoleSetting,
  type RoleConfig,
  type OperatorRole,
} from "./Operator.js";
import { z } from "zod";
import { roleConfigSchema, roleConfigRevision } from "./Operator.js";
import { VERSION } from "./version.js";
import { reviewProviderConflict } from "./ReviewProviders.js";
import { writePrivateRecord } from "./writePrivateRecord.js";

/** Immutable evidence for one project workflow invocation. Stored privately, not served as raw JSON. */
export interface RuntimeRecord {
  /** Unique workflow identity. */
  readonly id: string;
  /** Effective configuration, including its content revision. */
  readonly config: RoleConfig;
  /** Frozen tracker, limits and trusted project feedback policy. */
  readonly workflow?: WorkflowSnapshot;
  /** Digest of frozen workflow settings and host-owned declarations. */
  readonly workflowRevision?: string;
  /** Installed package runtime version. */
  readonly runtimeVersion: string;
  /** Project adapter's resolved sandbox identity (prefer an immutable image digest). */
  readonly sandboxIdentity: string;
  /** Frozen prompt contents and SHA-256 digests; null when a role has no prompt. */
  readonly prompts: Record<
    OperatorRole,
    { content: string; digest: string } | null
  >;
}
const diagnosticSchema = z
  .object({
    code: z.enum([
      "qualification-pending",
      "no-progress",
      "iteration-limit",
      "provider-unavailable",
      "feedback-failed",
    ]),
    issues: z.array(z.number().int().positive()),
  })
  .strict();
/** Safe workflow outcome shown beside run/log navigation. Contains no executable text. */
export type WorkflowDiagnostic = z.infer<typeof diagnosticSchema>;
class PipelineFailure extends Data.TaggedError("PipelineFailure")<{
  readonly cause: unknown;
}> {}
/** Frozen project run settings and provider construction. Project gates/sandboxes remain caller-owned. */
export interface ProjectRuntime {
  /** Frozen identity and effective inputs. */
  readonly record: RuntimeRecord;
  /** Frozen workflow snapshot; legacy role-only records require a new run for workflow operations. */
  readonly workflow: WorkflowSnapshot;
  /** Settle every issue pipeline in input order with the frozen concurrency bound. */
  settleIssues<T, R>(
    issues: readonly T[],
    execute: (issue: T) => Promise<R>,
  ): Promise<PromiseSettledResult<R>[]>;
  /** Persist a safe outcome for observation across the CLI child boundary. */
  reportOutcome(outcome: WorkflowDiagnostic): Promise<void>;
  /** Read the current safe workflow outcome, including child-process reports. */
  diagnostics(): Promise<WorkflowDiagnostic[]>;
  /** Effective tracker/readiness policy; project holds and qualification controls remain authoritative. */
  readonly readiness: {
    mode: "report-only" | "apply";
    repository: string | null;
    scopeLabel: string;
    readyLabel: string;
    blockedLabel: string;
    holdLabels: string[];
    qualificationLabel: string;
    publishBody: boolean;
    contextIssueNumbers?: number[];
  };
  /** Run frozen project gates then the selected trusted verifier. Never executes issue/model commands. */
  verifyReadiness(input: ReadinessVerificationInput): Promise<unknown>;
  /** Build the configured role provider with its fallback chain, preserving project-owned session/auth options. */
  agent(role: OperatorRole, options?: RoleAgentOptions): AgentProvider;
  /** The role's effective primary target and ordered fallback chain. */
  roleSetting(role: OperatorRole): RoleSetting;
  /** Build the primary provider followed by each configured fallback, in order. */
  agentChain(
    role: OperatorRole,
    options?: RoleAgentOptions,
  ): readonly {
    readonly target: RoleSetting | RoleSetting["fallback"][number];
    readonly agent: AgentProvider;
  }[];
  /** Absolute host path to the frozen prompt template; expansion semantics are preserved. */
  promptFile(role: OperatorRole): string;
  /** Create an observable workflow map which records the effective role settings on every tracked invocation. */
  createAgentMap(name: string): Promise<AgentMap>;
}
/** Inputs owned by the project adapter, never accepted from editable HTTP configuration. */
export interface ProjectRuntimeOptions {
  /** Explicit host project directory. */
  cwd: string;
  /** Project prompt paths; relative paths resolve against cwd. */
  promptFiles: Record<OperatorRole, string | null>;
  /** Resolved sandbox identity, supplied by the project adapter. */
  sandboxIdentity: string;
}
const frozenPromptSchema = z
  .object({ content: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict()
  .nullable();
const runtimeRecordSchema = z
  .object({
    id: z.string().uuid(),
    config: roleConfigSchema,
    workflow: workflowSnapshotSchema.optional(),
    workflowRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    runtimeVersion: z.string(),
    sandboxIdentity: z.string().min(1),
    prompts: z
      .object({
        planner: frozenPromptSchema,
        implementer: frozenPromptSchema,
        reviewer: frozenPromptSchema,
        merger: frozenPromptSchema,
        readiness: frozenPromptSchema,
      })
      .strict(),
  })
  .strict();
const workflowRevision = (snapshot: WorkflowSnapshot) =>
  createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};
const executeFeedback = (
  cwd: string,
  argv: string[],
  input: string,
  description: string,
) =>
  Effect.async<string, OperatorError>((resume) => {
    const child = execFile(
      argv[0]!,
      argv.slice(1),
      { cwd, encoding: "utf8", timeout: 300_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        resume(
          error
            ? Effect.fail(
                new OperatorError({
                  message: `${description} failed; inspect the project-owned declaration and gate on the host`,
                }),
              )
            : Effect.succeed(stdout),
        );
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
    return Effect.sync(() => {
      child.kill("SIGTERM");
    });
  });
const hydrate = (cwd: string, record: RuntimeRecord): ProjectRuntime => {
  const projectDirectory = resolve(cwd);
  freeze(record);
  const getWorkflow = () => {
    if (!record.workflow)
      throw new OperatorError({
        message:
          "Legacy run has no workflow snapshot; start a new run to use workflow settings",
      });
    return record.workflow;
  };
  const workflowEffect = Effect.try({
    try: getWorkflow,
    catch: () =>
      new OperatorError({
        message:
          "Legacy run has no workflow snapshot; start a new run to use workflow settings",
      }),
  });
  const diagnosticPath = join(
    projectDirectory,
    ".sandcastle",
    "runtime",
    record.id,
    "diagnostics.json",
  );
  const report = (outcome: WorkflowDiagnostic) =>
    Effect.gen(function* () {
      const value = yield* Effect.try({
        try: () => diagnosticSchema.parse(outcome),
        catch: () =>
          new OperatorError({ message: "Invalid workflow diagnostic" }),
      });
      const fs = yield* FileSystem.FileSystem;
      yield* writePrivateRecord(
        fs,
        diagnosticPath,
        JSON.stringify([value]) + "\n",
      );
    }).pipe(
      Effect.mapError(
        () => new OperatorError({ message: "Cannot record workflow outcome" }),
      ),
      Effect.provide(NodeFileSystem.layer),
    );
  return {
    record,
    get workflow() {
      return getWorkflow();
    },
    reportOutcome: (outcome) => Effect.runPromise(report(outcome)),
    diagnostics: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          if (!(yield* fs.exists(diagnosticPath))) return [];
          const text = yield* fs.readFileString(diagnosticPath);
          return yield* Effect.try({
            try: () => z.array(diagnosticSchema).parse(JSON.parse(text)),
            catch: () =>
              new OperatorError({
                message: "Invalid recorded workflow outcome",
              }),
          });
        }).pipe(
          Effect.mapError(
            () =>
              new OperatorError({ message: "Cannot read workflow outcome" }),
          ),
          Effect.provide(NodeFileSystem.layer),
        ),
      ),
    get readiness() {
      const workflow = getWorkflow();
      return freeze({
        mode: workflow.config.readiness.mode,
        repository: workflow.config.repository,
        scopeLabel: workflow.config.scopeLabel,
        readyLabel: workflow.config.readyLabel,
        blockedLabel: workflow.config.blockedLabel,
        holdLabels: [
          ...new Set([
            ...workflow.policy.holdLabels,
            ...workflow.config.holdLabels,
          ]),
        ],
        qualificationLabel: workflow.policy.qualificationLabel,
        publishBody: workflow.policy.publishBody,
        contextIssueNumbers: workflow.policy.contextIssueNumbers,
      });
    },
    verifyReadiness: (input) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { config, declarations } = yield* workflowEffect;
          const verifier = config.readiness.verifier;
          if (!verifier || !Object.hasOwn(declarations.verifiers, verifier))
            return yield* Effect.fail(
              new OperatorError({
                message:
                  "Missing trusted project verifier; declare a reference before applying readiness",
              }),
            );
          const encoded = JSON.stringify(input);
          for (const id of new Set([
            ...declarations.requiredGates,
            ...config.readiness.gates,
          ])) {
            if (!Object.hasOwn(declarations.gates, id))
              return yield* Effect.fail(
                new OperatorError({
                  message: "Missing project feedback gate declaration",
                }),
              );
            yield* executeFeedback(
              projectDirectory,
              declarations.gates[id]!,
              encoded,
              `Project feedback gate ${id}`,
            );
          }
          const stdout = yield* executeFeedback(
            projectDirectory,
            declarations.verifiers[verifier]!,
            encoded,
            "Trusted project verifier",
          );
          return yield* Effect.try({
            try: () => JSON.parse(stdout) as unknown,
            catch: () =>
              new OperatorError({
                message: "Trusted project verifier returned invalid JSON",
              }),
          });
        }).pipe(
          Effect.tapError(() =>
            report({ code: "feedback-failed", issues: [] }),
          ),
        ),
      ),
    settleIssues: (issues, execute) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const workflow = yield* workflowEffect;
          return yield* Effect.forEach(
            issues,
            (issue) =>
              Effect.tryPromise({
                try: () => execute(issue),
                catch: (cause) => new PipelineFailure({ cause }),
              }).pipe(
                Effect.match({
                  onSuccess: (value) => ({
                    status: "fulfilled" as const,
                    value,
                  }),
                  onFailure: (error) => ({
                    status: "rejected" as const,
                    reason: error.cause,
                  }),
                }),
              ),
            { concurrency: workflow.config.limits.concurrency },
          );
        }),
      ),
    agent: (role, options) =>
      buildRoleAgentWithFallback(roleSetting(record.config, role), options),
    roleSetting: (role) => roleSetting(record.config, role),
    agentChain: (role, options) => {
      const setting = roleSetting(record.config, role);
      return [setting, ...setting.fallback].map((target) => ({
        target,
        agent: buildRoleAgent(target, options),
      }));
    },
    promptFile: (role) => {
      if (!record.prompts[role])
        throw new OperatorError({
          message: `No prompt configured for ${role}`,
        });
      return join(
        projectDirectory,
        ".sandcastle",
        "runtime",
        record.id,
        `${role}.md`,
      );
    },
    createAgentMap: (name) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const map = yield* Effect.tryPromise({
            try: () =>
              createAgentMap({
                cwd: projectDirectory,
                name,
                runtime: {
                  id: record.id,
                  configRevision: record.config.revision,
                  version: record.runtimeVersion,
                  sandboxIdentity: record.sandboxIdentity,
                },
              }),
            catch: () =>
              new OperatorError({
                message: "Cannot create workflow observation",
              }),
          });
          return {
            ...map,
            track: (task, execute) =>
              map.track(
                (() => {
                  const { fallback: _chain, ...primary } = roleSetting(
                    record.config,
                    task.role,
                  );
                  return { ...task, ...primary };
                })(),
                execute,
              ),
          } satisfies AgentMap;
        }),
      ),
  };
};
/** Freeze an explicit project's effective inputs before invoking any role. */
export const createProjectRuntime = (
  options: ProjectRuntimeOptions,
): Promise<ProjectRuntime> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* loadRoleConfigEffect(options.cwd);
      const workflow = yield* loadWorkflowSnapshotEffect(options.cwd);
      if (workflow.config.review?.requireDifferentProvider) {
        const conflict = reviewProviderConflict(config);
        if (conflict)
          return yield* Effect.fail(new OperatorError({ message: conflict }));
      }
      if (!options.sandboxIdentity.trim())
        return yield* Effect.fail(
          new OperatorError({
            message: "Project adapter must supply a sandbox identity",
          }),
        );
      const directory = join(
        resolve(options.cwd),
        ".sandcastle",
        "runtime",
        randomUUID(),
      );
      const selected = yield* loadProjectPromptsEffect(options);
      const prompts = {} as RuntimeRecord["prompts"];
      for (const role of operatorRoles) {
        const path = options.promptFiles[role];
        if (path === null) {
          prompts[role] = null;
          continue;
        }
        const content = selected[role]!.content;
        prompts[role] = {
          content,
          digest: createHash("sha256").update(content).digest("hex"),
        };
      }
      const record: RuntimeRecord = {
        id: directory.split(/[\\/]/).at(-1)!,
        config,
        workflow,
        workflowRevision: workflowRevision(workflow),
        runtimeVersion: VERSION,
        sandboxIdentity: options.sandboxIdentity,
        prompts,
      };
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      for (const role of operatorRoles) {
        const prompt = prompts[role];
        if (prompt)
          yield* writePrivateRecord(
            fs,
            join(directory, `${role}.md`),
            prompt.content,
          );
      }
      yield* writePrivateRecord(
        fs,
        join(directory, "record.json"),
        JSON.stringify(record, null, 2) + "\n",
      );
      return hydrate(options.cwd, record);
    }).pipe(
      Effect.mapError((error) =>
        error instanceof OperatorError
          ? error
          : new OperatorError({
              message:
                "Cannot freeze project inputs; check prompt paths and permissions",
            }),
      ),
      Effect.provide(NodeFileSystem.layer),
    ),
  );

/** Reopen a frozen invocation in a project-owned child workflow, without reading live settings. */
export const openProjectRuntime = (options: {
  /** Host project directory. */
  cwd: string;
  /** UUID returned by createProjectRuntime; never a path. */
  id: string;
}): Promise<ProjectRuntime> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
          options.id,
        )
      )
        return yield* Effect.fail(
          new OperatorError({ message: "Invalid frozen runtime ID" }),
        );
      const directory = join(
        resolve(options.cwd),
        ".sandcastle",
        "runtime",
        options.id,
      );
      const text = yield* fs.readFileString(join(directory, "record.json"));
      const record = yield* Effect.try({
        try: () => runtimeRecordSchema.parse(JSON.parse(text)),
        catch: () =>
          new OperatorError({
            message: "Unsupported frozen runtime record schema",
          }),
      });
      if (
        record.id !== options.id ||
        record.runtimeVersion !== VERSION ||
        record.config.revision !== roleConfigRevision(record.config) ||
        (record.workflow
          ? record.workflow.config.revision !==
              workflowConfigRevision(record.workflow.config) ||
            record.workflowRevision !== workflowRevision(record.workflow)
          : record.workflowRevision !== undefined)
      )
        return yield* Effect.fail(
          new OperatorError({
            message: "Frozen runtime identity/version/revision mismatch",
          }),
        );
      for (const role of operatorRoles) {
        const prompt = record.prompts[role];
        if (!prompt) continue;
        const content = yield* fs.readFileString(join(directory, `${role}.md`));
        if (
          content !== prompt.content ||
          createHash("sha256").update(content).digest("hex") !== prompt.digest
        )
          return yield* Effect.fail(
            new OperatorError({
              message: `Frozen ${role} prompt integrity mismatch`,
            }),
          );
      }
      return hydrate(options.cwd, record);
    }).pipe(
      Effect.mapError((error) =>
        error instanceof OperatorError
          ? error
          : new OperatorError({
              message: "Cannot reopen frozen project runtime",
            }),
      ),
      Effect.provide(NodeFileSystem.layer),
    ),
  );
