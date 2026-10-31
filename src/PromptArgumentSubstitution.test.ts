import type { Layer } from "effect";
import { Effect, Ref } from "effect";
import { describe, expect, it } from "vitest";
import { SilentDisplay } from "./Display.js";
import type { DisplayEntry } from "./Display.js";
import {
  substitutePromptArgs,
  validateNoArgsWithInlinePrompt,
  validateNoBuiltInArgOverride,
  findMissingPromptArgKeys,
  BUILT_IN_PROMPT_ARG_KEYS,
} from "./PromptArgumentSubstitution.js";
import { PromptError } from "./errors.js";

describe("PromptArgumentSubstitution", () => {
  const setup = () => {
    const displayRef = Ref.unsafeMake<readonly DisplayEntry[]>([]);
    const layer = SilentDisplay.layer(displayRef);
    return { layer, displayRef };
  };

  const run = (
    prompt: string,
    args: Record<string, string | number | boolean>,
    layer: Layer.Layer<import("./Display.js").Display>,
  ) =>
    Effect.runPromise(
      substitutePromptArgs(prompt, args).pipe(Effect.provide(layer)),
    );

  const runFail = (
    prompt: string,
    args: Record<string, string | number | boolean>,
    layer: Layer.Layer<import("./Display.js").Display>,
  ) =>
    Effect.runPromise(
      substitutePromptArgs(prompt, args).pipe(
        Effect.flip,
        Effect.provide(layer),
      ),
    );

  it("replaces a single {{KEY}} placeholder with its value", async () => {
    const { layer } = setup();
    const result = await run("Hello {{NAME}}", { NAME: "world" }, layer);
    expect(result).toBe("Hello world");
  });

  it("replaces multiple different placeholders", async () => {
    const { layer } = setup();
    const result = await run(
      "Issue #{{NUM}}: {{TITLE}}",
      { NUM: "42", TITLE: "Fix bug" },
      layer,
    );
    expect(result).toBe("Issue #42: Fix bug");
  });

  it("replaces the same key used more than once", async () => {
    const { layer } = setup();
    const result = await run(
      "{{KEY}} and {{KEY}} again",
      { KEY: "val" },
      layer,
    );
    expect(result).toBe("val and val again");
  });

  it("coerces number values to strings", async () => {
    const { layer } = setup();
    const result = await run("Issue #{{NUM}}", { NUM: 42 }, layer);
    expect(result).toBe("Issue #42");
  });

  it("coerces boolean values to strings", async () => {
    const { layer } = setup();
    const result = await run("Flag: {{ENABLED}}", { ENABLED: true }, layer);
    expect(result).toBe("Flag: true");
  });

  it("throws PromptError when a placeholder has no matching arg", async () => {
    const { layer } = setup();
    const error = await runFail("Hello {{MISSING}}", {}, layer);
    expect(error).toBeInstanceOf(PromptError);
    expect(error._tag).toBe("PromptError");
    expect(error.message).toContain("MISSING");
  });

  it("throws PromptError when a placeholder value is undefined", async () => {
    const { layer } = setup();
    const error = await runFail(
      "Hello {{TITLE}}",
      { TITLE: undefined } as unknown as Record<string, string>,
      layer,
    );
    expect(error).toBeInstanceOf(PromptError);
    expect(error._tag).toBe("PromptError");
    expect(error.message).toContain("{{TITLE}}");
    expect(error.message).toContain("undefined");
  });

  it("throws PromptError when a placeholder value is null", async () => {
    const { layer } = setup();
    const error = await runFail(
      "Hello {{TITLE}}",
      { TITLE: null } as unknown as Record<string, string>,
      layer,
    );
    expect(error).toBeInstanceOf(PromptError);
    expect(error._tag).toBe("PromptError");
    expect(error.message).toContain("{{TITLE}}");
    expect(error.message).toContain("null");
  });

  it("logs a warning for unused prompt args", async () => {
    const { layer, displayRef } = setup();
    await run("Hello world", { UNUSED: "value" }, layer);
    const entries = await Effect.runPromise(Ref.get(displayRef));
    const warnings = entries.filter(
      (e) => e._tag === "status" && e.severity === "warn",
    );
    expect(warnings).toHaveLength(1);
    expect((warnings[0] as { message: string }).message).toContain("UNUSED");
  });

  it("passes through a prompt with no placeholders and no args", async () => {
    const { layer } = setup();
    const prompt = "Just a plain prompt with no placeholders.";
    const result = await run(prompt, {}, layer);
    expect(result).toBe(prompt);
  });

  it("substitutes placeholders inside shell expressions", async () => {
    const { layer } = setup();
    const result = await run(
      "Output: !`gh issue view {{NUM}}`",
      { NUM: 123 },
      layer,
    );
    // Template-authored shell blocks are marked with \x01 so the preprocessor
    // can distinguish them from `!`...`` patterns injected via arg values.
    expect(result).toBe("Output: !\u0001`gh issue view 123`");
  });

  it("replaces {{ KEY }} with spaces inside braces", async () => {
    const { layer } = setup();
    const result = await run("Hello {{ NAME }}", { NAME: "world" }, layer);
    expect(result).toBe("Hello world");
  });

  it("replaces {{  KEY  }} with multiple spaces", async () => {
    const { layer } = setup();
    const result = await run("Hello {{  NAME  }}", { NAME: "world" }, layer);
    expect(result).toBe("Hello world");
  });

  it("replaces asymmetric whitespace like {{ KEY}}", async () => {
    const { layer } = setup();
    const result = await run("Hello {{ NAME}}", { NAME: "world" }, layer);
    expect(result).toBe("Hello world");
  });

  it("replaces placeholder with tab whitespace", async () => {
    const { layer } = setup();
    const result = await run("Hello {{\tNAME\t}}", { NAME: "world" }, layer);
    expect(result).toBe("Hello world");
  });

  it("error message uses normalized form for spaced placeholder", async () => {
    const { layer } = setup();
    const error = await runFail("Hello {{ MISSING }}", {}, layer);
    expect(error).toBeInstanceOf(PromptError);
    expect(error.message).toContain("{{MISSING}}");
  });

  it("spaced placeholder counts as reference for unused-arg check", async () => {
    const { layer, displayRef } = setup();
    await run("{{ NAME }}", { NAME: "world" }, layer);
    const entries = await Effect.runPromise(Ref.get(displayRef));
    const warnings = entries.filter(
      (e) => e._tag === "status" && e.severity === "warn",
    );
    expect(warnings).toHaveLength(0);
  });

  it("handles keys with underscores and digits", async () => {
    const { layer } = setup();
    const result = await run("{{MY_KEY_2}} here", { MY_KEY_2: "value" }, layer);
    expect(result).toBe("value here");
  });

  it("reports the first missing key when multiple are missing", async () => {
    const { layer } = setup();
    const error = await runFail("{{A}} and {{B}}", {}, layer);
    expect(error).toBeInstanceOf(PromptError);
    // Should mention at least one of the missing keys
    expect(error.message).toMatch(/A|B/);
  });

  it("warns about multiple unused args", async () => {
    const { layer, displayRef } = setup();
    await run("No placeholders", { FOO: "1", BAR: "2" }, layer);
    const entries = await Effect.runPromise(Ref.get(displayRef));
    const warnings = entries.filter(
      (e) => e._tag === "status" && e.severity === "warn",
    );
    expect(warnings).toHaveLength(2);
  });

  it("does not warn about unused args listed in silentKeys", async () => {
    const { layer, displayRef } = setup();
    await Effect.runPromise(
      substitutePromptArgs(
        "No built-in placeholders here",
        { SOURCE_BRANCH: "feat/x", TARGET_BRANCH: "main", USER_ARG: "val" },
        new Set(["SOURCE_BRANCH", "TARGET_BRANCH"]),
      ).pipe(Effect.provide(layer)),
    );
    const entries = await Effect.runPromise(Ref.get(displayRef));
    const warnings = entries.filter(
      (e) => e._tag === "status" && e.severity === "warn",
    );
    // Only USER_ARG should warn — SOURCE_BRANCH and TARGET_BRANCH are silent
    expect(warnings).toHaveLength(1);
    expect((warnings[0] as { message: string }).message).toContain("USER_ARG");
  });

  it("still substitutes silent keys when they appear in the prompt", async () => {
    const { layer } = setup();
    const result = await Effect.runPromise(
      substitutePromptArgs(
        "Branch: {{SOURCE_BRANCH}}",
        { SOURCE_BRANCH: "feat/my-feature", TARGET_BRANCH: "main" },
        new Set(["SOURCE_BRANCH", "TARGET_BRANCH"]),
      ).pipe(Effect.provide(layer)),
    );
    expect(result).toBe("Branch: feat/my-feature");
  });
});

describe("validateNoBuiltInArgOverride", () => {
  it("succeeds when promptArgs contains no built-in keys", async () => {
    await expect(
      Effect.runPromise(validateNoBuiltInArgOverride({ ISSUE_NUMBER: "42" })),
    ).resolves.toBeUndefined();
  });

  it("succeeds for empty promptArgs", async () => {
    await expect(
      Effect.runPromise(validateNoBuiltInArgOverride({})),
    ).resolves.toBeUndefined();
  });

  it("fails with PromptError when SOURCE_BRANCH is provided", async () => {
    const error = await Effect.runPromise(
      validateNoBuiltInArgOverride({ SOURCE_BRANCH: "my-branch" }).pipe(
        Effect.flip,
      ),
    );
    expect(error).toBeInstanceOf(PromptError);
    expect(error.message).toContain("SOURCE_BRANCH");
    expect(error.message).toContain("built-in");
  });

  it("fails with PromptError when TARGET_BRANCH is provided", async () => {
    const error = await Effect.runPromise(
      validateNoBuiltInArgOverride({ TARGET_BRANCH: "main" }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(PromptError);
    expect(error.message).toContain("TARGET_BRANCH");
    expect(error.message).toContain("built-in");
  });
});

describe("validateNoArgsWithInlinePrompt", () => {
  it("succeeds when promptArgs is empty", async () => {
    await expect(
      Effect.runPromise(validateNoArgsWithInlinePrompt({})),
    ).resolves.toBeUndefined();
  });

  it("fails with PromptError when promptArgs has any key", async () => {
    const error = await Effect.runPromise(
      validateNoArgsWithInlinePrompt({ ISSUE: "42" }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(PromptError);
    expect(error.message).toContain("promptArgs");
    expect(error.message).toContain("promptFile");
  });

  it("fails even when only a built-in arg key is present", async () => {
    const error = await Effect.runPromise(
      validateNoArgsWithInlinePrompt({ SOURCE_BRANCH: "main" }).pipe(
        Effect.flip,
      ),
    );
    expect(error).toBeInstanceOf(PromptError);
  });
});

describe("BUILT_IN_PROMPT_ARG_KEYS", () => {
  it("includes SOURCE_BRANCH and TARGET_BRANCH", () => {
    expect(BUILT_IN_PROMPT_ARG_KEYS).toContain("SOURCE_BRANCH");
    expect(BUILT_IN_PROMPT_ARG_KEYS).toContain("TARGET_BRANCH");
  });
});

describe("findMissingPromptArgKeys", () => {
  it("returns empty array when prompt has no placeholders", () => {
    expect(findMissingPromptArgKeys("plain prompt", {})).toEqual([]);
  });

  it("returns empty array when all placeholders are provided", () => {
    expect(
      findMissingPromptArgKeys("Fix {{COMPONENT}} bug", {
        COMPONENT: "Login",
      }),
    ).toEqual([]);
  });

  it("returns missing keys not present in provided args", () => {
    const result = findMissingPromptArgKeys(
      "Fix {{COMPONENT}} on {{BRANCH_NAME}}",
      { COMPONENT: "Login" },
    );
    expect(result).toEqual(["BRANCH_NAME"]);
  });

  it("returns multiple missing keys", () => {
    const result = findMissingPromptArgKeys("{{A}} and {{B}} and {{C}}", {});
    expect(result).toEqual(["A", "B", "C"]);
  });

  it("excludes built-in keys (SOURCE_BRANCH, TARGET_BRANCH)", () => {
    const result = findMissingPromptArgKeys(
      "Branch: {{SOURCE_BRANCH}} target: {{TARGET_BRANCH}} component: {{COMPONENT}}",
      {},
    );
    expect(result).toEqual(["COMPONENT"]);
    expect(result).not.toContain("SOURCE_BRANCH");
    expect(result).not.toContain("TARGET_BRANCH");
  });

  it("handles spaced placeholders like {{ KEY }}", () => {
    const result = findMissingPromptArgKeys("Fix {{ COMPONENT }}", {});
    expect(result).toEqual(["COMPONENT"]);
  });

  it("does not return duplicate keys", () => {
    const result = findMissingPromptArgKeys("{{KEY}} and {{KEY}} again", {});
    expect(result).toEqual(["KEY"]);
  });

  it("skips keys already present in provided args", () => {
    const result = findMissingPromptArgKeys("{{PROVIDED}} and {{MISSING}}", {
      PROVIDED: "value",
    });
    expect(result).toEqual(["MISSING"]);
  });

  it("treats a key with an undefined value as missing", () => {
    const result = findMissingPromptArgKeys("Fix {{COMPONENT}}", {
      COMPONENT: undefined,
    } as unknown as Record<string, string>);
    expect(result).toEqual(["COMPONENT"]);
  });

  it("treats a key with a null value as missing", () => {
    const result = findMissingPromptArgKeys("Fix {{COMPONENT}}", {
      COMPONENT: null,
    } as unknown as Record<string, string>);
    expect(result).toEqual(["COMPONENT"]);
  });
});
