import { loadProjectPromptsEffect } from "./OperatorPrompts.js";
import { execFile } from "node:child_process";
import {
  loadEnvironmentConfigEffect,
  validateEnvironmentConfigEffect,
} from "./OperatorEnvironment.js";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Runtime, Cause, Option } from "effect";
import { z } from "zod";
import { writePrivateRecord } from "./writePrivateRecord.js";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OperatorError,
  defaultRoleConfig,
  roleConfigSchema,
  roleConfigRevision,
  loadRoleConfigEffect,
  operatorRoles,
} from "./Operator.js";
import {
  loadWorkflowSnapshotEffect,
  workflowConfigSchema,
  workflowConfigRevision,
} from "./OperatorWorkflow.js";
import {
  planRuntimeUpdate,
  type RuntimeUpdatePlan,
  claimRuntimeRun,
  assertInactive,
} from "./OperatorUpdates.js";
import {
  wireReviewedRuntime,
  readLegacyRoleCall,
  rewriteSandboxImages,
} from "./ReviewedRuntime.js";

/** Reviewable migration result; unsupported workflows are never executed. */
export interface ProjectMigrationPlan {
  /** Whether a generated workflow can be adapted safely. */ status:
    | "ready"
    | "current"
    | "unsupported";
  /** Manual instructions or review requirements. */ instructions: string;
  /** Content identity of the inspected workflow. */ revision: string;
  /** Recognized generated template family. */ template: string | null;
  /** Installed and target archive identities; versions alone never establish compatibility. */ runtime: RuntimeUpdatePlan | null;
  /** File-by-file before/after review. Null means absent; preserved files have equal values. */ files: MigrationFile[];
  /** Legacy base, current default and retained project content for prompt diff review. */ prompts: {
    /** Role whose prompt is being compared. */ role: string;
    /** Original content addressed customization base. */ base: string;
    /** Current packaged default, separate from the override. */ default: string;
    /** Effective project text retained by this plan. */ override: string;
  }[];
  /** Prompt overrides whose legacy base differs from the current default. Apply requires explicit retention. */ conflicts: string[];
}
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
// Literals are project settings. Everything else must match a known generated
// program, including the call graph. This does not execute or import consumer code.
const shape = (text: string) => {
  const literals: string[] = [];
  let code = text.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    (token) => {
      if (token.startsWith("//") || token.startsWith("/*")) return "";
      literals.push(token);
      return "§" + (literals.length - 1) + "§";
    },
  );
  // Only project-owned configuration regions vary. The executable orchestration,
  // tracker, validators and readiness schema must retain their known structure.
  code = code.replace(/agent:\s*sandcastle\.codex\([^\n]*\),/g, "agent: ROLE,");
  code = code.replace(
    /const (MAX_ITERATIONS|MAX_PLANNER_ATTEMPTS) = \d+;/g,
    "const $1 = LIMIT;",
  );
  code = code.replace(
    /const (?:CODEX_[A-Z_]+|CODING_STANDARDS_[A-Z_]+|FEEDBACK_LOOPS_[A-Z_]+|EVIDENCE_POLICY_[A-Z_]+|NPM_CACHE_[A-Z_]+|GRADLE_CACHE_[A-Z_]+|CODEGRAPH_[A-Z_]+|codeGraphSyncCommand) = §\d+§;/g,
    "const SETTING = L;",
  );
  code = code.replace(/sandcastle\.codex\(§\d+§,/g, "sandcastle.codex(MODEL,");
  code = code.replace(/(const codexAgent[^\n]*= )§\d+§/g, "$1EFFORT");
  code = code.replace(/agent: codexAgent\([^\n]*\),/g, "agent: ROLE,");
  const hooks = /const hooks\s*=\s*\{/.exec(code);
  if (hooks) {
    let depth = 1,
      end = hooks.index + hooks[0].length;
    while (end < code.length && depth) {
      if (code[end] === "{") depth++;
      if (code[end] === "}") depth--;
      end++;
    }
    if (depth) return "UNSUPPORTED";
    code = code.slice(0, hooks.index) + "const hooks = HOOKS" + code.slice(end);
  }
  let offset = 0;
  while (true) {
    const match = /docker\s*\(/g;
    match.lastIndex = offset;
    const found = match.exec(code);
    if (!found) break;
    let depth = 1,
      end = match.lastIndex;
    while (end < code.length && depth) {
      if (code[end] === "(") depth++;
      if (code[end] === ")") depth--;
      end++;
    }
    if (depth) return "UNSUPPORTED";
    code = code.slice(0, found.index) + "docker(CONFIG)" + code.slice(end);
    offset = found.index + 14;
  }
  return code
    .replace(/\s+/g, "")
    .replace(/§(\d+)§/g, (_, index) => literals[Number(index)]!);
};
const fail = (message: string) => Effect.fail(new OperatorError({ message }));
const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.mapError((error) =>
        error instanceof OperatorError
          ? error
          : new OperatorError({
              message:
                "Cannot inspect project migration; check managed paths and permissions",
            }),
      ),
      Effect.provide(NodeFileSystem.layer),
    ),
  );
const safe = (fs: FileSystem.FileSystem, root: string, name: string) =>
  Effect.gen(function* () {
    let path = root;
    for (const part of name.split("/")) {
      path = join(path, part);
      if (
        (yield* fs.exists(path)) &&
        (yield* fs.realPath(path)).replace(/\\/g, "/") !==
          path.replace(/\\/g, "/")
      )
        return yield* fail("Migration paths must not be symbolic links");
    }
    return path;
  });
/** A managed file in a reviewable plan. Private auth, sessions and journals never appear here. */
export interface MigrationFile {
  /** Project-relative allowlisted destination. */ path: string;
  /** Current managed content or absent. */ before: string | null;
  /** Proposed managed content or absent. */ after: string | null;
}
const templateDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "templates",
);
const json = <T>(text: string): Effect.Effect<T, OperatorError> =>
  Effect.try({
    try: () => JSON.parse(text) as T,
    catch: () =>
      new OperatorError({ message: "Invalid migration configuration" }),
  });
const read = (fs: FileSystem.FileSystem, root: string, name: string) =>
  Effect.gen(function* () {
    const path = yield* safe(fs, root, name);
    return (yield* fs.exists(path)) ? yield* fs.readFileString(path) : null;
  });
const attempt = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (error) => {
      if (error instanceof OperatorError) return error;
      const failure = Runtime.isFiberFailure(error)
        ? Cause.failureOption(error[Runtime.FiberFailureCauseId])
        : Option.none();
      return Option.isSome(failure) && failure.value instanceof OperatorError
        ? failure.value
        : new OperatorError({
            message: "Cannot inspect installed runtime for migration",
          });
    },
  });
const serialized = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const filename = {
  planner: "plan",
  implementer: "implement",
  reviewer: "review",
  merger: "merge",
  readiness: "readiness",
};
const planEffect = (cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      root = yield* fs.realPath(resolve(cwd));
    const names: string[] = [];
    for (const name of [".sandcastle/main.ts", ".sandcastle/main.mts"])
      if ((yield* read(fs, root, name)) !== null) names.push(name);
    const name = names[0] ?? ".sandcastle/main.ts";
    const text = names.length === 1 ? (yield* read(fs, root, name))! : "";
    let template: string | null = null;
    for (const profile of ["reviewed", "node", "android"]) {
      const baseline = yield* fs.readFileString(
        join(templateDirectory, "migrations", profile + ".txt"),
      );
      if (shape(text) === shape(baseline)) template = profile;
    }
    const base: ProjectMigrationPlan = {
      status: "unsupported",
      template,
      revision: digest(text),
      runtime: null,
      files: [],
      conflicts: [],
      prompts: [],
      instructions:
        "Workflow is unsupported and remains unchanged. Manually adopt createProjectRuntime/openProjectRuntime, runtime.agent and runtime.promptFile in your project adapter; preserve sandbox, gates and qualification policy. Never evaluate legacy code to discover settings.",
    };
    const recovery = yield* read(
      fs,
      root,
      ".sandcastle/migrations/latest.json",
    );
    if (recovery !== null) {
      const journal = yield* Effect.try({
        try: () => journalSchema.parse(JSON.parse(recovery)),
        catch: () =>
          new OperatorError({ message: "Invalid migration recovery record" }),
      });
      if (journal.status === "applying")
        return {
          ...base,
          status: "unsupported" as const,
          instructions:
            "Interrupted migration; reconcile its stopped owner and run migration --rollback before applying another plan",
        };
    }
    const marker = yield* read(fs, root, ".sandcastle/migration.json");
    if (marker) {
      const record = yield* Effect.try({
        try: () =>
          z
            .object({
              schemaVersion: z.literal(1),
              template: z.enum(["reviewed", "node", "android"]),
              workflowDigest: z.string().regex(/^[a-f0-9]{64}$/),
              recognizedAgainst: z.string().regex(/^[a-f0-9]{40}$/),
              originalSourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
              recognizerIntegrity: z.string().regex(/^[a-f0-9]{64}$/),
              runtime: z.unknown(),
            })
            .strict()
            .parse(JSON.parse(marker)),
        catch: () =>
          new OperatorError({
            message:
              "Invalid migration provenance; recover the marker from the private migration record or adapt manually",
          }),
      });
      if (
        record.schemaVersion === 1 &&
        record.workflowDigest === digest(text)
      ) {
        base.status = "current";
        base.template = record.template;
      } else if (!template) return base;
    }
    if (!template && base.status !== "current") return base;
    // These anchors must retain their public meaning, even when literal settings differ.
    if (
      base.status !== "current" &&
      (!text.includes('from "@ai-hero/sandcastle"') ||
        !text.includes('from "@ai-hero/sandcastle/sandboxes/docker"') ||
        Object.values(filename).some(
          (file) =>
            !text.includes(
              'promptFile: "./.sandcastle/' + file + '-prompt.md"',
            ),
        ))
    )
      return base;
    const runtime = yield* attempt(() =>
      planRuntimeUpdate({ cwd: root, version: null }),
    );
    base.runtime = runtime;
    // Import only the explicitly installed fork SDK, never the legacy workflow.
    // Execute no run or project script; this verifies the required versioned APIs.
    const installed = runtime.installed;
    const compatible = installed
      ? yield* Effect.async<boolean>((resume) => {
          const child = execFile(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `const sdk=await import(${JSON.stringify(runtime.config.dependency)});if(sdk.runtimeVersion!==${JSON.stringify(installed.version)} || ['createProjectRuntime','openProjectRuntime','loadRoleConfig','loadWorkflowConfig','loadEnvironmentConfig','loadProjectPrompts'].some(name=>typeof sdk[name]!=='function'))process.exit(1);`,
            ],
            {
              cwd: dirname(join(root, runtime.config.manifest)),
              timeout: 30000,
              maxBuffer: 65536,
            },
            (error) => resume(Effect.succeed(!error)),
          );
          return Effect.sync(() => child.kill());
        })
      : false;
    if (!compatible)
      return {
        ...base,
        status: "unsupported" as const,
        instructions:
          "Install a compatible fork runtime exposing versioned role, workflow, environment and prompt APIs, then preview again. Legacy workflow code remains unchanged.",
      };
    base.instructions =
      "Review the file diffs. Preserve prompt overrides explicitly when their base/default differs. Migration does not establish readiness or acceptance. Runtime rollback and migration rollback are separate; roll back migration first.";
    const snapshots: MigrationFile[] = [];
    const add = (path: string, after: string | null) =>
      Effect.gen(function* () {
        snapshots.push({ path, before: yield* read(fs, root, path), after });
      });
    const preserve = (path: string) =>
      Effect.gen(function* () {
        const value = yield* read(fs, root, path);
        snapshots.push({ path, before: value, after: value });
      });
    for (const path of [
      ".sandcastle/environment.json",
      ".sandcastle/readiness.json",
      ".sandcastle/feedback-gates.json",
      ".sandcastle/project.json",
      ".sandcastle/Dockerfile",
      ".sandcastle/CODING_STANDARDS.md",
      ".sandcastle/FEEDBACK_LOOPS.md",
      ".sandcastle/EVIDENCE_POLICY.md",
      ".sandcastle/scripts/ready.sh",
      ".sandcastle/prompts/defaults.json",
      ...operatorRoles.map((role) => ".sandcastle/prompts/" + role + ".json"),
    ])
      yield* preserve(path);
    if (base.status === "current") {
      yield* loadRoleConfigEffect(root);
      yield* loadWorkflowSnapshotEffect(root);
      yield* loadEnvironmentConfigEffect(root);
      yield* preserve(name);
      yield* preserve(".sandcastle/roles.json");
      yield* preserve(".sandcastle/workflow.json");
      yield* preserve(".sandcastle/migration.json");
    } else {
      const isolated = text.includes("const codexAgent =");
      const roles = defaultRoleConfig();
      const order = [
        "readiness",
        "planner",
        "implementer",
        "reviewer",
        "merger",
      ] as const;
      const matches = [
        ...text.matchAll(
          /agent: (?:sandcastle\.codex\(([^\n]*)\)|codexAgent\(([^\n]*)\)),/g,
        ),
      ];
      if (matches.length !== 5)
        return { ...base, status: "unsupported" as const };
      const model = isolated
        ? /sandcastle\.codex\("([^"\n]+)",/.exec(text)?.[1]
        : null;
      const defaultEffort = isolated
        ? /const codexAgent[^\n]*= "(low|medium|high|xhigh)"/.exec(text)?.[1]
        : null;
      for (let index = 0; index < order.length; index++) {
        const role = order[index]!,
          args = matches[index]!;
        const settings = isolated ? null : readLegacyRoleCall(args[1] ?? "");
        const selected = model ?? settings?.model;
        const effort = isolated
          ? (/^"(low|medium|high|xhigh)"$/.exec(args[2] ?? "")?.[1] ??
            defaultEffort)
          : settings?.effort;
        if ((!isolated && !settings?.supported) || !selected)
          return { ...base, status: "unsupported" as const };
        roles.roles[role] = {
          provider: "codex",
          model: selected,
          effort: (effort ??
            roles.roles[role]
              .effort) as (typeof roles.roles)[typeof role]["effort"],
        };
      }
      roles.revision = roleConfigRevision(roles);
      const validated = yield* Effect.try({
        try: () => roleConfigSchema.parse(roles),
        catch: () =>
          new OperatorError({
            message: "Legacy role settings are not compatible; adapt manually",
          }),
      });
      const existingRoles = yield* read(fs, root, ".sandcastle/roles.json");
      yield* add(
        ".sandcastle/roles.json",
        serialized(
          existingRoles ? yield* loadRoleConfigEffect(root) : validated,
        ),
      );
      const workflow = yield* loadWorkflowSnapshotEffect(root);
      const cycles = Number(/const MAX_ITERATIONS = (\d+);/.exec(text)?.[1]);
      const plannerAttempts = Number(
        /const MAX_PLANNER_ATTEMPTS = (\d+);/.exec(text)?.[1],
      );
      if (!(yield* read(fs, root, ".sandcastle/workflow.json"))) {
        workflow.config.limits.cycles = cycles;
        workflow.config.limits.plannerAttempts = plannerAttempts;
        workflow.config.revision = workflowConfigRevision(workflow.config);
        yield* Effect.try({
          try: () => workflowConfigSchema.parse(workflow.config),
          catch: () =>
            new OperatorError({
              message:
                "Legacy workflow limits are not compatible; adapt manually",
            }),
        });
      }
      yield* add(".sandcastle/workflow.json", serialized(workflow.config));
      const environment = yield* loadEnvironmentConfigEffect(root);
      const sandbox = rewriteSandboxImages(text, "docker", null);
      const images = sandbox.images.filter((image) => image !== null);
      if (!sandbox.supported || new Set(sandbox.images).size > 1)
        return {
          ...base,
          status: "unsupported" as const,
          instructions:
            "Dynamic or different per-role images require manual adaptation; preserve sandbox configuration in your project adapter.",
        };
      if (images.length) {
        const existingEnvironment = yield* read(
          fs,
          root,
          ".sandcastle/environment.json",
        );
        if (existingEnvironment && environment.image !== images[0])
          return {
            ...base,
            status: "unsupported" as const,
            instructions:
              "Legacy image conflicts with environment.json. Resolve the image selection on the host, then preview again.",
          };
        environment.image = images[0]!;
        yield* validateEnvironmentConfigEffect(environment);
        yield* add(".sandcastle/environment.json", serialized(environment));
      }
      const prepared = sandbox.content
        .replace(/const MAX_ITERATIONS = \d+;/, "const MAX_ITERATIONS = 10;")
        .replace(
          /const MAX_PLANNER_ATTEMPTS = \d+;/,
          "const MAX_PLANNER_ATTEMPTS = 3;",
        );
      const adapted = yield* wireReviewedRuntime(prepared, "docker");
      if (
        !adapted.includes(
          "const runtime = process.env.SANDCASTLE_RUNTIME_ID",
        ) ||
        !adapted.includes("const readiness = runtime.readiness;") ||
        !adapted.includes("const settled = await runtime.settleIssues") ||
        (adapted.match(/agent: runtime.agent/g)?.length ?? 0) !== 5 ||
        (adapted.match(/promptFile: runtime.promptFile/g)?.length ?? 0) !== 5
      )
        return {
          ...base,
          status: "unsupported" as const,
          instructions:
            "Generated runtime anchors differ; manually adopt the shared entrypoint without overwriting your project workflow.",
        };
      yield* add(name, adapted);
      yield* add(
        ".sandcastle/migration.json",
        serialized({
          schemaVersion: 1,
          template,
          workflowDigest: digest(adapted),
          recognizedAgainst: "a22f71e6713d7fdba64f38b030c529aabcd58690",
          originalSourceDigest: digest(text),
          recognizerIntegrity: digest(
            yield* fs.readFileString(
              join(templateDirectory, "migrations", template + ".txt"),
            ),
          ),
          runtime: runtime.installed,
        }),
      );
      const ignore = yield* read(fs, root, ".sandcastle/.gitignore");
      yield* add(
        ".sandcastle/.gitignore",
        (ignore ?? "") + "\nruntime/\nmigrations/\n",
      );
    }
    const hasDefaults =
      (yield* read(fs, root, ".sandcastle/prompts/defaults.json")) !== null;
    const selectedPrompts = yield* loadProjectPromptsEffect({
      cwd: root,
      promptFiles: Object.fromEntries(
        operatorRoles.map((role) => [
          role,
          ".sandcastle/" + filename[role] + "-prompt.md",
        ]),
      ) as Record<(typeof operatorRoles)[number], string>,
    });
    const bases = yield* json<Record<string, string>>(
      yield* fs.readFileString(
        join(templateDirectory, "migrations", base.template! + "-prompts.json"),
      ),
    );
    for (const role of operatorRoles) {
      const path = ".sandcastle/" + filename[role] + "-prompt.md";
      yield* preserve(path);
      const local = snapshots.at(-1)!.before;
      if (local === null)
        return yield* fail(
          "Missing project prompt; restore it before migrating",
        );
      let current = yield* fs.readFileString(
        join(
          templateDirectory,
          "parallel-planner-with-review",
          filename[role] + "-prompt.md",
        ),
      );
      current = current
        .replaceAll("{{VIEW_TASK_COMMAND}}", "gh issue view <ID>")
        .replaceAll(
          "{{CLOSE_TASK_COMMAND}}",
          'gh issue close <ID> --comment "Completed by Sandcastle"',
        );
      // Show known base/default separately; never reset customized text implicitly.
      const hasOverride =
        (yield* read(fs, root, ".sandcastle/prompts/" + role + ".json")) !==
        null;
      const selected = selectedPrompts[role]!;
      const original =
        hasDefaults || hasOverride ? selected.base.content : bases[role]!;
      const effective = hasDefaults || hasOverride ? selected.content : local;
      if (hasDefaults) current = selected.default.content;
      base.prompts.push({
        role,
        base: original,
        default: current,
        override: effective,
      });
      if (effective !== original || current !== original)
        base.conflicts.push(role);
      if (base.status !== "current" && !hasDefaults && !hasOverride) {
        yield* add(
          ".sandcastle/prompts/" + role + ".json",
          serialized({
            schemaVersion: 1,
            content: local,
            base: { content: original, version: digest(original) },
          }),
        );
      }
    }
    if (
      base.status !== "current" &&
      !(yield* read(fs, root, ".sandcastle/prompts/defaults.json"))
    ) {
      yield* add(
        ".sandcastle/prompts/defaults.json",
        serialized({
          schemaVersion: 1,
          template: "parallel-planner-with-review",
          templateArgs: {
            VIEW_TASK_COMMAND: "gh issue view <ID>",
            CLOSE_TASK_COMMAND:
              'gh issue close <ID> --comment "Completed by Sandcastle"',
          },
          bases: Object.fromEntries(
            operatorRoles.map((role) => [
              role,
              { content: bases[role]!, version: digest(bases[role]!) },
            ]),
          ),
        }),
      );
    }
    if (base.status !== "current") {
      base.status =
        runtime.action === "current" && runtime.installed?.provenance
          ? "ready"
          : "unsupported";
      if (base.status === "unsupported")
        base.instructions =
          "Install the reviewed fork runtime with sandcastle updates --install first, then preview migration again. Archive source/integrity must match; a package version alone is insufficient.";
    }
    base.files = [
      ...new Map(snapshots.map((file) => [file.path, file])).values(),
    ];
    base.revision = digest(
      JSON.stringify({
        runtime: runtime.revision,
        files: base.files,
        prompts: base.prompts,
        status: base.status,
        template: base.template,
      }),
    );
    return base;
  });
/** Inspect known generated consumers statically, including runtime and managed-file provenance. */
export const planProjectMigration = (options: {
  /** Selected host project. */ cwd: string;
}): Promise<ProjectMigrationPlan> => run(planEffect(options.cwd));

const managedNames = new Set([
  ".sandcastle/main.ts",
  ".sandcastle/main.mts",
  ".sandcastle/roles.json",
  ".sandcastle/workflow.json",
  ".sandcastle/environment.json",
  ".sandcastle/migration.json",
  ".sandcastle/.gitignore",
  ".sandcastle/prompts/defaults.json",
  ...operatorRoles.map((role) => ".sandcastle/prompts/" + role + ".json"),
]);
const observedNames = new Set([
  ...managedNames,
  ".sandcastle/environment.json",
  ".sandcastle/readiness.json",
  ".sandcastle/feedback-gates.json",
  ".sandcastle/project.json",
  ".sandcastle/Dockerfile",
  ".sandcastle/CODING_STANDARDS.md",
  ".sandcastle/FEEDBACK_LOOPS.md",
  ".sandcastle/EVIDENCE_POLICY.md",
  ".sandcastle/scripts/ready.sh",
  ...Object.values(filename).map(
    (name) => ".sandcastle/" + name + "-prompt.md",
  ),
]);
const observationSchema = z
  .object({
    path: z.string().refine((path) => observedNames.has(path)),
    before: z.string().nullable(),
    after: z.string().nullable(),
  })
  .strict();
const fileSchema = z
  .object({
    path: z.string().refine((path) => managedNames.has(path)),
    before: z.string().nullable(),
    after: z.string().nullable(),
  })
  .strict();
const journalSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["applying", "completed", "failed", "rolled-back"]),
    files: z.array(fileSchema),
    observations: z.array(observationSchema),
    attempted: z.array(z.string().refine((path) => managedNames.has(path))),
    runtime: z.unknown(),
  })
  .strict();
type Journal = z.infer<typeof journalSchema>;
const storeEffect = (fs: FileSystem.FileSystem, root: string) =>
  Effect.gen(function* () {
    const store = yield* safe(fs, root, ".sandcastle/migrations");
    yield* fs.makeDirectory(store, { recursive: true, mode: 0o700 });
    yield* writePrivateRecord(
      fs,
      yield* safe(fs, root, ".sandcastle/migrations/.gitignore"),
      "*\n",
    );
    return yield* safe(fs, root, ".sandcastle/migrations/latest.json");
  });
const restoreEffect = (
  fs: FileSystem.FileSystem,
  root: string,
  journal: Journal,
) =>
  Effect.gen(function* () {
    for (const name of [...journal.attempted].reverse()) {
      const file = journal.files.find((item) => item.path === name);
      if (!file) return yield* fail("Invalid migration recovery record");
      const current = yield* read(fs, root, name);
      if (current === file.before) continue;
      if (current !== file.after)
        return yield* fail(
          "Managed file changed after migration: " +
            name +
            ". Preserve host edits and reconcile manually before rollback.",
        );
      const target = yield* safe(fs, root, name);
      if (file.before === null) {
        if (yield* fs.exists(target)) yield* fs.remove(target);
      } else yield* writePrivateRecord(fs, target, file.before);
    }
  });
const locked = <A, E>(
  cwd: string,
  operation: Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.acquireUseRelease(
    attempt(() => claimRuntimeRun(cwd)),
    () => operation,
    (release) => attempt(release).pipe(Effect.orDie),
  );
/** Apply the exact reviewed migration, retaining a private recovery record. Only managed files are backed up. */
export const applyProjectMigration = (options: {
  /** Selected project. */ cwd: string;
  /** Reviewed source snapshot. */ expectedRevision: string;
  /** Explicitly retain every prompt conflict. */ preserveOverrides: boolean;
  /** Safe progress notifications; listener failures trigger recovery. */ onProgress: (
    phase: string,
  ) => void;
}): Promise<{
  /** Completed promotion or an unchanged prior application. */ status:
    | "completed"
    | "current";
}> =>
  run(
    locked(
      options.cwd,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem,
          root = yield* fs.realPath(resolve(options.cwd));
        yield* assertInactive(fs, root);
        const plan = yield* planEffect(root);
        if (plan.revision !== options.expectedRevision) {
          const priorPath = yield* safe(
            fs,
            root,
            ".sandcastle/migrations/latest.json",
          );
          if (plan.status === "current" && (yield* fs.exists(priorPath))) {
            const prior = yield* fs.readFileString(priorPath).pipe(
              Effect.flatMap((text) =>
                Effect.try({
                  try: () => journalSchema.parse(JSON.parse(text)),
                  catch: () =>
                    new OperatorError({
                      message: "Invalid migration recovery record",
                    }),
                }),
              ),
            );
            if (
              prior.status === "completed" &&
              prior.revision === options.expectedRevision &&
              JSON.stringify(prior.runtime) === JSON.stringify(plan.runtime)
            ) {
              let unchanged = true;
              for (const file of prior.observations)
                if ((yield* read(fs, root, file.path)) !== file.after)
                  unchanged = false;
              if (unchanged) return { status: "current" as const };
            }
          }
          return yield* fail(
            "Migration source snapshot changed; preview the file diffs again",
          );
        }
        if (plan.status === "unsupported")
          return yield* fail(plan.instructions);
        if (plan.status === "current") return { status: "current" as const };
        if (plan.conflicts.length && options.preserveOverrides !== true)
          return yield* fail(
            "Prompt conflicts require explicit preserveOverrides confirmation; review base/default diffs first",
          );
        const journalPath = yield* storeEffect(fs, root);
        if (yield* fs.exists(journalPath)) {
          const prior = yield* fs.readFileString(journalPath).pipe(
            Effect.flatMap((text) =>
              Effect.try({
                try: () => journalSchema.parse(JSON.parse(text)),
                catch: () =>
                  new OperatorError({
                    message: "Invalid migration recovery record",
                  }),
              }),
            ),
          );
          if (prior.status === "applying")
            return yield* fail(
              "Interrupted migration; run migration --rollback before applying another plan",
            );
        }
        const journal: Journal = {
          schemaVersion: 1,
          revision: plan.revision,
          status: "applying",
          files: plan.files.filter((file) => file.before !== file.after),
          observations: plan.files,
          attempted: [],
          runtime: plan.runtime,
        };
        const save = () =>
          writePrivateRecord(fs, journalPath, serialized(journal));
        yield* save();
        const notify = (phase: string) =>
          Effect.try({
            try: () => options.onProgress(phase),
            catch: () =>
              new OperatorError({
                message:
                  "Migration interrupted by progress listener; restoring managed files",
              }),
          });
        const promote = Effect.gen(function* () {
          // Revalidate all preservation inputs immediately before the first write.
          for (const file of plan.files)
            if ((yield* read(fs, root, file.path)) !== file.before)
              return yield* fail(
                "Migration source snapshot changed during apply; preview again",
              );
          yield* assertInactive(fs, root);
          for (const file of journal.files) {
            if ((yield* read(fs, root, file.path)) !== file.before)
              return yield* fail(
                "Migration source snapshot changed during apply: " + file.path,
              );
            const target = yield* safe(fs, root, file.path);
            yield* fs.makeDirectory(dirname(target), {
              recursive: true,
              mode: 0o700,
            });
            journal.attempted.push(file.path);
            yield* save();
            if (file.after === null) yield* fs.remove(target);
            else yield* writePrivateRecord(fs, target, file.after);
            yield* notify("Updated " + file.path);
          }
          journal.status = "completed";
          yield* save();
          return { status: "completed" as const };
        });
        return yield* promote.pipe(
          Effect.catchAll((error) =>
            Effect.gen(function* () {
              yield* restoreEffect(fs, root, journal);
              journal.status = "failed";
              yield* save();
              return yield* Effect.fail(error);
            }),
          ),
        );
      }),
    ),
  );
/** Restore only migration-owned files. Host edits are never silently overwritten; restore migration before rolling back the runtime. */
export const rollbackProjectMigration = (options: {
  /** Selected project. */ cwd: string;
}): Promise<void> =>
  run(
    locked(
      options.cwd,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem,
          root = yield* fs.realPath(resolve(options.cwd));
        yield* assertInactive(fs, root);
        const path = yield* storeEffect(fs, root);
        const journal = yield* fs.readFileString(path).pipe(
          Effect.flatMap((text) =>
            Effect.try({
              try: () => journalSchema.parse(JSON.parse(text)),
              catch: () =>
                new OperatorError({
                  message: "Invalid migration recovery record",
                }),
            }),
          ),
        );
        if (journal.status === "rolled-back" || journal.status === "failed")
          return;
        // Validate every destination before restoring any of them.
        for (const file of journal.files) {
          if (!journal.attempted.includes(file.path)) continue;
          const current = yield* read(fs, root, file.path);
          if (current !== file.after && current !== file.before)
            return yield* fail(
              "Managed file changed after migration: " +
                file.path +
                ". Preserve host edits and reconcile manually before rollback.",
            );
        }
        yield* restoreEffect(fs, root, journal);
        journal.status = "rolled-back";
        yield* writePrivateRecord(fs, path, serialized(journal));
      }),
    ),
  );
