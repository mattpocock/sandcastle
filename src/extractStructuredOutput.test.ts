import { describe, expect, it } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { extractStructuredOutput } from "./extractStructuredOutput.js";
import { Output, StructuredOutputError } from "./Output.js";

// ---------------------------------------------------------------------------
// Mock Standard Schema validators
// ---------------------------------------------------------------------------

/** Create a mock Standard Schema that accepts any value and returns it as-is. */
const passthrough = (): StandardSchemaV1<unknown, unknown> => ({
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  },
});

/** Create a mock Standard Schema that validates the value is an object with
 *  the given keys, all of type string. Returns the value typed as T. */
const mockObjectSchema = <T>(): StandardSchemaV1<unknown, T> => ({
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => {
      if (typeof value !== "object" || value === null) {
        return {
          issues: [{ message: "Expected an object" }],
        };
      }
      return { value: value as T };
    },
  },
});

/** Create a mock Standard Schema that always fails validation. */
const alwaysFail = (
  msg = "validation failed",
): StandardSchemaV1<unknown, never> => ({
  "~standard": {
    version: 1,
    vendor: "test",
    validate: () => ({
      issues: [{ message: msg }],
    }),
  },
});

const baseContext = {
  commits: [{ sha: "abc123" }],
  branch: "test-branch",
};

// ---------------------------------------------------------------------------
// Output.object extraction
// ---------------------------------------------------------------------------

describe("extractStructuredOutput — Output.object", () => {
  it("extracts and parses valid JSON from a single tag occurrence", async () => {
    const stdout = 'Some output\n<result>{"answer": 42}</result>\nDone.';
    const def = Output.object({ tag: "result", schema: passthrough() });
    const value = await extractStructuredOutput(stdout, def, baseContext);
    expect(value).toEqual({ answer: 42 });
  });

  it("uses last occurrence when tag appears multiple times", async () => {
    const stdout = [
      '<result>{"answer": 1}</result>',
      "Agent self-correcting...",
      '<result>{"answer": 2}</result>',
    ].join("\n");
    const def = Output.object({ tag: "result", schema: passthrough() });
    const value = await extractStructuredOutput(stdout, def, baseContext);
    expect(value).toEqual({ answer: 2 });
  });

  it("unwraps ```json fence inside tag", async () => {
    const stdout = [
      "<result>",
      "```json",
      '{"name": "test"}',
      "```",
      "</result>",
    ].join("\n");
    const def = Output.object({ tag: "result", schema: passthrough() });
    const value = await extractStructuredOutput(stdout, def, baseContext);
    expect(value).toEqual({ name: "test" });
  });

  it("unwraps bare ``` fence (no language hint) inside tag", async () => {
    const stdout = [
      "<result>",
      "```",
      '{"name": "test"}',
      "```",
      "</result>",
    ].join("\n");
    const def = Output.object({ tag: "result", schema: passthrough() });
    const value = await extractStructuredOutput(stdout, def, baseContext);
    expect(value).toEqual({ name: "test" });
  });

  it("handles JSON without any fence wrapping", async () => {
    const stdout = '<data>{"x": 1}</data>';
    const def = Output.object({ tag: "data", schema: passthrough() });
    const value = await extractStructuredOutput(stdout, def, baseContext);
    expect(value).toEqual({ x: 1 });
  });

  it("throws StructuredOutputError with rawMatched=undefined when tag is missing", async () => {
    const stdout = "No structured output here.";
    const def = Output.object({ tag: "result", schema: passthrough() });
    try {
      await extractStructuredOutput(stdout, def, baseContext);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(StructuredOutputError);
      const soe = err as StructuredOutputError;
      expect(soe.tag).toBe("result");
      expect(soe.rawMatched).toBeUndefined();
      expect(soe.commits).toEqual(baseContext.commits);
      expect(soe.branch).toBe(baseContext.branch);
      expect(soe.message).toContain("<result>");
    }
  });

  it("throws StructuredOutputError with rawMatched set on invalid JSON", async () => {
    const stdout = "<result>not valid json</result>";
    const def = Output.object({ tag: "result", schema: passthrough() });
    try {
      await extractStructuredOutput(stdout, def, baseContext);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(StructuredOutputError);
      const soe = err as StructuredOutputError;
      expect(soe.tag).toBe("result");
      expect(soe.rawMatched).toBe("not valid json");
      expect(soe.cause).toBeInstanceOf(SyntaxError);
      expect(soe.message).toContain("invalid JSON");
    }
  });

  it("throws StructuredOutputError with cause on schema validation failure", async () => {
    const stdout = '<result>{"answer": 42}</result>';
    const def = Output.object({ tag: "result", schema: alwaysFail("bad") });
    try {
      await extractStructuredOutput(stdout, def, baseContext);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(StructuredOutputError);
      const soe = err as StructuredOutputError;
      expect(soe.tag).toBe("result");
      expect(soe.rawMatched).toBeDefined();
      expect(soe.cause).toEqual([{ message: "bad" }]);
      expect(soe.message).toContain("schema validation");
    }
  });

  it("validates parsed JSON against the schema", async () => {
    const stdout = '<result>"not an object"</result>';
    const schema = mockObjectSchema<{ name: string }>();
    const def = Output.object({ tag: "result", schema });
    try {
      await extractStructuredOutput(stdout, def, baseContext);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(StructuredOutputError);
      const soe = err as StructuredOutputError;
      expect(soe.cause).toEqual([{ message: "Expected an object" }]);
    }
  });

  it("passes preservedWorktreePath through to the error", async () => {
    const stdout = "no tag";
    const def = Output.object({ tag: "result", schema: passthrough() });
    try {
      await extractStructuredOutput(stdout, def, {
        ...baseContext,
        preservedWorktreePath: "/tmp/worktree",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      const soe = err as StructuredOutputError;
      expect(soe.preservedWorktreePath).toBe("/tmp/worktree");
    }
  });

  it("handles whitespace around JSON inside tags", async () => {
    const stdout = "<result>  \n  {\"a\": 1}  \n  </result>";
    const def = Output.object({ tag: "result", schema: passthrough() });
    const value = await extractStructuredOutput(stdout, def, baseContext);
    expect(value).toEqual({ a: 1 });
  });

  it("handles nested objects in JSON", async () => {
    const stdout =
      '<result>{"nested": {"deep": true}, "list": [1, 2, 3]}</result>';
    const def = Output.object({ tag: "result", schema: passthrough() });
    const value = await extractStructuredOutput(stdout, def, baseContext);
    expect(value).toEqual({ nested: { deep: true }, list: [1, 2, 3] });
  });

  it("works with async schema validation", async () => {
    const asyncSchema: StandardSchemaV1<unknown, { x: number }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async (value: unknown) => ({
          value: value as { x: number },
        }),
      },
    };
    const stdout = '<result>{"x": 99}</result>';
    const def = Output.object({ tag: "result", schema: asyncSchema });
    const value = await extractStructuredOutput(stdout, def, baseContext);
    expect(value).toEqual({ x: 99 });
  });
});

// ---------------------------------------------------------------------------
// Output.string extraction
// ---------------------------------------------------------------------------

describe("extractStructuredOutput — Output.string", () => {
  it("extracts and trims string content from tag", async () => {
    const stdout = "output\n<summary>  Hello, world!  </summary>\nend";
    const def = Output.string({ tag: "summary" });
    const value = await extractStructuredOutput(stdout, def, baseContext);
    expect(value).toBe("Hello, world!");
  });

  it("uses last occurrence for string tags", async () => {
    const stdout = "<note>first</note>\n<note>second</note>";
    const def = Output.string({ tag: "note" });
    const value = await extractStructuredOutput(stdout, def, baseContext);
    expect(value).toBe("second");
  });

  it("throws StructuredOutputError when string tag is missing", async () => {
    const stdout = "no tags here";
    const def = Output.string({ tag: "summary" });
    try {
      await extractStructuredOutput(stdout, def, baseContext);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(StructuredOutputError);
      const soe = err as StructuredOutputError;
      expect(soe.tag).toBe("summary");
      expect(soe.rawMatched).toBeUndefined();
    }
  });

  it("preserves multiline string content (after trim)", async () => {
    const stdout = "<notes>\n  line 1\n  line 2\n</notes>";
    const def = Output.string({ tag: "notes" });
    const value = await extractStructuredOutput(stdout, def, baseContext);
    expect(value).toBe("line 1\n  line 2");
  });

  it("does not JSON-parse string content", async () => {
    const stdout = '<data>{"this": "is not parsed"}</data>';
    const def = Output.string({ tag: "data" });
    const value = await extractStructuredOutput(stdout, def, baseContext);
    expect(value).toBe('{"this": "is not parsed"}');
  });
});

// ---------------------------------------------------------------------------
// StructuredOutputError
// ---------------------------------------------------------------------------

describe("StructuredOutputError", () => {
  it("is an instance of Error", () => {
    const err = new StructuredOutputError("test", {
      tag: "t",
      rawMatched: undefined,
      commits: [],
      branch: "main",
    });
    expect(err).toBeInstanceOf(Error);
  });

  it("has name StructuredOutputError", () => {
    const err = new StructuredOutputError("test", {
      tag: "t",
      rawMatched: undefined,
      commits: [],
      branch: "main",
    });
    expect(err.name).toBe("StructuredOutputError");
  });

  it("carries all fields from options", () => {
    const err = new StructuredOutputError("msg", {
      tag: "result",
      rawMatched: "raw text",
      cause: new SyntaxError("bad json"),
      commits: [{ sha: "abc" }],
      branch: "my-branch",
      preservedWorktreePath: "/tmp/wt",
    });
    expect(err.tag).toBe("result");
    expect(err.rawMatched).toBe("raw text");
    expect(err.cause).toBeInstanceOf(SyntaxError);
    expect(err.commits).toEqual([{ sha: "abc" }]);
    expect(err.branch).toBe("my-branch");
    expect(err.preservedWorktreePath).toBe("/tmp/wt");
  });
});

// ---------------------------------------------------------------------------
// Output helpers — type-level tests
// ---------------------------------------------------------------------------

describe("Output namespace", () => {
  it("Output.object returns a definition with _tag 'object'", () => {
    const def = Output.object({ tag: "result", schema: passthrough() });
    expect(def._tag).toBe("object");
    expect(def.tag).toBe("result");
    expect(def.schema).toBeDefined();
  });

  it("Output.string returns a definition with _tag 'string'", () => {
    const def = Output.string({ tag: "summary" });
    expect(def._tag).toBe("string");
    expect(def.tag).toBe("summary");
  });
});
