import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");

const TEMPLATES = ["parallel-planner", "parallel-planner-with-review"] as const;

const templateMain = (name: (typeof TEMPLATES)[number]): string =>
  readFileSync(path.join(ROOT, "src/templates", name, "main.mts"), "utf8");

const sectionBetween = (source: string, start: string, end: string): string => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, `missing "${start}"`).toBeGreaterThanOrEqual(0);
  expect(to, `missing "${end}" after "${start}"`).toBeGreaterThanOrEqual(0);
  return source.slice(from, to);
};

describe("parallel-planner templates (#1467)", () => {
  it.each(TEMPLATES)(
    "%s: planner and merger do not run npm install on the bind-mounted checkout",
    (template) => {
      const main = templateMain(template);

      const plan = sectionBetween(main, "Phase 1: Plan", "Phase 2:");
      const merge = main.slice(main.indexOf("Phase 3: Merge"));

      expect(plan).not.toMatch(/\bhooks\b/);
      expect(merge).not.toMatch(/\bhooks\b/);
      expect(plan).not.toContain("npm install");
      expect(merge).not.toContain("npm install");
    },
  );

  it.each(TEMPLATES)(
    "%s: only the worktree execute phase installs into a copied node_modules",
    (template) => {
      const main = templateMain(template);
      const execute = sectionBetween(main, "Phase 2:", "Phase 3: Merge");

      expect(execute).toMatch(/hooks:\s*installHooks/);
      expect(execute).toContain("copyToWorktree");
      expect(main).toContain(
        'sandbox: { onSandboxReady: [{ command: "npm install" }] }',
      );
    },
  );
});
