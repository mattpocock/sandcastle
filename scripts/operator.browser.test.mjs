import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  startOperator,
  loadRoleConfig,
  loadWorkflowConfig,
  run as runAgent,
} from "../dist/index.js";

import { noSandbox } from "../dist/sandboxes/no-sandbox.js";

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
});

async function fixture(t, sharedContext) {
  const cwd = await mkdtemp(join(tmpdir(), "operator-browser-"));
  const bin = join(cwd, "bin");
  await mkdir(bin);
  await mkdir(join(cwd, ".sandcastle"));
  await writeFile(
    join(cwd, ".sandcastle/default-prompt.md"),
    "Default browser prompt <promise>COMPLETE</promise>",
  );
  await writeFile(
    join(cwd, ".sandcastle/.gitignore"),
    "runtime/\nruns/\nlogs/\nfixture-gitconfig\n",
  );
  await writeFile(
    join(bin, "codex"),
    `#!/usr/bin/env node
let input = ""; for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: process.argv.slice(2).join(" ") + " " + input + " <promise>COMPLETE</promise>" } }));
`,
  );
  await chmod(join(bin, "codex"), 0o755);
  for (const args of [
    ["init", "-qb", "main"],
    ["config", "user.name", "Browser fixture"],
    ["config", "user.email", "fixture@example.com"],
    ["add", "."],
    ["commit", "-qm", "fixture"],
  ])
    execFileSync("git", args, { cwd });
  let providerOutput = "";
  let finish, started, completed;
  const wait = new Promise((resolve) => {
    finish = resolve;
  });
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const done = new Promise((resolve) => {
    completed = resolve;
  });
  let didStart = false;
  const runtimes = [];
  const server = await startOperator({
    cwd,
    port: 0,
    adapter: {
      promptFiles: {
        planner: ".sandcastle/default-prompt.md",
        implementer: ".sandcastle/default-prompt.md",
        reviewer: ".sandcastle/default-prompt.md",
        merger: ".sandcastle/default-prompt.md",
        readiness: ".sandcastle/default-prompt.md",
      },
      sandboxIdentity: async () => "fake-browser-image",
      run: async (runtime) => {
        didStart = true;
        runtimes.push(runtime);
        const map = await runtime.createAgentMap("Browser fake provider");
        await map.track(
          { batch: 1, role: "implementer", title: "Fake run", branch: "main" },
          async (logging) => {
            const result = await runAgent({
              cwd,
              agent: runtime.agent("implementer", { captureSessions: false }),
              sandbox: noSandbox({
                env: {
                  PATH: bin + ":" + process.env.PATH,
                  GIT_CONFIG_GLOBAL: join(
                    cwd,
                    ".sandcastle",
                    "fixture-gitconfig",
                  ),
                },
              }),
              promptFile: runtime.promptFile("implementer"),
              logging,
            });
            providerOutput = result.stdout;
            started();
            await wait;
            return result;
          },
        );
        await map.finish("completed");
        completed();
      },
    },
  });
  const context = sharedContext ?? (await browser.newContext());
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(10000);
  t.after(async () => {
    finish();
    if (didStart) await done;
    if (!sharedContext) await context.close();
    await server.close();
    await rm(cwd, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  await page.goto(server.url);
  await page.getByLabel("Implementer effort").waitFor();
  return {
    page,
    cwd,
    server,
    ready,
    context,
    providerOutput: () => providerOutput,
    runtimes,
    release: finish,
  };
}

test("model dropdowns and custom IDs save, reload and route to the selected project", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t, first.context);
  assert.equal(
    await first.page.getByLabel("Implementer effort").inputValue(),
    "low",
  );
  assert.equal(
    await first.page.getByLabel("Reviewer effort").inputValue(),
    "high",
  );
  await first.page
    .getByLabel("Implementer model", { exact: true })
    .selectOption("gpt-5.4");
  await first.page.getByLabel("Implementer effort").selectOption("medium");
  await first.page.getByRole("button", { name: "Save settings" }).click();
  await first.page
    .getByRole("status")
    .filter({ hasText: "Settings saved." })
    .waitFor();
  await first.page.reload();
  assert.equal(
    await first.page
      .getByLabel("Implementer model", { exact: true })
      .inputValue(),
    "gpt-5.4",
  );
  assert.equal(
    await first.page.getByLabel("Implementer effort").inputValue(),
    "medium",
  );
  await first.page
    .getByLabel("Planner model", { exact: true })
    .selectOption("custom");
  await first.page
    .getByLabel("Planner custom model")
    .fill("organization/custom-model");
  await first.page.getByRole("button", { name: "Save settings" }).click();
  await first.page
    .getByRole("status")
    .filter({ hasText: "Settings saved." })
    .waitFor();
  await first.page.reload();
  assert.equal(
    await first.page.getByLabel("Planner custom model").inputValue(),
    "organization/custom-model",
  );
  assert.equal(
    (await loadRoleConfig({ cwd: second.cwd })).roles.implementer.model,
    "gpt-6.1-sol",
  );
  await first.page
    .getByRole("button", { name: "Start run", exact: true })
    .click();
  await first.ready;
  assert.ok(first.providerOutput().includes("-m gpt-5.4"));
  assert.ok(first.providerOutput().includes('model_reasoning_effort="medium"'));
  assert.equal(
    await second.page
      .getByLabel("Implementer model", { exact: true })
      .inputValue(),
    "gpt-6.1-sol",
  );
});

test("keyboard operation and actionable invalid-input feedback preserve durable settings", async (t) => {
  const { page, cwd } = await fixture(t);
  const effort = page.getByLabel("Reviewer effort");
  await effort.focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  assert.equal(await effort.inputValue(), "medium");
  await page
    .getByLabel("Reviewer model", { exact: true })
    .selectOption("custom");
  await page.getByLabel("Reviewer custom model").fill("invalid model");
  await page.getByRole("button", { name: "Save settings" }).focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("status")
    .filter({ hasText: "roles.reviewer.model:" })
    .waitFor();
  assert.equal(
    (await loadRoleConfig({ cwd })).roles.reviewer.model,
    "gpt-6.1-sol",
  );
  await page.getByLabel("Reviewer custom model").fill("keyboard-model");
  await page.getByRole("button", { name: "Save settings" }).focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("status")
    .filter({ hasText: "Settings saved." })
    .waitFor();
  assert.equal((await loadRoleConfig({ cwd })).roles.reviewer.effort, "medium");
});

test("saving during a run leaves its displayed settings frozen and opens recorded workflow logs", async (t) => {
  const { page, ready, server, release, providerOutput } = await fixture(t);
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  await ready;
  await page
    .getByRole("status")
    .filter({ hasText: "implementer: gpt-6.1-sol / low" })
    .waitFor();
  await page
    .getByLabel("Implementer model", { exact: true })
    .selectOption("gpt-5.4");
  await page.getByLabel("Implementer effort").selectOption("xhigh");
  await page.getByRole("button", { name: "Save settings" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Settings saved." })
    .waitFor();
  const current = await (await fetch(server.url + "/api/run")).json();
  assert.equal(current.run.config.roles.implementer.model, "gpt-6.1-sol");
  assert.equal(current.run.config.roles.implementer.effort, "low");
  release();
  await page.getByRole("status").filter({ hasText: "· completed ·" }).waitFor();
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "implementer: gpt-5.4 / xhigh" })
    .waitFor();
  await page.getByRole("status").filter({ hasText: "· completed ·" }).waitFor();
  assert.ok(providerOutput().includes("-m gpt-5.4"));
  assert.ok(providerOutput().includes('model_reasoning_effort="xhigh"'));

  const popup = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Observe runs and logs" }).click();
  const dashboard = await popup;
  await dashboard
    .getByRole("heading", { name: "Browser fake provider", exact: true })
    .waitFor();
  await dashboard
    .getByRole("button", { name: /Fake run/ })
    .first()
    .click();
  await dashboard.getByRole("tab", { name: "Logs", exact: true }).waitFor();
});

test("prompt editor saves with keyboard, reloads, resets and renders data", async (t) => {
  const { page, server, cwd } = await fixture(t);
  await page.getByRole("link", { name: "Prompts", exact: true }).click();
  const editor = page.getByLabel("Implementer prompt", { exact: true });
  await editor.fill(
    "Customized <script>window.promptExecuted=true</script> <promise>COMPLETE</promise>",
  );
  await page
    .getByRole("button", { name: "Save implementer prompt", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("status")
    .filter({ hasText: "implementer prompt saved" })
    .waitFor();
  await page.reload();
  assert.ok((await editor.inputValue()).includes("Customized"));
  assert.equal(await page.evaluate(() => window.promptExecuted), undefined);
  assert.equal(await page.locator("#prompts script").count(), 0);
  const diff = page.getByLabel("Implementer prompt diff", { exact: true });
  await diff.locator("..").locator("summary").focus();
  await page.keyboard.press("Enter");
  assert.equal(await diff.isVisible(), true);
  assert.ok((await diff.textContent()).includes("- Default browser prompt"));
  assert.ok((await diff.textContent()).includes("+ Customized <script>"));
  for (const [content, diagnostic] of [
    ["Invalid", "preserve required runtime output"],
    [
      "Unknown {{UNSUPPORTED}} <promise>COMPLETE</promise>",
      "unknown placeholder {{UNSUPPORTED}}",
    ],
    [
      "Malformed {{NAME} <promise>COMPLETE</promise>",
      "malformed template placeholder",
    ],
  ]) {
    await editor.fill(content);
    await page
      .getByRole("button", { name: "Save implementer prompt", exact: true })
      .click();
    await page.getByRole("status").filter({ hasText: diagnostic }).waitFor();
  }
  await page.reload();
  assert.ok((await editor.inputValue()).includes("Customized"));
  await writeFile(
    join(cwd, ".sandcastle/default-prompt.md"),
    "Updated default <promise>COMPLETE</promise>",
  );
  await page.reload();
  await page
    .getByText("Override · default changed", { exact: false })
    .waitFor();
  assert.ok(
    (await page.locator("#implementer-default-diff").textContent()).includes(
      "+ Updated default",
    ),
  );
  await page
    .locator("#implementer-default-diff")
    .locator("..")
    .locator("summary")
    .focus();
  await page.keyboard.press("Enter");
  assert.equal(
    await page.locator("#implementer-default-diff").isVisible(),
    true,
  );
  await page
    .getByRole("button", { name: "Reset implementer prompt", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("status")
    .filter({ hasText: "implementer prompt reset" })
    .waitFor();
  assert.equal(
    await editor.inputValue(),
    "Updated default <promise>COMPLETE</promise>",
  );
});

test("saving and resetting a role preserves other prompt drafts and keyboard focus", async (t) => {
  const { page } = await fixture(t);
  const reviewer = page.getByLabel("Reviewer prompt", { exact: true });
  const implementer = page.getByLabel("Implementer prompt", { exact: true });
  const draft = "Unsaved reviewer guidance <promise>COMPLETE</promise>";
  await reviewer.fill(draft);
  await implementer.fill(
    "Saved implementer guidance <promise>COMPLETE</promise>",
  );
  const save = page.getByRole("button", {
    name: "Save implementer prompt",
    exact: true,
  });
  await save.focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("status")
    .filter({ hasText: "implementer prompt saved" })
    .waitFor();
  assert.equal(await reviewer.inputValue(), draft);
  assert.equal(
    await save.evaluate((button) => button === document.activeElement),
    true,
  );
  const reset = page.getByRole("button", {
    name: "Reset implementer prompt",
    exact: true,
  });
  await reset.focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("status")
    .filter({ hasText: "implementer prompt reset" })
    .waitFor();
  assert.equal(await reviewer.inputValue(), draft);
  assert.equal(
    await reset.evaluate((button) => button === document.activeElement),
    true,
  );
  await page
    .getByRole("button", { name: "Save reviewer prompt", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "reviewer prompt saved" })
    .waitFor();
  await page.reload();
  assert.equal(await reviewer.inputValue(), draft);
});

test("fake model receives selected prompt while edits apply to the next run", async (t) => {
  const { page, ready, release, server, runtimes, providerOutput } =
    await fixture(t);
  const editor = page.getByLabel("Implementer prompt", { exact: true });
  await editor.fill("Selected browser prompt <promise>COMPLETE</promise>");
  await page
    .getByRole("button", { name: "Save implementer prompt", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "implementer prompt saved" })
    .waitFor();
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  await ready;
  assert.ok(providerOutput().includes("Selected browser prompt"));
  await editor.fill("Next browser prompt <promise>COMPLETE</promise>");
  await page
    .getByRole("button", { name: "Save implementer prompt", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "implementer prompt saved" })
    .waitFor();
  assert.equal(
    runtimes[0].record.prompts.implementer.content,
    "Selected browser prompt <promise>COMPLETE</promise>",
  );
  release();
  await page.getByRole("status").filter({ hasText: "· completed ·" }).waitFor();
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  await page.waitForFunction((id) => {
    const text = document.getElementById("run").textContent;
    return !text.includes(id) && text.includes("· completed ·");
  }, runtimes[0].record.id);
  assert.equal(
    runtimes[1].record.prompts.implementer.content,
    "Next browser prompt <promise>COMPLETE</promise>",
  );
  assert.ok(providerOutput().includes("Next browser prompt"));
});

test("prompt overrides persist across an operator web restart and isolate projects", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t, first.context);
  const editor = first.page.getByLabel("Reviewer prompt", { exact: true });
  await editor.fill("Restart-persistent review <promise>COMPLETE</promise>");
  await first.page
    .getByRole("button", { name: "Save reviewer prompt", exact: true })
    .click();
  await first.page
    .getByRole("status")
    .filter({ hasText: "reviewer prompt saved" })
    .waitFor();
  await first.server.close();
  const restarted = await startOperator({
    cwd: first.cwd,
    port: 0,
    adapter: {
      promptFiles: Object.fromEntries(
        ["planner", "implementer", "reviewer", "merger", "readiness"].map(
          (role) => [role, ".sandcastle/default-prompt.md"],
        ),
      ),
      sandboxIdentity: async () => "fake-browser-image",
      run: async () => {},
    },
  });
  t.after(() => restarted.close());
  await first.page.goto(restarted.url);
  assert.equal(
    await editor.inputValue(),
    "Restart-persistent review <promise>COMPLETE</promise>",
  );
  assert.equal(
    await second.page
      .getByLabel("Reviewer prompt", { exact: true })
      .inputValue(),
    "Default browser prompt <promise>COMPLETE</promise>",
  );
  for (const role of [
    "Planner",
    "Implementer",
    "Reviewer",
    "Merger",
    "Readiness",
  ])
    assert.equal(
      await first.page.getByLabel(role + " prompt", { exact: true }).count(),
      1,
    );
  for (const role of [
    "Planner",
    "Implementer",
    "Reviewer",
    "Merger",
    "Readiness",
  ])
    assert.ok(
      (
        await first.page
          .locator("#prompts")
          .getByRole("group", { name: role, exact: true })
          .textContent()
      ).includes(role === "Reviewer" ? "Override" : "Default"),
    );
});

test("provider, effort and fallback controls save a version-two configuration and survive reload", async (t) => {
  const { page, cwd } = await fixture(t);
  await page
    .getByLabel("Reviewer provider", { exact: true })
    .selectOption("claudeCode");
  assert.equal(
    await page.getByLabel("Reviewer model", { exact: true }).inputValue(),
    "claude-opus-5-5",
  );
  await page.getByLabel("Reviewer effort", { exact: true }).selectOption("max");
  await page.getByRole("button", { name: "Add Implementer fallback" }).click();
  await page
    .getByLabel("Implementer fallback 1 effort", { exact: true })
    .selectOption("high");
  await page
    .getByLabel("Merger provider", { exact: true })
    .selectOption("cursor");
  assert.equal(
    await page.getByLabel("Merger effort", { exact: true }).isDisabled(),
    true,
  );
  await page.getByLabel("Merger model", { exact: true }).selectOption("custom");
  await page.getByLabel("Merger custom model").fill("composer");
  await page.getByRole("button", { name: "Save settings" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Settings saved." })
    .waitFor();
  const saved = await loadRoleConfig({ cwd });
  assert.equal(saved.schemaVersion, 2);
  assert.deepEqual(saved.roles.reviewer, {
    provider: "claudeCode",
    model: "claude-opus-5-5",
    effort: "max",
  });
  assert.deepEqual(saved.roles.implementer.fallback, [
    { provider: "claudeCode", model: "claude-opus-5-5", effort: "high" },
  ]);
  assert.deepEqual(saved.roles.merger, {
    provider: "cursor",
    model: "composer",
  });
  await page.reload();
  assert.equal(
    await page.getByLabel("Reviewer provider", { exact: true }).inputValue(),
    "claudeCode",
  );
  assert.equal(
    await page
      .getByLabel("Implementer fallback 1 model", { exact: true })
      .inputValue(),
    "claude-opus-5-5",
  );
  await page
    .getByRole("button", { name: "Remove Implementer fallback 1" })
    .click();
  await page.getByRole("button", { name: "Save settings" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Settings saved." })
    .waitFor();
  assert.equal(
    (await loadRoleConfig({ cwd })).roles.implementer.fallback,
    undefined,
  );
});

test("cross-provider review preset and review policy save through the operator", async (t) => {
  const { page, cwd } = await fixture(t);
  await writeFile(join(cwd, "AGENTS.md"), "# Project rules\n");
  await page
    .getByRole("button", { name: "Use cross-provider review preset" })
    .click();
  assert.equal(
    await page.getByLabel("Reviewer provider", { exact: true }).inputValue(),
    "claudeCode",
  );
  await page.getByRole("button", { name: "Save settings" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Created CLAUDE.md importing AGENTS.md" })
    .waitFor();
  const saved = await loadRoleConfig({ cwd });
  assert.deepEqual(saved.roles.reviewer, {
    provider: "claudeCode",
    model: "claude-opus-5-5",
    effort: "high",
  });
  assert.equal(saved.roles.implementer.provider, "codex");
  await page.getByLabel("Require a different reviewer provider").check();
  await page.getByRole("button", { name: "Save workflow" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Workflow saved" })
    .waitFor();
  assert.deepEqual((await loadWorkflowConfig({ cwd })).review, {
    requireDifferentProvider: true,
  });
  await page.getByLabel("Review repair rounds").fill("0");
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/workflow") &&
        response.request().method() === "PUT",
    ),
    page.getByRole("button", { name: "Save workflow" }).click(),
  ]);
  assert.deepEqual((await loadWorkflowConfig({ cwd })).review, {
    requireDifferentProvider: true,
    maxRepairRounds: 0,
  });
  await page.getByLabel("Merge mode").selectOption("per-branch");
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/workflow") &&
        response.request().method() === "PUT",
    ),
    page.getByRole("button", { name: "Save workflow" }).click(),
  ]);
  const workflow = await loadWorkflowConfig({ cwd });
  assert.deepEqual(workflow.merge, { mode: "per-branch" });
  assert.equal(workflow.review.maxRepairRounds, 0);
});
