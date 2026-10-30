import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { startOperator, loadEnvironmentConfig } from "../dist/index.js";
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
});
const adapter = {
  promptFiles: {
    planner: null,
    implementer: null,
    reviewer: null,
    merger: null,
    readiness: null,
  },
  sandboxIdentity: async () => "fixture",
  run: async () => {},
};
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "environment-browser-"));
  const bin = join(cwd, "bin");
  await mkdir(bin);
  await mkdir(join(cwd, ".sandcastle"));
  await writeFile(join(cwd, ".sandcastle/Dockerfile"), "FROM fixture");
  await writeFile(
    join(cwd, ".sandcastle/project.json"),
    JSON.stringify({
      schemaVersion: 1,
      projectType: "node",
      packageManager: "npm",
    }),
  );
  await writeFile(
    join(bin, "docker"),
    `#!/usr/bin/env node
const fs=require('node:fs'), args=process.argv.slice(2);
if(args[0]==='image' && args[1]==='ls') console.log('fixture:installed');
else if(args[0]==='image' && args[1]==='inspect') console.log('sha256:'+'a'.repeat(64));
else if(args[0]==='run' && args.includes('id')) console.log(process.getuid());
else if(args[0]==='build') {console.log('Readable live build output');console.log('<img src=x onerror=globalThis.logInjection=true>'); const timer=setInterval(()=>{if(fs.existsSync('finish')) {clearInterval(timer);process.exit(fs.readFileSync('finish','utf8')==='fail'?1:0);}},20);}
`,
  );
  await chmod(join(bin, "docker"), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = bin + ":" + previous;
  let server = await startOperator({ cwd, port: 0, adapter });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(5000);
  t.after(async () => {
    await page.close();
    await server.close();
    process.env.PATH = previous;
    await rm(cwd, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  await page.goto(server.url);
  return {
    cwd,
    page,
    server,
    restart: async () => {
      await server.close();
      server = await startOperator({ cwd, port: 0, adapter });
      await page.goto(server.url);
    },
  };
}
test("environment forms persist selection and stream cancellable jobs", async (t) => {
  const { cwd, page, restart } = await fixture(t);
  await page
    .getByLabel("Docker image", { exact: true })
    .selectOption("fixture:installed");
  await page
    .getByRole("button", { name: "Save environment", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("status")
    .filter({ hasText: "Environment saved" })
    .waitFor();
  assert.equal(
    (await loadEnvironmentConfig({ cwd })).image,
    "fixture:installed",
  );
  await page.getByLabel("Docker image", { exact: true }).selectOption("custom");
  await page.getByLabel("Custom Docker image").fill("fixture:custom");
  await page
    .getByRole("button", { name: "Save environment", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Environment saved" })
    .waitFor();
  await page
    .getByRole("status")
    .filter({ hasText: "Configured image: fixture:custom" })
    .waitFor();
  await restart();
  await page
    .getByRole("status")
    .filter({ hasText: "Configured image: fixture:custom" })
    .waitFor();
  assert.equal(
    await page.getByLabel("Custom Docker image").inputValue(),
    "fixture:custom",
  );
  await page.getByLabel("Dockerfile", { exact: true }).fill("../unsafe");
  await page
    .getByRole("button", { name: "Save environment", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Invalid environment settings" })
    .waitFor();
  assert.equal(
    (await loadEnvironmentConfig({ cwd })).dockerfile,
    ".sandcastle/Dockerfile",
  );
  await page
    .getByLabel("Dockerfile", { exact: true })
    .fill(".sandcastle/Dockerfile");
  for (const status of ["completed", "failed", "cancelled"]) {
    await rm(join(cwd, "finish"), { force: true });
    await page
      .getByRole("button", { name: "Build image", exact: true })
      .click();
    await page
      .getByLabel("Environment job logs")
      .filter({ hasText: "Readable live build output" })
      .waitFor();
    assert.equal(await page.locator("img").count(), 0);
    assert.equal(await page.evaluate(() => globalThis.logInjection), undefined);
    await page
      .getByRole("status")
      .filter({ hasText: "build · running" })
      .waitFor();
    await page.reload();
    await page
      .getByLabel("Environment job logs")
      .filter({ hasText: "Readable live build output" })
      .waitFor();
    await page
      .getByRole("status")
      .filter({ hasText: "build · running" })
      .waitFor();
    if (status === "cancelled") {
      await page
        .getByRole("button", { name: "Cancel environment job", exact: true })
        .focus();
      await page.keyboard.press("Enter");
    } else
      await writeFile(
        join(cwd, "finish"),
        status === "failed" ? "fail" : "success",
      );
    await page
      .getByRole("status")
      .filter({ hasText: "build · " + status })
      .waitFor();
  }
  await page
    .getByRole("button", { name: "Run preflight", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "preflight · failed" })
    .waitFor();
  assert.ok(
    (await page.getByLabel("Environment job logs").textContent()).includes(
      "Auth Codex: missing",
    ),
  );
  await page.getByRole("link", { name: "Observe runs and logs" }).focus();
  assert.equal(
    await page
      .getByRole("link", { name: "Observe runs and logs" })
      .evaluate((el) => el === document.activeElement),
    true,
  );
});

test("environment saves isolate browser projects", async (t) => {
  const first = await fixture(t),
    second = await fixture(t);
  await first.page
    .getByLabel("Docker image", { exact: true })
    .selectOption("custom");
  await first.page.getByLabel("Custom Docker image").fill("fixture:only-first");
  await first.page
    .getByRole("button", { name: "Save environment", exact: true })
    .click();
  await first.page
    .getByRole("status")
    .filter({ hasText: "Environment saved" })
    .waitFor();
  await second.page.reload();
  assert.notEqual(
    (await loadEnvironmentConfig({ cwd: second.cwd })).image,
    "fixture:only-first",
  );
  assert.notEqual(
    await second.page.getByLabel("Custom Docker image").inputValue(),
    "fixture:only-first",
  );
});
