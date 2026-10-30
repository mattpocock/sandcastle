import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cp,
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

test("installed packaged defaults advance without overwriting project customization", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "prompt-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installed = join(root, "installed");
  await mkdir(installed);
  await cp(resolve("dist"), join(installed, "dist"), { recursive: true });
  await writeFile(
    join(installed, "package.json"),
    JSON.stringify({ type: "module", version: "0.12.0" }),
  );
  await symlink(
    resolve("node_modules"),
    join(installed, "node_modules"),
    "dir",
  );
  const sdk = await import(
    pathToFileURL(join(installed, "dist/index.js")).href
  );
  const cwd = join(root, "project");
  await mkdir(cwd);
  const promptFiles = Object.fromEntries(
    ["planner", "implementer", "reviewer", "merger", "readiness"].map(
      (role) => [role, role + ".md"],
    ),
  );
  const options = { cwd, promptFiles };
  await sdk.usePackagedPromptDefaults({
    cwd,
    templateArgs: {
      VIEW_TASK_COMMAND: "gh issue view <ID>",
      CLOSE_TASK_COMMAND: "gh issue close <ID>",
    },
  });
  const initial = await sdk.loadProjectPrompts(options);
  // Equivalent to untouched scaffold copies, kept project-owned on disk.
  for (const [role, prompt] of Object.entries(initial))
    await writeFile(join(cwd, promptFiles[role]), prompt.content);
  await sdk.saveProjectPrompt({
    ...options,
    role: "implementer",
    content: initial.implementer.content + "\nKeep project convention.",
  });
  const active = await sdk.createProjectRuntime({
    ...options,
    sandboxIdentity: "fake",
  });
  for (const filename of ["plan", "implement"]) {
    const path = join(
      installed,
      "dist/templates/parallel-planner-with-review",
      filename + "-prompt.md",
    );
    await writeFile(
      path,
      (await readFile(path, "utf8")) + "\nNew packaged guidance.",
    );
  }
  const upgraded = await sdk.loadProjectPrompts(options);
  assert.ok(upgraded.planner.content.includes("New packaged guidance."));
  assert.ok(
    upgraded.implementer.default.content.includes("New packaged guidance."),
  );
  assert.ok(upgraded.implementer.content.includes("Keep project convention."));
  assert.equal(
    upgraded.implementer.content.includes("New packaged guidance."),
    false,
  );
  assert.deepEqual(upgraded.implementer.base, initial.implementer.default);
  assert.equal(upgraded.implementer.defaultChanged, true);
  assert.equal(
    active.record.prompts.implementer.content,
    upgraded.implementer.content,
  );
  await sdk.saveProjectPrompt({
    ...options,
    role: "implementer",
    content: null,
  });
  assert.ok(
    (await sdk.loadProjectPrompts(options)).implementer.content.includes(
      "New packaged guidance.",
    ),
  );
  assert.equal(
    await readFile(join(cwd, "implementer.md"), "utf8"),
    initial.implementer.content,
  );
});
