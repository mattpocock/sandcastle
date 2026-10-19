import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { operatorRoles, OperatorError, type OperatorRole } from "./Operator.js";
import { writePrivateRecord } from "./writePrivateRecord.js";

/** Trusted project-owned prompt sources, shared by web and runtime. */
export interface ProjectPromptOptions {
  /** Explicit host project. */ cwd: string;
  /** Versioned default source paths, never editable HTTP fields. Null disables a role. */ promptFiles: Record<
    OperatorRole,
    string | null
  >;
}
const versionSchema = z
  .object({ content: z.string(), version: z.string() })
  .strict();
const overrideSchema = z
  .object({
    schemaVersion: z.literal(1),
    content: z.string().nullable(),
    base: versionSchema,
  })
  .strict();
/** Content-addressed default version; changing packaged text changes its identity. */
export interface PromptVersion {
  /** Template text, rendered as data. */ content: string;
  /** SHA-256 default content identity. */ version: string;
}
/** Effective template together with current default and the customization's original base. */
export interface ProjectPrompt {
  /** Selected template. */ content: string;
  /** Ownership of the selected text. */ status: "default" | "override";
  /** Current trusted default. */ default: PromptVersion;
  /** Default at first customization; retained across subsequent edits and upgrades. */ base: PromptVersion;
  /** Whether the current default differs from the customization base. */ defaultChanged: boolean;
}
const version = (content: string): PromptVersion => ({
  content,
  version: createHash("sha256").update(content).digest("hex"),
});
const validate = (role: string, content: unknown, bases: string[]) =>
  Effect.gen(function* () {
    if (
      typeof content !== "string" ||
      !content.trim() ||
      content.length > 1_048_576
    )
      return yield* fail(
        role + ": provide a nonempty template of at most 1,048,576 characters",
      );
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content))
      return yield* fail(
        role + ": control characters are not accepted in prompt text",
      );
    const placeholders = (text: string) =>
      [...text.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map(
        (match) => match[1]!,
      );
    const allowed = new Set(bases.flatMap(placeholders));
    for (const key of placeholders(content))
      if (!allowed.has(key))
        return yield* fail(
          role +
            ": unknown placeholder {{" +
            key +
            "}}; use placeholders from the default",
        );
    for (const key of placeholders(bases[0]!))
      if (!placeholders(content).includes(key))
        return yield* fail(
          role + ": preserve required placeholder {{" + key + "}}",
        );
    if (
      /\{\{|\}\}/.test(
        content.replace(/\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/g, ""),
      )
    )
      return yield* fail(
        role + ": malformed template placeholder; use {{NAME}}",
      );
    const required = [
      ...bases[0]!.matchAll(/<promise>[^<]+<\/promise>|<[a-z][a-z0-9_-]*>/g),
    ].map((match) => match[0]);
    for (const literal of required)
      if (!content.includes(literal))
        return yield* fail(
          role + ": preserve required runtime output " + literal,
        );
    const expressions = (text: string) =>
      [...text.matchAll(/!`[^`]*`/g)].map((match) => match[0]);
    const trusted = new Set(bases.flatMap(expressions));
    for (const expression of expressions(content))
      if (!trusted.has(expression))
        return yield* fail(
          role +
            ": new shell expressions are not accepted by the operator; keep project execution policy in trusted defaults",
        );
    if (content.replace(/!`[^`]*`/g, "").includes("!`"))
      return yield* fail(role + ": unterminated shell expression");
  });
const packagedConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    template: z.literal("parallel-planner-with-review"),
    templateArgs: z
      .object({
        VIEW_TASK_COMMAND: z.string().min(1),
        CLOSE_TASK_COMMAND: z.string().min(1),
      })
      .strict(),
    bases: z
      .object({
        planner: versionSchema,
        implementer: versionSchema,
        reviewer: versionSchema,
        merger: versionSchema,
        readiness: versionSchema,
      })
      .strict(),
  })
  .strict();
const filenames: Record<OperatorRole, string> = {
  planner: "plan",
  implementer: "implement",
  reviewer: "review",
  merger: "merge",
  readiness: "readiness",
};
const packagedDefault = (
  role: OperatorRole,
  args: { VIEW_TASK_COMMAND: string; CLOSE_TASK_COMMAND: string },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let content = yield* fs.readFileString(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "templates",
        "parallel-planner-with-review",
        filenames[role] + "-prompt.md",
      ),
    );
    for (const [key, value] of Object.entries(args))
      content = content.replaceAll("{{" + key + "}}", value);
    return version(content);
  });
const readManaged = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (
      (yield* fs.realPath(path)).replace(/\\/g, "/") !==
      path.replace(/\\/g, "/")
    )
      return yield* fail("Managed prompt record must not be a symbolic link");
    return yield* fs.readFileString(path);
  });
const fail = (message: string) => Effect.fail(new OperatorError({ message }));
const safeDirectory = (cwd: string, create: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(resolve(cwd));
    let path = root;
    for (const name of [".sandcastle", "prompts"]) {
      path = join(path, name);
      if (!(yield* fs.exists(path))) {
        if (!create) return null;
        yield* fs.makeDirectory(path, { recursive: true, mode: 0o700 });
      }
      if (
        (yield* fs.realPath(path)).replace(/\\/g, "/") !==
        path.replace(/\\/g, "/")
      )
        return yield* fail(
          "Managed prompt directory must not be a symbolic link",
        );
    }
    return path;
  });
const guard = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  effect.pipe(
    Effect.mapError((error) =>
      error instanceof OperatorError
        ? error
        : new OperatorError({
            message:
              "Cannot read or save managed prompts; check prompt paths and permissions",
          }),
    ),
  );
/** Internal Effect resolution shared with run snapshot creation. */
export const loadProjectPromptsEffect = (options: ProjectPromptOptions) =>
  guard(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* safeDirectory(options.cwd, false);
      const configPath = directory && join(directory, "defaults.json");
      let packaged: z.infer<typeof packagedConfigSchema> | null = null;
      if (configPath && (yield* fs.exists(configPath))) {
        const text = yield* readManaged(configPath);
        packaged = yield* Effect.try({
          try: () => packagedConfigSchema.parse(JSON.parse(text)),
          catch: () =>
            new OperatorError({
              message: "Invalid packaged prompt defaults configuration",
            }),
        });
        for (const base of Object.values(packaged.bases))
          if (version(base.content).version !== base.version)
            return yield* fail("Invalid packaged prompt base version");
      }
      const prompts = {} as Record<OperatorRole, ProjectPrompt | null>;
      for (const role of operatorRoles) {
        const source = options.promptFiles[role];
        if (source === null) {
          prompts[role] = null;
          continue;
        }
        const sourcePath = resolve(options.cwd, source);
        const local =
          packaged && !(yield* fs.exists(sourcePath))
            ? null
            : version(yield* fs.readFileString(sourcePath));
        const current = packaged
          ? yield* packagedDefault(role, packaged.templateArgs)
          : local!;
        const originalBase = packaged?.bases[role] ?? current;
        const customized =
          packaged && local && local.version !== originalBase.version;

        const path = directory && join(directory, role + ".json");
        let override: z.infer<typeof overrideSchema> | null = null;
        if (path && (yield* fs.exists(path))) {
          const text = yield* readManaged(path);
          override = yield* Effect.try({
            try: () => overrideSchema.parse(JSON.parse(text)),
            catch: () =>
              new OperatorError({
                message: role + ": invalid prompt override record",
              }),
          });
          if (version(override.base.content).version !== override.base.version)
            return yield* fail(role + ": invalid base version");
        }
        const effective = override
          ? override.content
          : customized
            ? local!.content
            : null;
        const base =
          effective === null ? current : (override?.base ?? originalBase);
        prompts[role] = {
          content: effective ?? current.content,
          status: effective !== null ? "override" : "default",
          default: current,
          base,
          defaultChanged:
            effective !== null && base.version !== current.version,
        };
      }
      return prompts;
    }),
  );
/** Load effective prompts and their versioned default/base evidence. */
export const loadProjectPrompts = (
  options: ProjectPromptOptions,
): Promise<Record<OperatorRole, ProjectPrompt | null>> =>
  Effect.runPromise(
    loadProjectPromptsEffect(options).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );
/** Save an override, or reset with null, within managed project storage. */
export const saveProjectPrompt = (
  options: ProjectPromptOptions & {
    /** Fixed role name, never a filesystem path. */ role: string;
    /** Template override; null resets to the current default. */ content:
      | string
      | null;
  },
): Promise<void> =>
  Effect.runPromise(
    guard(
      Effect.gen(function* () {
        if (!operatorRoles.includes(options.role as OperatorRole))
          return yield* fail("Unknown prompt role");
        const role = options.role as OperatorRole;
        const prompts = yield* loadProjectPromptsEffect(options);
        const prompt = prompts[role];
        if (!prompt)
          return yield* fail(role + ": no default prompt configured");
        const directory = yield* safeDirectory(options.cwd, true);
        const fs = yield* FileSystem.FileSystem;
        const path = join(directory!, role + ".json");
        if (options.content !== null)
          yield* validate(role, options.content, [
            prompt.base.content,
            prompt.default.content,
          ]);
        yield* writePrivateRecord(
          fs,
          path,
          JSON.stringify(
            { schemaVersion: 1, content: options.content, base: prompt.base },
            null,
            2,
          ) + "\n",
        );
      }),
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );

/** Opt an explicit project into the installed reviewed-workflow defaults. Existing customized files remain overrides; gates and workflows are never rewritten. */
export const usePackagedPromptDefaults = (options: {
  /** Host project directory. */ cwd: string;
  /** Project-owned issue-tracker commands substituted at scaffold time. This trusted host API is never exposed over HTTP. */ templateArgs: {
    VIEW_TASK_COMMAND: string;
    CLOSE_TASK_COMMAND: string;
  };
}): Promise<void> =>
  Effect.runPromise(
    guard(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* safeDirectory(options.cwd, true);
        const path = join(directory!, "defaults.json");
        let bases = {} as Record<OperatorRole, PromptVersion>;
        if (yield* fs.exists(path)) {
          const text = yield* readManaged(path);
          const previous = yield* Effect.try({
            try: () => packagedConfigSchema.parse(JSON.parse(text)),
            catch: () =>
              new OperatorError({
                message: "Invalid packaged prompt defaults configuration",
              }),
          });
          bases = previous.bases;
        } else
          for (const role of operatorRoles)
            bases[role] = yield* packagedDefault(role, options.templateArgs);
        const config = yield* Effect.try({
          try: () =>
            packagedConfigSchema.parse({
              schemaVersion: 1,
              template: "parallel-planner-with-review",
              templateArgs: options.templateArgs,
              bases,
            }),
          catch: () =>
            new OperatorError({
              message: "Provide both project-owned issue-tracker commands",
            }),
        });
        yield* writePrivateRecord(
          fs,
          path,
          JSON.stringify(config, null, 2) + "\n",
        );
      }),
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );
