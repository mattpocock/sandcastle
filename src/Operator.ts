import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Data, Effect } from "effect";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { CodexOptions } from "./AgentProvider.js";
import { writePrivateRecord } from "./writePrivateRecord.js";

/** The five roles supported by the Codex operator. */
export const operatorRoles = [
  "planner",
  "implementer",
  "reviewer",
  "merger",
  "readiness",
] as const;
/** A role in the reviewed workflow. */
export type OperatorRole = (typeof operatorRoles)[number];
/** Declared Codex capability; custom model IDs use the same provider options. */
export const codexCapability = {
  models: ["gpt-6.1-sol", "gpt-5.4", "gpt-5.4-mini"],
  efforts: ["low", "medium", "high", "xhigh"],
} as const satisfies {
  models: readonly string[];
  efforts: readonly NonNullable<CodexOptions["effort"]>[];
};
/**
 * Declared per-provider capability for schema version 2. `efforts` lists the
 * accepted effort values (mapped to the provider's own flag); `null` means a
 * free-form provider variant; an empty list means the provider has no effort
 * setting. Model suggestions are conveniences, not an availability check.
 */
export const providerCapabilities = {
  codex: { models: codexCapability.models, efforts: codexCapability.efforts },
  claudeCode: {
    models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  pi: {
    models: [],
    efforts: ["off", "minimal", "low", "medium", "high", "xhigh"],
  },
  opencode: { models: [], efforts: null },
  copilot: { models: [], efforts: ["low", "medium", "high"] },
  cursor: { models: [], efforts: [] },
} as const satisfies Record<
  string,
  { models: readonly string[]; efforts: readonly string[] | null }
>;
/** An agent provider selectable in schema version 2. */
export type RoleProvider = keyof typeof providerCapabilities;
export const roleProviders = Object.keys(
  providerCapabilities,
) as RoleProvider[];
/** Maximum fallback entries per role. */
export const maxRoleFallbacks = 3;

const modelSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/,
    "Use a model ID without whitespace or shell syntax",
  );
const roleSchema = z
  .object({
    provider: z.literal("codex"),
    model: modelSchema,
    effort: z.enum(codexCapability.efforts),
  })
  .strict();
const targetShape = {
  provider: z.enum(roleProviders as [RoleProvider, ...RoleProvider[]]),
  model: modelSchema,
  effort: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Use a plain effort value")
    .optional(),
};
const effortIssue = (target: {
  provider: RoleProvider;
  effort?: string;
}): string | null => {
  const efforts = providerCapabilities[target.provider].efforts;
  if (target.effort === undefined || efforts === null) return null;
  if ((efforts as readonly string[]).includes(target.effort)) return null;
  return efforts.length === 0
    ? `${target.provider} has no effort setting`
    : `Unsupported effort for ${target.provider}; use ${efforts.join(", ")}`;
};
const targetSchema = z
  .object(targetShape)
  .strict()
  .superRefine((target, context) => {
    const message = effortIssue(target);
    if (message)
      context.addIssue({ code: "custom", path: ["effort"], message });
  });
const targetKey = (target: {
  provider: string;
  model: string;
  effort?: string;
}) => `${target.provider}\0${target.model}\0${target.effort ?? ""}`;
const roleSchemaV2 = z
  .object({
    ...targetShape,
    fallback: z.array(targetSchema).max(maxRoleFallbacks).optional(),
  })
  .strict()
  .superRefine((role, context) => {
    const message = effortIssue(role);
    if (message)
      context.addIssue({ code: "custom", path: ["effort"], message });
    const seen = new Set([targetKey(role)]);
    role.fallback?.forEach((target, index) => {
      if (seen.has(targetKey(target)))
        context.addIssue({
          code: "custom",
          path: ["fallback", index],
          message: "Fallback repeats the role or an earlier fallback",
        });
      seen.add(targetKey(target));
    });
  });
const rolesOf = <T extends z.ZodTypeAny>(schema: T) =>
  z
    .object({
      planner: schema,
      implementer: schema,
      reviewer: schema,
      merger: schema,
      readiness: schema,
    })
    .strict();
const roleConfigV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.string(),
    roles: rolesOf(roleSchema),
  })
  .strict();
const roleConfigV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    revision: z.string(),
    roles: rolesOf(roleSchemaV2),
  })
  .strict();
/** Internal source-schema validator shared with frozen runtime handoff. Accepts versions 1 and 2. */
export const roleConfigSchema = z.discriminatedUnion("schemaVersion", [
  roleConfigV1Schema,
  roleConfigV2Schema,
]);
/** Versioned, credential-free project configuration. Revision is a content digest. */
export type RoleConfig = z.infer<typeof roleConfigSchema>;
/** One provider/model/effort choice. */
export interface RoleTarget {
  readonly provider: RoleProvider;
  readonly model: string;
  readonly effort?: string;
}
/** A role's effective primary target and ordered fallback chain, independent of schema version. */
export interface RoleSetting extends RoleTarget {
  readonly fallback: readonly RoleTarget[];
}
/** Normalize a role from either schema version. */
export const roleSetting = (
  config: RoleConfig,
  role: OperatorRole,
): RoleSetting => {
  const value = config.roles[role];
  return {
    provider: value.provider,
    model: value.model,
    ...(value.effort === undefined ? {} : { effort: value.effort }),
    fallback: "fallback" in value ? (value.fallback ?? []) : [],
  };
};
/** Explicitly convert a configuration to schema version 2 without changing any role's behaviour. */
export const migrateRoleConfig = (config: RoleConfig): RoleConfig => {
  if (config.schemaVersion === 2) return config;
  const roles = Object.fromEntries(
    operatorRoles.map((role) => [role, { ...config.roles[role] }]),
  ) as unknown as Extract<RoleConfig, { schemaVersion: 2 }>["roles"];
  return {
    schemaVersion: 2,
    roles,
    revision: roleConfigRevision({ schemaVersion: 2, roles }),
  };
};
/** Actionable configuration or runtime failure; never includes credential content. */
export class OperatorError extends Data.TaggedError("OperatorError")<{
  /** Safe diagnostic for the operator. */
  message: string;
}> {}

/** Canonical digest of the validated configuration payload. */
export const roleConfigRevision = (
  config: Pick<RoleConfig, "schemaVersion" | "roles">,
) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: config.schemaVersion,
        roles: config.roles,
      }),
    )
    .digest("hex");
const parseConfig = (input: unknown) =>
  Effect.try({
    try: () => {
      const parsed = roleConfigSchema.parse(input);
      return { ...parsed, revision: roleConfigRevision(parsed) };
    },
    catch: (cause) =>
      new OperatorError({
        message:
          cause instanceof z.ZodError
            ? cause.issues
                .map(
                  (issue) =>
                    `${issue.path.join(".") || "config"}: ${issue.message}`,
                )
                .join("; ")
            : "Invalid role configuration",
      }),
  });
/** Default roles preserve the supplied model; absent configuration uses gpt-6.1-sol. */
export const defaultRoleConfig = (model = "gpt-6.1-sol"): RoleConfig => {
  const roles = Object.fromEntries(
    operatorRoles.map((role) => [
      role,
      {
        provider: "codex",
        model,
        effort: role === "planner" || role === "implementer" ? "low" : "high",
      },
    ]),
  ) as Extract<RoleConfig, { schemaVersion: 1 }>["roles"];
  return {
    schemaVersion: 1,
    roles,
    revision: roleConfigRevision({ schemaVersion: 1, roles }),
  };
};
/** Internal Effect entry point for atomic runtime configuration reads. */
export const loadRoleConfigEffect = (cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = join(cwd, ".sandcastle", "roles.json");
    if (!(yield* fs.exists(path))) return defaultRoleConfig();
    const text = yield* fs.readFileString(path);
    const input = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () =>
        new OperatorError({
          message:
            "roles.json: invalid JSON; repair or remove the file to use defaults",
        }),
    });
    const config = yield* parseConfig(input);
    if ((input as RoleConfig).revision !== config.revision)
      return yield* Effect.fail(
        new OperatorError({
          message:
            "roles.json: revision does not match settings; save through the configuration interface",
        }),
      );
    return config;
  }).pipe(
    Effect.mapError((error) =>
      error instanceof OperatorError
        ? error
        : new OperatorError({
            message:
              "Cannot read .sandcastle/roles.json; check project permissions",
          }),
    ),
  );
/** Load validated settings from an explicit host project. Only a missing file uses defaults. */
export const loadRoleConfig = (options: {
  /** Host project directory. */ cwd: string;
}): Promise<RoleConfig> =>
  Effect.runPromise(
    loadRoleConfigEffect(options.cwd).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );
/** Internal validated atomic save used by init and public host APIs. */
export const saveRoleConfigEffect = (options: {
  cwd: string;
  config: unknown;
}) =>
  Effect.gen(function* () {
    const config = yield* parseConfig(options.config);
    const fs = yield* FileSystem.FileSystem;
    const directory = join(options.cwd, ".sandcastle");
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* writePrivateRecord(
      fs,
      join(directory, "roles.json"),
      JSON.stringify(config, null, 2) + "\n",
    );
    return config;
  }).pipe(
    Effect.mapError((error) =>
      error instanceof OperatorError
        ? error
        : new OperatorError({
            message:
              "Cannot save .sandcastle/roles.json; check project permissions",
          }),
    ),
  );
/** Validate the complete document before atomically replacing roles.json. */
export const saveRoleConfig = (options: {
  /** Host project directory. */
  cwd: string;
  /** Complete version-one or version-two configuration; unknown fields are rejected. */
  config: unknown;
}): Promise<RoleConfig> =>
  Effect.runPromise(
    saveRoleConfigEffect(options).pipe(Effect.provide(NodeFileSystem.layer)),
  );
