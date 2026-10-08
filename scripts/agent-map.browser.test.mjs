import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createAgentMap, startDashboard } from "../dist/index.js";

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
});

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "dashboard-browser-"));
  const previous = await createAgentMap({ cwd, name: "Previous session" });
  await previous.track(
    { batch: 1, role: "planner", title: "Archived planner", branch: "main" },
    async () => ({ completionSignal: "<promise>COMPLETE</promise>" }),
  );
  await previous.finish("completed");
  const map = await createAgentMap({ cwd, name: "Platform delivery" });
  await map.recordPlan(1, {
    issues: [{ id: "20", title: "Tenant-aware cache", branch: "issue-20" }],
    decisions: [
      {
        id: "20",
        disposition: "selected",
        reason: "Independent public contract",
        likelyAreas: ["cache"],
      },
    ],
  });
  let emit, finish;
  const ended = new Promise((resolve) => {
    finish = resolve;
  });
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const work = map.track(
    {
      batch: 1,
      role: "implementer",
      issueId: "20",
      title: "Tenant-aware cache",
      branch: "issue-20",
      model: "Test model",
    },
    async (logging) => {
      emit = (message, type = "text") => {
        if (logging.type === "file")
          logging.onAgentStreamEvent?.(
            type === "text"
              ? { type, message, timestamp: new Date(), iteration: 1 }
              : {
                  type: "toolCall",
                  name: "Bash",
                  formattedArgs: message,
                  timestamp: new Date(),
                  iteration: 1,
                },
          );
      };
      emit("npm test -- cache", "toolCall");
      emit("PASS tenant isolation");
      emit("PASS tenant invalidation");
      emit('<img src=x onerror="window.injected=true"> untrusted output');
      for (let i = 0; i < 55; i++)
        emit(`Evidence line ${i + 1}: verifying scoped cache contract.`);
      started();
      await ended;
      return { completionSignal: "<promise>COMPLETE</promise>", commits: [] };
    },
  );
  await ready;
  const server = await startDashboard({ cwd, port: 0 });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    permissions: ["clipboard-read", "clipboard-write"],
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    finish();
    await work;
    await map.finish("completed");
    await context.close();
    await server.close();
    await rm(cwd, { recursive: true, force: true });
    assert.deepEqual(errors, [], "No uncaught browser errors");
  });
  await page.goto(server.url + "/#run=" + map.id);
  await page
    .getByRole("heading", { name: "Platform delivery", exact: true })
    .waitFor();
  return { page, map, previous, emit, server, context };
}

test("workflow navigation is legible, responsive, and opens a spacious job log", async (t) => {
  const { page } = await fixture(t);
  assert.equal(
    await page
      .getByRole("tab", { name: "Workflow", exact: true })
      .getAttribute("aria-selected"),
    "true",
  );
  assert.ok(
    (await page
      .locator("body")
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize))) >= 14,
  );
  await page
    .getByRole("button", { name: /Implementer.*#20.*Tenant-aware cache/ })
    .first()
    .click();
  assert.equal(
    await page
      .getByRole("tab", { name: "Logs", exact: true })
      .getAttribute("aria-selected"),
    "true",
  );
  const output = page.getByRole("log", { name: "Agent activity" });
  await output.getByText("PASS tenant isolation", { exact: true }).waitFor();
  assert.ok((await output.boundingBox()).width > 800);
  assert.equal(
    await output.locator("img").count(),
    0,
    "Agent output is text, not executable markup",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => !document.getElementById("agent-sidebar").open,
  );
  assert.equal(
    await page.locator("#agent-sidebar").evaluate((el) => el.open),
    false,
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.ok(
    (await page.getByLabel("Search activity").boundingBox()).width >= 150,
  );
});

test("search, type filtering, copy and download operate on recorded activity only", async (t) => {
  const { page } = await fixture(t);
  await page
    .getByRole("button", { name: /Implementer.*#20.*Tenant-aware cache/ })
    .first()
    .click();
  await page.getByLabel("Search activity").fill("tenant");
  await page.getByText("1 of 2 matches", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Next match", exact: true }).click();
  await page.getByText("2 of 2 matches", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Copy visible activity", exact: true })
    .click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(copied.includes("PASS tenant isolation"));
  assert.ok(!copied.includes("Evidence line"));
  await page.getByLabel("Search activity").fill("");
  await page.getByLabel("Event type").selectOption("toolCall");
  await page.getByText("1 event shown", { exact: true }).waitFor();
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download recorded activity", exact: true })
    .click();
  const download = await downloadPromise;
  const text = await readFile(await download.path(), "utf8");
  assert.ok(
    text.includes("PASS tenant isolation"),
    "Download includes retained events, independent of display filters",
  );
  assert.ok(text.includes("recent recorded activity"));
});

test("live updates preserve reading position and selection; pausing freezes observation only", async (t) => {
  const { page, emit } = await fixture(t);
  await page
    .getByRole("button", { name: /Implementer.*#20.*Tenant-aware cache/ })
    .first()
    .click();
  const output = page.getByRole("log", { name: "Agent activity" });
  await page.getByLabel("Follow output").uncheck();
  await output.evaluate((el) => {
    el.scrollTop = 150;
  });
  const before = await output.evaluate((el) => el.scrollTop);
  emit("New progress after first snapshot");
  await output
    .getByText("New progress after first snapshot", { exact: true })
    .waitFor();
  assert.ok(
    Math.abs((await output.evaluate((el) => el.scrollTop)) - before) < 2,
  );
  await page
    .getByRole("button", { name: "Pause updates", exact: true })
    .click();
  emit("Progress while dashboard paused");
  await page
    .getByLabel("Search activity")
    .fill("Progress while dashboard paused");
  await page.getByText("No matching activity", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Resume updates", exact: true })
    .click();
  await output
    .getByText("Progress while dashboard paused", { exact: true })
    .waitFor();
});

test("a selected job stays pinned to its batch while later batches arrive", async (t) => {
  const { page, map } = await fixture(t);
  await page
    .getByRole("button", { name: /Implementer.*#20.*Tenant-aware cache/ })
    .first()
    .click();
  await map.track(
    { batch: 2, role: "planner", title: "Plan next batch", branch: "main" },
    async () => ({ completionSignal: "<promise>COMPLETE</promise>" }),
  );
  await page
    .getByLabel("Batch", { exact: true })
    .locator('option[value="2"]')
    .waitFor({ state: "attached" });
  assert.equal(
    await page.getByLabel("Batch", { exact: true }).inputValue(),
    "1",
  );
  assert.equal(
    await page
      .getByRole("log", { name: "Agent activity" })
      .getByText("PASS tenant isolation", { exact: true })
      .count(),
    1,
  );
  await page.getByLabel("Batch", { exact: true }).selectOption("latest");
  await page
    .getByRole("heading", { name: "Plan next batch", exact: true })
    .waitFor();
  await map.track(
    { batch: 3, role: "planner", title: "Plan latest batch", branch: "main" },
    async () => ({ completionSignal: "<promise>COMPLETE</promise>" }),
  );
  await page
    .getByRole("heading", { name: "Plan latest batch", exact: true })
    .waitFor();
});

test("connection failures retain the last snapshot and recover without losing the selected job", async (t) => {
  const { page } = await fixture(t);
  await page
    .getByRole("button", { name: /Implementer.*#20.*Tenant-aware cache/ })
    .first()
    .click();
  await page
    .getByRole("log", { name: "Agent activity" })
    .getByText("PASS tenant isolation", { exact: true })
    .waitFor();
  await page.route("**/api/runs", (route) => route.abort());
  await page.getByText("Connection lost · retrying", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("log", { name: "Agent activity" })
      .getByText("PASS tenant isolation", { exact: true })
      .count(),
    1,
  );
  await page.unroute("**/api/runs");
  await page.locator('#connection[data-state="live"]').waitFor();
  assert.equal(
    await page
      .getByRole("tab", { name: "Logs", exact: true })
      .getAttribute("aria-selected"),
    "true",
  );
});

test("deep links restore the selected job, filters stay keyboard-accessible, and switching runs clears old output", async (t) => {
  const { page, previous } = await fixture(t);
  await page
    .getByRole("button", { name: /Implementer.*#20.*Tenant-aware cache/ })
    .first()
    .click();
  const url = page.url();
  await page.reload();
  await page
    .getByRole("log", { name: "Agent activity" })
    .getByText("PASS tenant isolation", { exact: true })
    .waitFor();
  assert.equal(page.url(), url);
  await page.getByLabel("Find agents").fill("no-such-agent");
  await page
    .getByText("No agents match these filters.", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Clear agent filters", exact: true })
    .click();
  await page.getByRole("tab", { name: "Workflow", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page
      .getByRole("tab", { name: "Logs", exact: true })
      .getAttribute("aria-selected"),
    "true",
  );
  await page.getByLabel("Recorded session").selectOption(previous.id);
  await page
    .getByRole("heading", { name: "Previous session", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("log", { name: "Agent activity" })
      .getByText("PASS tenant isolation", { exact: true })
      .count(),
    0,
  );
});
