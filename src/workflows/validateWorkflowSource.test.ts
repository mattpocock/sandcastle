import { describe, expect, it } from "vitest";
import { validateWorkflowSource } from "./validateWorkflowSource.js";

describe("validateWorkflowSource", () => {
  it("returns ok true with the loaded workflow source and meta for valid workflows", async () => {
    const result = await validateWorkflowSource({
      source: `
        export default {
          meta: { name: "valid-workflow", description: "Checks source only" },
          defaults: {
            provider: "claude-code",
            sandbox: "podman",
            skills: ["typescript"],
            maxConcurrency: 2,
            maxAgents: 3,
          },
          run() {
            return "ok";
          },
        };
      `,
      allowedProviders: ["claude-code"],
      allowedSandboxes: ["podman"],
      allowedSkills: ["typescript"],
      maxConcurrency: 2,
      maxAgents: 3,
    });

    expect(result).toMatchObject({
      ok: true,
      meta: { name: "valid-workflow", description: "Checks source only" },
      errors: [],
      warnings: [],
    });
    expect(result.value?.definition.meta.name).toBe("valid-workflow");
    expect(result.value?.source).toContain("valid-workflow");
  });

  it("returns ok false with useful diagnostics for syntax errors", async () => {
    const result = await validateWorkflowSource({
      source: `
        export default {
          meta: { name: "syntax-error" }
          run() {
            return "ok";
          },
        };
      `,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "workflow_load_failed",
        message: "Failed to transpile workflow source.",
        severity: "error",
        details: {
          diagnostics: expect.arrayContaining([expect.stringContaining("','")]),
        },
      }),
    ]);
  });

  it("returns ok false with useful diagnostics for evaluation errors", async () => {
    const result = await validateWorkflowSource({
      source: `
        throw new Error("top-level boom");

        export default {
          meta: { name: "evaluation-error" },
          run() {
            return "ok";
          },
        };
      `,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "workflow_load_failed",
        message: "Failed to evaluate workflow source.",
        severity: "error",
        details: expect.objectContaining({
          message: expect.stringContaining("top-level boom"),
        }),
      }),
    ]);
  });

  it.each([
    [
      "runtime import",
      `
        import { readFile } from "node:fs/promises";

        export default {
          meta: { name: "runtime-import" },
          run() {
            return readFile;
          },
        };
      `,
      "Runtime imports are not supported in workflow sources.",
    ],
    [
      "process access",
      `
        export default {
          meta: { name: "process-access" },
          run() {
            return process.cwd();
          },
        };
      `,
      "Access to process is not supported in workflow sources.",
    ],
  ])("returns ok false for forbidden %s", async (_name, source, message) => {
    const result = await validateWorkflowSource({ source });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "workflow_load_failed",
        message: "Workflow source uses unsupported runtime features.",
        severity: "error",
        details: {
          errors: expect.arrayContaining([message]),
        },
      }),
    ]);
  });

  it("reports invalid meta as a shape diagnostic", async () => {
    const result = await validateWorkflowSource({
      source: `
        export default {
          meta: { name: "" },
          run() {
            return "ok";
          },
        };
      `,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "workflow_shape_invalid",
        message: "Workflow definition meta.name must be a non-empty string.",
        severity: "error",
      }),
    ]);
  });

  it("does not execute run while validating", async () => {
    const result = await validateWorkflowSource({
      source: `
        export default {
          meta: { name: "source-only" },
          async run(ctx) {
            await ctx.agent("this must not run during validation");
            throw new Error("run body executed");
          },
        };
      `,
    });

    expect(result).toMatchObject({
      ok: true,
      meta: { name: "source-only" },
      errors: [],
      warnings: [],
    });
  });

  it("returns machine-readable diagnostics for allowlist and ceiling errors", async () => {
    const result = await validateWorkflowSource({
      source: `
        export default {
          meta: { name: "policy-violations" },
          defaults: {
            provider: "opencode",
            sandbox: "daytona",
            skills: ["typescript", "unknown-skill"],
            maxConcurrency: 4,
            maxAgents: 6,
          },
          run() {
            return "ok";
          },
        };
      `,
      allowedProviders: ["codex"],
      allowedSandboxes: ["docker"],
      allowedSkills: ["typescript"],
      maxConcurrency: 2,
      maxAgents: 5,
    });

    expect(result.ok).toBe(false);
    expect(result.meta).toEqual({ name: "policy-violations" });
    expect(result.value?.definition.meta.name).toBe("policy-violations");
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "workflow_provider_unknown",
        path: ["defaults", "provider"],
        details: {
          received: "opencode",
          allowed: ["codex"],
        },
      }),
      expect.objectContaining({
        code: "workflow_sandbox_unknown",
        path: ["defaults", "sandbox"],
        details: {
          received: "daytona",
          allowed: ["docker"],
        },
      }),
      expect.objectContaining({
        code: "workflow_limit_invalid",
        path: ["defaults", "maxConcurrency"],
        details: {
          received: 4,
          maximum: 2,
        },
      }),
      expect.objectContaining({
        code: "workflow_limit_invalid",
        path: ["defaults", "maxAgents"],
        details: {
          received: 6,
          maximum: 5,
        },
      }),
      expect.objectContaining({
        code: "workflow_skill_unknown",
        path: ["defaults", "skills", 1],
        details: {
          received: "unknown-skill",
          allowed: ["typescript"],
        },
      }),
    ]);
  });
});
