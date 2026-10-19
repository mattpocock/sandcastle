import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { z } from "zod";
import { OperatorError } from "./Operator.js";
import { writePrivateRecord } from "./writePrivateRecord.js";

const label = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9 ._:/-]*$/,
    "Use a label without control characters or shell syntax",
  );
const reference = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/,
    "Use a declared project reference",
  );
const labels = z
  .array(label)
  .max(50)
  .refine((items) => new Set(items).size === items.length, "Duplicate labels");
/** Validated credential-free settings accepted by both host and web. */
export const workflowConfigSchema = z
  .object({
    /** Version of the editable project document. */
    schemaVersion: z.literal(1),
    /** Computed content digest, verified on load. */
    revision: z.string(),
    /** Explicit GitHub owner/repository; null requires operator configuration. */
    repository: z
      .string()
      .regex(
        /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9_.-]{1,100}$/,
        "Use explicit owner/repository with a valid GitHub owner and repository name",
      )
      .refine(
        (value) => ![".", ".."].includes(value.split("/")[1]!),
        "Use a repository name other than . or ..",
      )
      .nullable(),
    /** Label defining the execution scope. */
    scopeLabel: label,
    /** Label denoting implementation readiness. */
    readyLabel: label,
    /** Label denoting blocked implementation work. */
    blockedLabel: label,
    /** Additional manual hold labels; project policy holds remain required. */
    holdLabels: labels,
    /** Bounds enforced by the generated workflow and shared scheduler. */
    limits: z
      .object({
        /** Maximum plan/execute/review/merge rounds per run. */
        cycles: z.number().int().min(1).max(1000),
        /** Maximum simultaneously active issue pipelines. */
        concurrency: z.number().int().min(1).max(100),
        /** Maximum retries of invalid planner output per round. */
        plannerAttempts: z.number().int().min(1).max(10),
        /** Extra attempts per issue for provider/infrastructure failures. Default 1. */
        taskRetries: z.number().int().min(0).max(3).optional(),
        /** Consecutive provider failures that stop new pipelines. Default 3. */
        consecutiveProviderFailures: z.number().int().min(1).max(20).optional(),
      })
      .strict(),
    /** Publication mode and trusted host command references. */
    readiness: z
      .object({
        /** Report-only is the default; apply requires a declared verifier. */
        mode: z.enum(["report-only", "apply"]),
        /** Selected trusted verifier reference, never a command. */
        verifier: reference.nullable(),
        /** Run a full readiness assessment at least every N merges (incremental otherwise). Default 5. */
        fullEvery: z.number().int().min(1).max(100).optional(),
        /** Additional project gate references; required gates cannot be removed. */
        gates: z
          .array(reference)
          .max(50)
          .refine(
            (items) => new Set(items).size === items.length,
            "Duplicate gate references",
          ),
      })
      .strict(),
    /** Merge policy. Absent means batch integration. */
    merge: z
      .object({
        /** "batch" (default) or "per-branch" integration as branches are approved. */
        mode: z.enum(["batch", "per-branch"]),
      })
      .strict()
      .optional(),
    /** Review policy. Absent means every option uses its default. */
    review: z
      .object({
        /**
         * Refuse run admission when the reviewer could run on a provider the
         * implementer could also run on, including configured fallbacks.
         * Default false.
         */
        requireDifferentProvider: z.boolean().optional(),
        /**
         * Implementer repair rounds after a changes-requested verdict.
         * Default 2; 0 restores single-pass review.
         */
        maxRepairRounds: z.number().int().min(0).max(5).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const states = [config.scopeLabel, config.readyLabel, config.blockedLabel];
    if (
      new Set(states).size !== states.length ||
      config.holdLabels.some((item) => states.includes(item))
    )
      ctx.addIssue({
        code: "custom",
        path: ["holdLabels"],
        message: "Scope, state and hold labels must be distinct",
      });
    if (
      config.readiness.mode === "apply" &&
      (!config.repository || !config.readiness.verifier)
    )
      ctx.addIssue({
        code: "custom",
        path: ["readiness"],
        message:
          "Apply requires an explicit repository and trusted project verifier reference",
      });
  });
/** Content-versioned project workflow settings. Commands and credentials are not editable. */
export type WorkflowConfig = z.infer<typeof workflowConfigSchema>;
/** Digest covering all editable workflow inputs. */
export function workflowConfigRevision(config: WorkflowConfig): string {
  const { revision: _revision, ...payload } = config;
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
const command = z.array(z.string().min(1)).min(1);
const trustedReadinessSchema = z
  .object({
    mode: z.enum(["disabled", "report-only", "apply"]).default("report-only"),
    repository: workflowConfigSchema.shape.repository.default(null),
    scopeLabel: label.default("Sandcastle"),
    readyLabel: label.default("ready-for-agent"),
    blockedLabel: label.default("blocked"),
    holdLabels: labels.default(["readiness:hold"]),
    qualificationLabel: label.default("ready-for-qualification"),
    publishBody: z.boolean().default(false),
    contextIssueNumbers: z.array(z.number().int().positive()).optional(),
    verifyCommand: command.nullable().default(null),
  })
  .strict();
const declarationsSchema = z
  .object({
    verifiers: z.record(reference, command).default({}),
    gates: z.record(reference, command).default({}),
    requiredGates: z.array(reference).default([]),
  })
  .strict();
/** Internal frozen host-owned policy, kept in private runtime evidence. */
export const workflowSnapshotSchema = z
  .object({
    config: workflowConfigSchema,
    policy: trustedReadinessSchema,
    declarations: declarationsSchema,
  })
  .strict();
/** Private run snapshot; only config is served to browsers. */
export type WorkflowSnapshot = z.infer<typeof workflowSnapshotSchema>;
const parse = <T>(schema: z.ZodType<T>, input: unknown, name: string) =>
  Effect.try({
    try: () => schema.parse(input),
    catch: (cause) =>
      new OperatorError({
        message:
          cause instanceof z.ZodError && name === "workflow"
            ? cause.issues
                .map(
                  (issue) =>
                    `${name}.${issue.path.join(".")}: ${issue.code === "unrecognized_keys" ? "Unexpected fields; commands and credentials are not editable" : issue.message}`,
                )
                .join("; ")
            : `${name}: invalid configuration`,
      }),
  });
const projectPath = (cwd: string, name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(resolve(cwd));
    const directory = join(root, ".sandcastle");
    const same = (left: string, right: string) =>
      left.replace(/\\/g, "/") === right.replace(/\\/g, "/");
    if (
      (yield* fs.exists(directory)) &&
      !same(yield* fs.realPath(directory), directory)
    )
      return yield* Effect.fail(
        new OperatorError({
          message: "Project configuration directory must not be a symlink",
        }),
      );
    const path = join(directory, name);
    if ((yield* fs.exists(path)) && !same(yield* fs.realPath(path), path))
      return yield* Effect.fail(
        new OperatorError({ message: `${name} must not be a symlink` }),
      );
    return path;
  });
const readJson = (name: string, fallback: unknown, cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* projectPath(cwd, name);
    if (!(yield* fs.exists(path))) return fallback;
    const text = yield* fs.readFileString(path);
    return yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () =>
        new OperatorError({
          message: `${name}: invalid JSON; repair the project declaration`,
        }),
    });
  });
const readPolicy = (cwd: string) =>
  Effect.gen(function* () {
    const policy = yield* parse(
      trustedReadinessSchema,
      yield* readJson("readiness.json", {}, cwd),
      "readiness.json",
    );
    const declarations = yield* parse(
      declarationsSchema,
      yield* readJson("feedback-gates.json", {}, cwd),
      "feedback-gates.json",
    );
    if (policy.verifyCommand) {
      if (Object.hasOwn(declarations.verifiers, "readiness"))
        return yield* Effect.fail(
          new OperatorError({
            message:
              "feedback-gates.json: readiness verifier reference is reserved for readiness.json",
          }),
        );
      declarations.verifiers.readiness = policy.verifyCommand;
    }
    if (
      declarations.requiredGates.some(
        (id) => !Object.hasOwn(declarations.gates, id),
      )
    )
      return yield* Effect.fail(
        new OperatorError({
          message: "feedback-gates.json: unknown required gate reference",
        }),
      );
    return { policy, declarations };
  });
const defaultConfig = (policy: WorkflowSnapshot["policy"]): WorkflowConfig => {
  const config: WorkflowConfig = {
    schemaVersion: 1,
    revision: "",
    repository: policy.repository,
    scopeLabel: policy.scopeLabel,
    readyLabel: policy.readyLabel,
    blockedLabel: policy.blockedLabel,
    holdLabels: policy.holdLabels,
    limits: { cycles: 10, concurrency: 100, plannerAttempts: 3 },
    readiness: {
      mode: policy.mode === "apply" ? "apply" : "report-only",
      verifier: policy.verifyCommand ? "readiness" : null,
      gates: [],
    },
  };
  config.revision = workflowConfigRevision(config);
  return config;
};
const validateProjectPolicy = (
  config: WorkflowConfig,
  policy: WorkflowSnapshot["policy"],
  declarations: WorkflowSnapshot["declarations"],
) =>
  Effect.gen(function* () {
    const states = [
      config.scopeLabel,
      config.readyLabel,
      config.blockedLabel,
      policy.qualificationLabel,
    ];
    const holds = [...policy.holdLabels, ...config.holdLabels];
    if (
      new Set(states).size !== states.length ||
      states.some((state) => holds.includes(state))
    )
      return yield* Effect.fail(
        new OperatorError({
          message:
            "workflow: scope, state, qualification and project-required hold labels must be distinct",
        }),
      );
    if (
      config.readiness.verifier &&
      !Object.hasOwn(declarations.verifiers, config.readiness.verifier)
    )
      return yield* Effect.fail(
        new OperatorError({
          message:
            "workflow.readiness.verifier: unknown trusted project verifier reference",
        }),
      );
    if (
      config.readiness.gates.some(
        (id) => !Object.hasOwn(declarations.gates, id),
      )
    )
      return yield* Effect.fail(
        new OperatorError({
          message:
            "workflow.readiness.gates: unknown project feedback gate reference",
        }),
      );
  });
/** Internal atomic source loader shared by runtime and HTTP. */
export const loadWorkflowSnapshotEffect = (cwd: string) =>
  Effect.gen(function* () {
    const { policy, declarations } = yield* readPolicy(cwd);
    const input = yield* readJson("workflow.json", null, cwd);
    const config = yield* parse(
      workflowConfigSchema,
      input ?? defaultConfig(policy),
      "workflow",
    );
    if (config.revision !== workflowConfigRevision(config))
      return yield* Effect.fail(
        new OperatorError({
          message:
            "workflow.json: revision mismatch; save through the configuration interface",
        }),
      );
    yield* validateProjectPolicy(config, policy, declarations);
    return { config, policy, declarations };
  }).pipe(
    Effect.mapError((error) =>
      error instanceof OperatorError
        ? error
        : new OperatorError({
            message:
              "Cannot read project workflow settings; check project permissions",
          }),
    ),
  );
/** Load the same validated project workflow configuration used by CLI and operator web. */
export function loadWorkflowConfig(options: {
  /** Explicit host project directory. */ cwd: string;
}): Promise<WorkflowConfig> {
  return Effect.runPromise(
    loadWorkflowSnapshotEffect(options.cwd).pipe(
      Effect.map((snapshot) => snapshot.config),
      Effect.provide(NodeFileSystem.layer),
    ),
  );
}
/** Save only validated settings atomically; unrelated project files remain project-owned. */
export function saveWorkflowConfig(options: {
  /** Explicit host project directory. */ cwd: string;
  /** Complete reference-only settings document. */ config: unknown;
}): Promise<WorkflowConfig> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const path = yield* projectPath(options.cwd, "workflow.json");
      const config = yield* parse(
        workflowConfigSchema,
        options.config,
        "workflow",
      );
      const { policy, declarations } = yield* readPolicy(options.cwd);
      yield* validateProjectPolicy(config, policy, declarations);
      config.revision = workflowConfigRevision(config);
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(join(options.cwd, ".sandcastle"), {
        recursive: true,
      });
      yield* writePrivateRecord(
        fs,
        path,
        JSON.stringify(config, null, 2) + "\n",
      );
      return config;
    }).pipe(
      Effect.mapError((error) =>
        error instanceof OperatorError
          ? error
          : new OperatorError({
              message:
                "Cannot save .sandcastle/workflow.json; check project permissions",
            }),
      ),
      Effect.provide(NodeFileSystem.layer),
    ),
  );
}
/** Inspect reference names and configuration without exposing command text or credential values. */
export function inspectWorkflow(options: {
  /** Explicit host project directory. */ cwd: string;
}) {
  return Effect.runPromise(
    loadWorkflowSnapshotEffect(options.cwd).pipe(
      Effect.map(({ config, policy, declarations }) => ({
        config,
        references: {
          verifiers: Object.keys(declarations.verifiers),
          gates: Object.keys(declarations.gates),
        },
        requiredHoldLabels: policy.holdLabels,
        requiredGates: declarations.requiredGates,
        diagnostics: [
          ...(!config.repository
            ? [
                "Explicit repository required before a generated workflow can start. Configure owner/repository.",
              ]
            : []),
          ...(!config.readiness.verifier
            ? [
                "Missing trusted project verifier: report-only can assess, apply requires a project-owned declaration.",
              ]
            : []),
        ],
      })),
      Effect.provide(NodeFileSystem.layer),
    ),
  );
}
