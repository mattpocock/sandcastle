import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The bundled tasks guide's implementSpec examples, verbatim. Each one lives
// in tests/examples, where `npm run typecheck` checks it against the
// package; this keeps the page and those files in step.

const root = path.resolve(import.meta.dirname, "..");
const page = readFileSync(path.join(root, "docs/v1/bundled-tasks.md"), "utf8");

describe("docs/v1/bundled-tasks.md: the implementSpec examples", () => {
  it.each([
    "implementSpecDetached.ts",
    "implementSpecPolled.ts",
    "implementSpecHeld.ts",
  ])("shows tests/examples/%s as it is", (file) => {
    const example = readFileSync(
      path.join(root, "tests/examples", file),
      "utf8",
    );
    expect(page).toContain(`\`\`\`ts\n${example}\`\`\``);
  });
});
