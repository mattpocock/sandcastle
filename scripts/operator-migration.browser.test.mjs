import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startOperator } from "../dist/index.js";
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
});
test("web reports unsupported code without evaluating it and protects mutations", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "migration-web-"));
  await mkdir(join(cwd, ".sandcastle"));
  await writeFile(
    join(cwd, ".sandcastle/main.ts"),
    'throw new Error("MUST NOT EVALUATE");\n',
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
      sandboxIdentity: async () => "fixture",
      run: async () => {},
    },
  });
  t.after(async () => {
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const response = await fetch(server.url + "/api/migrations/plan");
  assert.equal(response.status, 200);
  const plan = await response.json();
  assert.equal(plan.status, "unsupported");
  const unauthorized = await fetch(server.url + "/api/migrations/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision: plan.revision, preserveOverrides: true }),
  });
  assert.equal(unauthorized.status, 403);
  const session = await fetch(server.url);
  const cookie = session.headers.get("set-cookie").split(";")[0];
  for (const route of ["apply", "rollback"]) {
    const invalid = await fetch(server.url + "/api/migrations/" + route, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: server.url,
        Cookie: cookie,
      },
      body: JSON.stringify({
        revision: plan.revision,
        preserveOverrides: true,
        cwd: "/other-project",
      }),
    });
    assert.equal(invalid.status, 400);
  }
  assert.equal(
    (await fetch(server.url + "/api/migrations/backups")).status,
    404,
  );
  assert.equal((await fetch(server.url + "/.sandcastle/.env")).status, 404);
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(server.url);
  await page.getByRole("button", { name: "Preview project migration" }).click();
  await page.waitForFunction(() =>
    document
      .getElementById("migration-status")
      ?.textContent.includes("unsupported"),
  );
  assert.match(
    await page.getByLabel("Project migration plan").textContent(),
    /openProjectRuntime/,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Apply project migration", exact: true })
      .isEnabled(),
    false,
  );
});

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod } from "node:fs/promises";
import { resolve } from "node:path";
import {
  installRuntimeUpdate,
  planRuntimeUpdate,
  run as runAgent,
  planProjectMigration,
} from "../dist/index.js";
import { noSandbox } from "../dist/sandboxes/no-sandbox.js";
const exec = promisify(execFile);
const roles = {
  planner: "plan",
  implementer: "implement",
  reviewer: "review",
  merger: "merge",
  readiness: "readiness",
};
for (const profile of ["node", "android"])
  test(
    "web reviews and confirms " +
      profile +
      " migrations with registry upgrades and real provider settings",
    async (t) => {
      const cwd = await mkdtemp(
        join(tmpdir(), "migration-" + profile + "-web-"),
      );
      await mkdir(join(cwd, ".sandcastle"));
      t.after(() => rm(cwd, { recursive: true, force: true }));
      await writeFile(
        join(cwd, "package.json"),
        JSON.stringify({ type: "module", scripts: { test: "vitest run" } }),
      );
      if (profile === "android") {
        await mkdir(join(cwd, "app"));
        await writeFile(join(cwd, "gradlew"), "#!/usr/bin/env sh\n");
        await writeFile(
          join(cwd, "settings.gradle.kts"),
          'rootProject.name="consumer"\n',
        );
        await writeFile(
          join(cwd, "app/build.gradle.kts"),
          'plugins { id("com.android.application") }\nandroid { compileSdk = 35 }\n',
        );
      }
      const legacy = await readFile(
        "dist/templates/migrations/" + profile + ".txt",
        "utf8",
      );
      await writeFile(join(cwd, ".sandcastle/main.ts"), legacy);
      const bases = JSON.parse(
        await readFile(
          "dist/templates/migrations/" + profile + "-prompts.json",
          "utf8",
        ),
      );
      for (const [role, file] of Object.entries(roles))
        await writeFile(
          join(cwd, ".sandcastle/" + file + "-prompt.md"),
          bases[role],
        );
      await writeFile(
        join(cwd, ".sandcastle/readiness.json"),
        JSON.stringify({
          repository: "owner/project",
          mode: "report-only",
          holdLabels: ["manual-hold"],
          qualificationLabel: "project-qualified",
        }),
      );
      await writeFile(
        join(cwd, ".sandcastle/.env"),
        "AUTH_REFERENCE=private-auth-value\n",
      );
      await mkdir(join(cwd, ".sandcastle/codex-home/sessions"), {
        recursive: true,
      });
      await writeFile(
        join(cwd, ".sandcastle/codex-home/auth.json"),
        "private-auth-value",
      );
      await writeFile(
        join(cwd, ".sandcastle/codex-home/sessions/run.json"),
        "private-session-value",
      );
      const pkg = join(cwd, "package-fixture");
      await mkdir(join(pkg, "dist/templates/parallel-planner-with-review"), {
        recursive: true,
      });
      const tarballs = new Map();
      let metadata;
      const registry = createServer((req, res) => {
        if (tarballs.has(req.url)) {
          res.end(tarballs.get(req.url));
          return;
        }
        if (decodeURIComponent(req.url.slice(1)) === "@test/migration-fork") {
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              name: metadata.name,
              "dist-tags": { latest: metadata.version },
              versions: { [metadata.version]: metadata },
            }),
          );
          return;
        }
        res.writeHead(404);
        res.end("{}");
      });
      await new Promise((r) => registry.listen(0, "127.0.0.1", r));
      t.after(async () => {
        registry.closeAllConnections();
        await new Promise((r) => registry.close(r));
      });
      const registryUrl = "http://127.0.0.1:" + registry.address().port;
      async function publishFixture(commit) {
        const provenance = {
          schemaVersion: 1,
          source: "https://github.com/hanhnghh/sandcastle",
          commit: commit.repeat(40),
          version: "0.12.0",
        };
        metadata = {
          name: "@test/migration-fork",
          version: "0.12.0",
          type: "module",
          exports: { ".": "./dist/index.js" },
          sandcastleRuntime: provenance,
        };
        await writeFile(join(pkg, "package.json"), JSON.stringify(metadata));
        await writeFile(
          join(pkg, "runtime-source.json"),
          JSON.stringify(provenance),
        );
        for (const file of [
          "LICENSE",
          "dist/main.js",
          "dist/index.d.ts",
          "dist/templates/parallel-planner-with-review/implement-prompt.md",
        ])
          await writeFile(join(pkg, file), "fixture");
        await writeFile(
          join(pkg, "dist/index.js"),
          "export * from " +
            JSON.stringify("file://" + resolve("dist/index.js")) +
            ";",
        );
        const packed = JSON.parse(
          (
            await exec("npm", ["pack", "--json", "--ignore-scripts"], {
              cwd: pkg,
            })
          ).stdout,
        )[0];
        const route = "/fork-" + commit + ".tgz";
        tarballs.set(route, await readFile(join(pkg, packed.filename)));
        metadata.dist = {
          tarball: registryUrl + route,
          integrity: packed.integrity,
        };
      }
      await publishFixture("a");
      await writeFile(
        join(cwd, ".sandcastle/updates.json"),
        JSON.stringify({
          schemaVersion: 1,
          package: metadata.name,
          dependency: "@ai-hero/sandcastle",
          registry: registryUrl,
          channel: "latest",
          manifest: ".sandcastle/package.json",
          source: { kind: "registry" },
        }),
      );
      await installRuntimeUpdate({
        cwd,
        version: null,
        expectedRevision: null,
        onProgress: () => {},
      });
      await writeFile(
        join(cwd, ".sandcastle/main.ts"),
        legacy
          .replaceAll("fixture-model", "custom-upgraded-model")
          .replace("const MAX_ITERATIONS = 10;", "const MAX_ITERATIONS = 8;")
          .replace(".sandcastle/codex-home", ".sandcastle/custom-codex-home")
          .replace(
            "CODEX_HOME: CODEX_HOME_SANDBOX",
            'CODEX_HOME: CODEX_HOME_SANDBOX, API_TOKEN: `inline-private-value`, API_SECRET: "quoted-private-value"',
          ),
      );
      await writeFile(
        join(cwd, ".sandcastle/implement-prompt.md"),
        bases.implementer +
          '\nBrowser project override\nAPI_TOKEN: "prompt-private-value"\n',
      );
      await publishFixture("b");
      assert.equal(
        (await planRuntimeUpdate({ cwd, version: null })).action,
        "update",
      );
      await installRuntimeUpdate({
        cwd,
        version: null,
        expectedRevision: null,
        onProgress: () => {},
      });
      let observed, output, releaseRun;
      const runWait = new Promise((resolve) => {
        releaseRun = resolve;
      });
      t.after(() => releaseRun());
      const bin = join(cwd, "bin");
      await mkdir(bin);
      await writeFile(
        join(bin, "codex"),
        `#!/usr/bin/env node
let input='';for await(const chunk of process.stdin)input+=chunk;
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:process.argv.slice(2).join(' ')+' '+input+' <promise>COMPLETE</promise>'}}));
`,
      );
      await chmod(join(bin, "codex"), 0o755);
      await writeFile(
        join(cwd, ".gitignore"),
        "package-fixture/\nbin/\n.sandcastle/node_modules/\n.sandcastle/runtime/\n.sandcastle/migrations/\n.sandcastle/updates/\n.sandcastle/codex-home/\n.sandcastle/.env\n.sandcastle/logs/\n",
      );
      for (const args of [
        ["init", "-qb", "main"],
        ["config", "user.name", "Migration fixture"],
        ["config", "user.email", "fixture@example.test"],
        ["add", "."],
        ["commit", "-qm", "consumer"],
      ])
        await exec("git", args, { cwd });
      const promptFiles = Object.fromEntries(
        Object.entries(roles).map(([role, file]) => [
          role,
          ".sandcastle/" + file + "-prompt.md",
        ]),
      );
      const server = await startOperator({
        cwd,
        port: 0,
        adapter: {
          promptFiles,
          sandboxIdentity: async () => "sha256:" + "d".repeat(64),
          run: async (runtime) => {
            observed = runtime;
            const result = await runAgent({
              cwd,
              agent: runtime.agent("implementer", { captureSessions: false }),
              sandbox: noSandbox({
                env: {
                  PATH: bin + ":" + process.env.PATH,
                  GIT_CONFIG_GLOBAL: join(cwd, "gitconfig"),
                },
              }),
              promptFile: runtime.promptFile("implementer"),
              promptArgs: {
                TASK_ID: "7",
                ISSUE_TITLE: "migration fixture",
                BRANCH: "main",
              },
              logging: {
                type: "file",
                path: join(cwd, ".sandcastle/logs/provider.log"),
              },
            });
            output = result.stdout;
            await runWait;
          },
        },
      });
      t.after(() => server.close());
      const page = await browser.newPage();
      t.after(() => page.close());
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(server.url);
      await page
        .getByRole("button", { name: "Preview project migration" })
        .click();
      await page.waitForFunction(() =>
        document
          .getElementById("migration-status")
          .textContent.startsWith("ready"),
      );
      const wirePlan = await (
        await page.request.get(server.url + "/api/migrations/plan")
      ).text();
      for (const secret of [
        "inline-private-value",
        "quoted-private-value",
        "prompt-private-value",
        "private-auth-value",
        "private-session-value",
      ])
        assert.ok(
          !wirePlan.includes(secret),
          "migration HTTP plan leaked a private fixture value",
        );
      const review = await page
        .getByLabel("Project migration plan")
        .textContent();
      assert.match(review, /main.ts/);
      assert.match(review, /openProjectRuntime/);
      assert.match(review, /base → default/);
      assert.match(review, /Browser project override/);
      assert.ok(!review.includes("private-auth-value"));
      assert.ok(!review.includes("private-session-value"));
      assert.ok(!review.includes("inline-private-value"));
      assert.ok(!review.includes("quoted-private-value"));
      assert.ok(!review.includes("prompt-private-value"));
      const apply = page.getByRole("button", {
        name: "Apply project migration",
        exact: true,
      });
      assert.equal(await apply.isEnabled(), false);
      await page.getByLabel("I have reviewed the migration file diffs").check();
      assert.equal(await apply.isEnabled(), false);
      await page
        .getByLabel("Preserve all project prompt overrides and conflicts")
        .check();
      assert.equal(await apply.isEnabled(), true);
      await writeFile(
        join(cwd, ".sandcastle/main.ts"),
        (await readFile(join(cwd, ".sandcastle/main.ts"), "utf8")) +
          "\n// Concurrent host edit\n",
      );
      await apply.focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() =>
        document
          .getElementById("migration-status")
          .textContent.includes("snapshot changed"),
      );
      await writeFile(
        join(cwd, ".sandcastle/main.ts"),
        legacy
          .replaceAll("fixture-model", "custom-upgraded-model")
          .replace("const MAX_ITERATIONS = 10;", "const MAX_ITERATIONS = 8;")
          .replace(".sandcastle/codex-home", ".sandcastle/custom-codex-home")
          .replace(
            "CODEX_HOME: CODEX_HOME_SANDBOX",
            'CODEX_HOME: CODEX_HOME_SANDBOX, API_TOKEN: `inline-private-value`, API_SECRET: "quoted-private-value"',
          ),
      );
      await page
        .getByRole("button", { name: "Preview project migration" })
        .click();
      await page.waitForFunction(() =>
        document
          .getElementById("migration-status")
          .textContent.startsWith("ready"),
      );
      await page.getByLabel("I have reviewed the migration file diffs").check();
      await page
        .getByLabel("Preserve all project prompt overrides and conflicts")
        .check();
      await apply.click();
      await page.waitForFunction(() =>
        document
          .getElementById("migration-status")
          .textContent.startsWith("completed"),
      );
      await page.waitForFunction(
        () =>
          document.getElementById("implementer-custom").value ===
          "custom-upgraded-model",
      );
      await page
        .getByRole("button", { name: "Start run", exact: true })
        .click();
      await page.waitForFunction(() =>
        document.getElementById("run").textContent.includes("running"),
      );
      const activeRollback = await page.evaluate(async () => {
        const response = await fetch("/api/migrations/rollback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        return { status: response.status, body: await response.json() };
      });
      assert.equal(activeRollback.status, 409);
      assert.match(activeRollback.body.error, /Active project run/);
      releaseRun();
      await page.waitForFunction(() =>
        document.getElementById("run").textContent.includes("completed"),
      );
      assert.equal(observed.workflow.config.limits.cycles, 8);
      assert.equal(observed.readiness.qualificationLabel, "project-qualified");
      assert.match(output, /-m custom-upgraded-model/);
      assert.match(output, /Browser project override/);
      assert.equal(observed.record.config.roles.reviewer.effort, "xhigh");
      await page
        .getByRole("button", { name: "Roll back migration", exact: true })
        .click();
      await page.waitForFunction(() =>
        document
          .getElementById("migration-status")
          .textContent.startsWith("rolled-back"),
      );
      assert.equal(
        await readFile(join(cwd, ".sandcastle/main.ts"), "utf8"),
        legacy
          .replaceAll("fixture-model", "custom-upgraded-model")
          .replace("const MAX_ITERATIONS = 10;", "const MAX_ITERATIONS = 8;")
          .replace(".sandcastle/codex-home", ".sandcastle/custom-codex-home")
          .replace(
            "CODEX_HOME: CODEX_HOME_SANDBOX",
            'CODEX_HOME: CODEX_HOME_SANDBOX, API_TOKEN: `inline-private-value`, API_SECRET: "quoted-private-value"',
          ),
      );
      assert.equal(
        await readFile(join(cwd, ".sandcastle/codex-home/auth.json"), "utf8"),
        "private-auth-value",
      );
      assert.deepEqual(errors, []);
      const cli = await exec(process.execPath, [
        resolve("dist/main.js"),
        "migration",
        "--cwd",
        cwd,
        "--dry-run",
      ]);
      assert.equal(
        JSON.parse(cli.stdout.split("\n").find((line) => line.startsWith("{")))
          .status,
        "ready",
      );
      const cliPlan = await planProjectMigration({ cwd });
      await exec(process.execPath, [
        resolve("dist/main.js"),
        "migration",
        "--cwd",
        cwd,
        "--apply",
        "--revision",
        cliPlan.revision,
        "--preserve-overrides",
      ]);
      assert.equal((await planProjectMigration({ cwd })).status, "current");
      await exec(process.execPath, [
        resolve("dist/main.js"),
        "migration",
        "--cwd",
        cwd,
        "--rollback",
      ]);
      assert.equal((await planProjectMigration({ cwd })).status, "ready");
      await assert.rejects(
        exec(process.execPath, [
          resolve("dist/main.js"),
          "migration",
          "--cwd",
          cwd,
          "--apply",
        ]),
        (error) => error.stdout.includes("Apply requires --revision"),
      );
    },
  );
