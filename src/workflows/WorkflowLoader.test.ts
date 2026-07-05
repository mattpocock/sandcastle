import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowLoadError, WorkflowValidationError } from "./errors.js";
import { loadWorkflowSource } from "./WorkflowLoader.js";

describe("loadWorkflowSource", () => {
  it("loads a .workflow.ts default export satisfying WorkflowDefinition", async () => {
    const source = `
      import type { WorkflowDefinition } from "@ai-hero/sandcastle/workflows";

      export default {
        meta: { name: "implement-task" },
        defaults: {
          provider: "claude-code",
          model: "claude-sonnet-4",
          sandbox: "podman",
          maxAgents: 2,
          maxConcurrency: 1,
        },
        async run() {
          return "ok";
        },
      } satisfies WorkflowDefinition;
    `;

    const result = await loadWorkflowSource({ source });

    expect(result.definition.meta.name).toBe("implement-task");
    expect(result.definition.defaults).toEqual({
      provider: "claude-code",
      model: "claude-sonnet-4",
      sandbox: "podman",
      maxAgents: 2,
      maxConcurrency: 1,
    });
    expect(result.transpiledSource).toContain("exports.default");
  });

  it("allows type-only imports", async () => {
    const result = await loadWorkflowSource({
      source: `
        import type * as fs from "node:fs";
        import type { WorkflowDefinition } from "@ai-hero/sandcastle";

        const workflow: WorkflowDefinition = {
          meta: { name: "typed-workflow" },
          run() {
            return "ok";
          },
        };

        export default workflow;
      `,
    });

    expect(result.definition.meta.name).toBe("typed-workflow");
    expect(result.definition.defaults).toEqual({
      provider: "codex",
      model: "gpt-5.5",
      sandbox: "docker",
    });
  });

  it("rejects runtime imports", async () => {
    await expect(
      loadWorkflowSource({
        source: `
          import { readFile } from "node:fs/promises";

          export default {
            meta: { name: "runtime-import" },
            run() {
              return readFile;
            },
          };
        `,
      }),
    ).rejects.toThrow(WorkflowLoadError);
  });

  it("rejects invalid meta", async () => {
    await expect(
      loadWorkflowSource({
        source: `
          export default {
            meta: { name: "" },
            run() {
              return "ok";
            },
          };
        `,
      }),
    ).rejects.toThrow(WorkflowValidationError);
  });

  it("rejects invalid defaults such as negative maxAgents or maxConcurrency", async () => {
    await expect(
      loadWorkflowSource({
        source: `
          export default {
            meta: { name: "bad-defaults" },
            defaults: {
              maxAgents: -1,
              maxConcurrency: -2,
            },
            run() {
              return "ok";
            },
          };
        `,
      }),
    ).rejects.toThrow(WorkflowValidationError);
  });

  it("preserves useful syntax error context", async () => {
    await expect(
      loadWorkflowSource({
        source: `
          export default {
            meta: { name: "syntax-error" }
            run() {
              return "ok";
            },
          };
        `,
      }),
    ).rejects.toMatchObject({
      details: {
        diagnostics: expect.arrayContaining([expect.stringContaining("','")]),
      },
    });
  });

  it("does not run agent() or the workflow run body while loading", async () => {
    const result = await loadWorkflowSource({
      source: `
        export default {
          meta: { name: "load-only" },
          async run({ agent }) {
            await agent("this must not run during load");
            throw new Error("run body executed");
          },
        };
      `,
    });

    expect(result.definition.meta.name).toBe("load-only");
  });

  it("resolves relative sourceFile against cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "workflow-loader-"));
    await writeFile(
      join(dir, "relative.workflow.ts"),
      `
        export default {
          meta: { name: "relative-file" },
          run() {
            return "ok";
          },
        };
      `,
    );

    const result = await loadWorkflowSource({
      cwd: dir,
      sourceFile: "relative.workflow.ts",
    });

    expect(result.sourceFile).toBe(join(dir, "relative.workflow.ts"));
    expect(result.definition.meta.name).toBe("relative-file");
  });
});
