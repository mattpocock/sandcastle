import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startOperator, loadWorkflowConfig } from "../dist/index.js";
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
});
async function fixture(t, delayMs = 40) {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-browser-"));
  await mkdir(join(cwd, ".sandcastle"));
  let outcome = "qualification-pending",
    maximum = 0;
  await writeFile(
    join(cwd, ".sandcastle/feedback-gates.json"),
    JSON.stringify({
      verifiers: {
        project: [
          process.execPath,
          "-e",
          "console.log(JSON.stringify({approved:[],dependencyCommits:{}}))",
        ],
      },
      gates: {
        tests: [
          process.execPath,
          "-e",
          "console.error('credential-value');process.exit(1)",
        ],
      },
    }),
  );
  const server = await startOperator({
    cwd,
    port: 0,
    adapter: {
      promptFiles: {
        planner: null,
        implementer: null,
        reviewer: null,
        merger: null,
        readiness: null,
      },
      sandboxIdentity: async () => "fake-image",
      run: async (runtime) => {
        if (runtime.workflow.config.readiness.gates.length) {
          await runtime.verifyReadiness({
            snapshot: {
              head: "a".repeat(40),
              repository: "owner/project",
              scopeLabel: "Sandcastle",
              issues: [],
            },
            assessment: { head: "a".repeat(40), decisions: [] },
            trigger: { kind: "startup" },
          });
          return;
        }
        let active = 0;
        await runtime.settleIssues([7, 8, 9], async () => {
          active++;
          maximum = Math.max(maximum, active);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          active--;
        });
        await runtime.reportOutcome({ code: outcome, issues: [7] });
      },
    },
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.url);
  t.after(async () => {
    await context.close();
    let run;
    try {
      for (let attempt = 0; attempt < 200; attempt++) {
        const response = await fetch(server.url + "/api/run");
        assert.equal(response.status, 200);
        ({ run } = await response.json());
        if (run?.status !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.notEqual(
        run?.status,
        "running",
        "Owned fixture run must settle before removing its project",
      );
    } finally {
      await server.close();
    }
    await rm(cwd, { recursive: true, force: true });
  });
  return {
    cwd,
    page,
    server,
    setOutcome: (value) => {
      outcome = value;
      maximum = 0;
    },
    maximum: () => maximum,
  };
}
async function waitText(page, selector, text) {
  await page.waitForFunction(
    ({ selector, text }) =>
      document.querySelector(selector)?.textContent.includes(text),
    { selector, text },
  );
}
test("workflow browser configuration and diagnostics: persistence, keyboard, limits, invalid settings, verifier, gate failure and qualification", async (t) => {
  const f = await fixture(t),
    { page, cwd } = f;
  await page.getByLabel("Repository (owner/repository)").waitFor();
  assert.equal(
    await page.getByLabel("Readiness mode", { exact: true }).inputValue(),
    "report-only",
  );
  await waitText(
    page,
    "#workflow-diagnostics",
    "Missing trusted project verifier",
  );
  await page.getByLabel("Repository (owner/repository)").fill("owner/project");
  await page.getByLabel("Workflow cycles").fill("1");
  await page.getByLabel("Issue concurrency").fill("1");
  await page.getByRole("button", { name: "Save workflow" }).focus();
  await page.keyboard.press("Enter");
  await waitText(page, "#feedback", "Workflow saved");
  assert.equal((await loadWorkflowConfig({ cwd })).limits.concurrency, 1);
  await page.reload();
  assert.equal(
    await page.getByLabel("Repository (owner/repository)").inputValue(),
    "owner/project",
  );
  assert.equal(await page.getByLabel("Workflow cycles").inputValue(), "1");
  await page.getByLabel("Scope label").fill("bad$label");
  await page.getByRole("button", { name: "Save workflow" }).click();
  await waitText(page, "#feedback", "workflow.scopeLabel");
  assert.equal((await loadWorkflowConfig({ cwd })).scopeLabel, "Sandcastle");
  await page.getByLabel("Scope label").fill("Sandcastle");
  await page
    .getByLabel("Readiness mode", { exact: true })
    .selectOption("apply");
  await page.getByRole("button", { name: "Save workflow" }).click();
  await waitText(page, "#feedback", "trusted project verifier");
  assert.equal(
    (await loadWorkflowConfig({ cwd })).readiness.mode,
    "report-only",
  );
  await page.getByLabel("Trusted verifier").selectOption("project");
  await page.getByRole("button", { name: "Save workflow" }).click();
  await waitText(page, "#feedback", "Workflow saved");
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  await waitText(page, "#run", "External qualification pending: 7");
  assert.equal(f.maximum(), 1);
  assert.equal(
    await page
      .getByRole("link", { name: "Observe runs and logs" })
      .getAttribute("href"),
    "/dashboard",
  );
  f.setOutcome("no-progress");
  await page.getByLabel("Issue concurrency").fill("2");
  await page.getByRole("button", { name: "Save workflow" }).click();
  await waitText(page, "#feedback", "Workflow saved");
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  await waitText(page, "#run", "No verified implementation progress");
  assert.equal(f.maximum(), 2);
  await page.getByLabel("Feedback gate tests").check();
  await page.getByRole("button", { name: "Save workflow" }).click();
  await waitText(page, "#feedback", "Workflow saved");
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  await waitText(page, "#run", "Project feedback gate or verifier failed");
  assert.equal(
    (await page.locator("body").innerText()).includes("credential-value"),
    false,
  );
  assert.equal(
    JSON.stringify(
      await (await fetch(f.server.url + "/api/workflow")).json(),
    ).includes("console.error"),
    false,
  );
});

test("workflow browser repository settings and frozen runs isolate selected projects", async (t) => {
  const first = await fixture(t, 500),
    second = await fixture(t, 500);
  await first.page
    .getByLabel("Repository (owner/repository)")
    .fill("owner/first");
  await first.page.getByRole("button", { name: "Save workflow" }).click();
  await waitText(first.page, "#feedback", "Workflow saved");
  assert.equal(
    (await loadWorkflowConfig({ cwd: second.cwd })).repository,
    null,
  );
  await second.page
    .getByLabel("Repository (owner/repository)")
    .fill("owner/second");
  await second.page.getByRole("button", { name: "Save workflow" }).click();
  await waitText(second.page, "#feedback", "Workflow saved");
  await first.page.reload();
  await second.page.reload();
  assert.equal(
    await first.page.getByLabel("Repository (owner/repository)").inputValue(),
    "owner/first",
  );
  assert.equal(
    await second.page.getByLabel("Repository (owner/repository)").inputValue(),
    "owner/second",
  );
  await first.page
    .getByRole("button", { name: "Start run", exact: true })
    .click();
  await second.page
    .getByRole("button", { name: "Start run", exact: true })
    .click();
  await waitText(first.page, "#run", "Repository: owner/first");
  await waitText(second.page, "#run", "Repository: owner/second");
  assert.equal(
    (await loadWorkflowConfig({ cwd: first.cwd })).repository,
    "owner/first",
  );
  assert.equal(
    (await loadWorkflowConfig({ cwd: second.cwd })).repository,
    "owner/second",
  );
});
