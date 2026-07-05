import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { JsonSchema } from "./types.js";

export interface JsonSchemaIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export type JsonSchemaValidationResult<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly JsonSchemaIssue[] };

export function validateJsonSchemaValue<T = unknown>(
  schema: JsonSchema,
  value: unknown,
): JsonSchemaValidationResult<T> {
  const issues: JsonSchemaIssue[] = [];
  validateValue(schema, value, [], issues);

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, value: value as T };
}

export function jsonSchemaToStandardSchema<T = unknown>(
  schema: JsonSchema,
): StandardSchemaV1<unknown, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "sandcastle",
      validate: (value: unknown) => {
        const result = validateJsonSchemaValue<T>(schema, value);

        if (result.ok) {
          return { value: result.value };
        }

        return {
          issues: result.issues.map((issue) => ({
            message: issue.message,
            path: issue.path,
          })),
        };
      },
    },
  };
}

const validateValue = (
  schema: JsonSchema,
  value: unknown,
  path: readonly (string | number)[],
  issues: JsonSchemaIssue[],
): void => {
  switch (schema.type) {
    case "object":
      validateObject(schema, value, path, issues);
      return;
    case "array":
      validateArray(schema, value, path, issues);
      return;
    case "string":
      validateString(schema, value, path, issues);
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        addIssue(issues, path, "Expected number");
      }
      return;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        addIssue(issues, path, "Expected integer");
      }
      return;
    case "boolean":
      if (typeof value !== "boolean") {
        addIssue(issues, path, "Expected boolean");
      }
      return;
  }
};

const validateObject = (
  schema: Extract<JsonSchema, { type: "object" }>,
  value: unknown,
  path: readonly (string | number)[],
  issues: JsonSchemaIssue[],
): void => {
  if (!isRecord(value)) {
    addIssue(issues, path, "Expected object");
    return;
  }

  const properties = schema.properties ?? {};

  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) {
      addIssue(issues, [...path, key], "Required field is missing");
    }
  }

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (Object.hasOwn(value, key)) {
      validateValue(propertySchema, value[key], [...path, key], issues);
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) {
        addIssue(issues, [...path, key], "Unexpected property");
      }
    }
    return;
  }

  if (
    schema.additionalProperties &&
    typeof schema.additionalProperties !== "boolean"
  ) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) {
        validateValue(
          schema.additionalProperties,
          value[key],
          [...path, key],
          issues,
        );
      }
    }
  }
};

const validateArray = (
  schema: Extract<JsonSchema, { type: "array" }>,
  value: unknown,
  path: readonly (string | number)[],
  issues: JsonSchemaIssue[],
): void => {
  if (!Array.isArray(value)) {
    addIssue(issues, path, "Expected array");
    return;
  }

  if (!schema.items) {
    return;
  }

  for (const [index, item] of value.entries()) {
    validateValue(schema.items, item, [...path, index], issues);
  }
};

const validateString = (
  schema: Extract<JsonSchema, { type: "string" }>,
  value: unknown,
  path: readonly (string | number)[],
  issues: JsonSchemaIssue[],
): void => {
  if (typeof value !== "string") {
    addIssue(issues, path, "Expected string");
    return;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    addIssue(
      issues,
      path,
      `Expected one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`,
    );
  }
};

const addIssue = (
  issues: JsonSchemaIssue[],
  path: readonly (string | number)[],
  message: string,
): void => {
  issues.push({ path, message });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
