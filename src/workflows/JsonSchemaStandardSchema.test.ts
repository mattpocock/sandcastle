import { describe, expect, it } from "vitest";
import { Output } from "../Output.js";
import {
  jsonSchemaToStandardSchema,
  validateJsonSchemaValue,
} from "./JsonSchemaStandardSchema.js";
import type { JsonSchema } from "./types.js";

describe("validateJsonSchemaValue", () => {
  it("accepts valid object", () => {
    const schema: JsonSchema = {
      type: "object",
      required: ["name", "age"],
      properties: {
        name: { type: "string" },
        age: { type: "integer" },
        active: { type: "boolean" },
      },
    };

    const result = validateJsonSchemaValue(schema, {
      name: "Ada",
      age: 37,
      active: true,
    });

    expect(result).toEqual({
      ok: true,
      value: { name: "Ada", age: 37, active: true },
    });
  });

  it("rejects missing required field with path", () => {
    const schema: JsonSchema = {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
      },
    };

    const result = validateJsonSchemaValue(schema, {});

    expect(result).toEqual({
      ok: false,
      issues: [{ path: ["name"], message: "Required field is missing" }],
    });
  });

  it("rejects wrong primitive type with path", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        count: { type: "number" },
      },
    };

    const result = validateJsonSchemaValue(schema, { count: "1" });

    expect(result).toEqual({
      ok: false,
      issues: [{ path: ["count"], message: "Expected number" }],
    });
  });

  it("validates array item type with numeric path", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
        },
      },
    };

    const result = validateJsonSchemaValue(schema, {
      names: ["Ada", 123, "Grace"],
    });

    expect(result).toEqual({
      ok: false,
      issues: [{ path: ["names", 1], message: "Expected string" }],
    });
  });

  it("validates enum", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["queued", "done"],
        },
      },
    };

    const result = validateJsonSchemaValue(schema, { status: "running" });

    expect(result).toEqual({
      ok: false,
      issues: [
        { path: ["status"], message: 'Expected one of "queued", "done"' },
      ],
    });
  });

  it("rejects additionalProperties false extras", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      additionalProperties: false,
    };

    const result = validateJsonSchemaValue(schema, {
      id: "task-1",
      extra: true,
    });

    expect(result).toEqual({
      ok: false,
      issues: [{ path: ["extra"], message: "Unexpected property" }],
    });
  });
});

describe("jsonSchemaToStandardSchema", () => {
  it("returns useful Standard Schema issues through ~standard.validate", () => {
    const schema = jsonSchemaToStandardSchema({
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "integer" },
        },
      },
    });

    const result = schema["~standard"].validate({ items: [1, "2"] });

    expect(result).toEqual({
      issues: [{ path: ["items", 1], message: "Expected integer" }],
    });
  });

  it("can be passed to Output.object", () => {
    const schema = jsonSchemaToStandardSchema<{ answer: number }>({
      type: "object",
      required: ["answer"],
      properties: {
        answer: { type: "number" },
      },
    });

    const definition = Output.object({ tag: "result", schema });

    expect(definition.schema["~standard"].validate({ answer: 42 })).toEqual({
      value: { answer: 42 },
    });
  });
});
