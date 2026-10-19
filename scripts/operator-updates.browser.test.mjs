import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const exec = promisify(execFile);
const cliPath = resolve("dist/main.js");
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "runtime-update-"));
  await mkdir(join(cwd, ".sandcastle"));
  const requests = [];
  const tarballs = new Map(),
    packages = new Map();
  await mkdir(join(cwd, "dependencies"));
  for (const name of ["@clack/prompts", "@clack/core", "sisteransi"]) {
    const path = resolve("node_modules", name),
      data = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
    const packed = JSON.parse(
      (
        await exec(
          "npm",
          [
            "pack",
            "--json",
            "--ignore-scripts",
            "--pack-destination",
            join(cwd, "dependencies"),
          ],
          { cwd: path },
        )
      ).stdout,
    )[0];
    const route = "/" + packed.filename;
    tarballs.set(
      route,
      await readFile(join(cwd, "dependencies", packed.filename)),
    );
    packages.set(name, {
      ...data,
      dist: { tarball: route, integrity: packed.integrity },
    });
  }
  let mode = "normal",
    delay = 0,
    forkMetadata = null,
    tarballFailure = false;
  const server = createServer((req, res) => {
    requests.push(req.url);
    const respond = () => {
      if (tarballs.has(req.url)) {
        if (tarballFailure && req.url.startsWith("/fork-")) {
          res.writeHead(503);
          res.end("unavailable");
          return;
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.end(tarballs.get(req.url));
        return;
      }
      const name = decodeURIComponent(req.url.slice(1));
      if (packages.has(name)) {
        const data = packages.get(name);
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            name,
            "dist-tags": { latest: data.version },
            versions: {
              [data.version]: {
                ...data,
                dist: {
                  ...data.dist,
                  tarball:
                    `http://127.0.0.1:${server.address().port}` +
                    data.dist.tarball,
                },
              },
            },
          }),
        );
        return;
      }
      if (name !== "@test/fork") {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      if (mode === "auth" || mode === "missing") {
        res.writeHead(mode === "auth" ? 401 : 404);
        res.end(JSON.stringify({ error: "registry-token-value" }));
        return;
      }
      if (forkMetadata) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(forkMetadata));
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          name: "@test/fork",
          "dist-tags": {
            latest: "0.13.2",
            beta: "0.14.0-beta.1",
            release_candidate: "0.14.0-beta.1",
          },
          versions: Object.fromEntries(
            ["0.13.2", "0.13.1", "0.14.0-beta.1"].map((version) => [
              version,
              {
                name: "@test/fork",
                version,
                description: "Fork changelog " + version,
                dist: {
                  tarball: `http://127.0.0.1:${server.address().port}/fork.tgz`,
                  integrity: "sha512-" + Buffer.alloc(64).toString("base64"),
                },
                sandcastleRuntime: {
                  schemaVersion: 1,
                  source: "https://github.com/hanhnghh/sandcastle",
                  commit: "a".repeat(40),
                  version,
                },
              },
            ]),
          ),
        }),
      );
    };
    if (delay) setTimeout(respond, delay);
    else respond();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const config = {
    schemaVersion: 1,
    package: "@test/fork",
    registry: `http://127.0.0.1:${server.address().port}`,
    channel: "latest",
    manifest: ".sandcastle/package.json",
    dependency: "@ai-hero/sandcastle",
    source: { kind: "registry" },
  };
  await writeFile(
    join(cwd, ".sandcastle/updates.json"),
    JSON.stringify(config),
  );
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(cwd, { recursive: true, force: true });
  });
  return {
    cwd,
    config,
    requests,
    tarballs,
    packages,
    setMode: (value) => {
      mode = value;
    },
    setDelay: (value) => {
      delay = value;
    },
    setFork: (value) => {
      forkMetadata = value;
    },
    failTarball: (value) => {
      tarballFailure = value;
    },
  };
}
test("CLI dry-run resolves only configured fork and selected version without installing", async (t) => {
  const f = await fixture(t);
  const { stdout } = await exec(process.execPath, [
    cliPath,
    "updates",
    "--cwd",
    f.cwd,
    "--dry-run",
  ]);
  const plan = JSON.parse(stdout);
  assert.equal(plan.target.version, "0.13.2");
  assert.equal(plan.target.package, "@test/fork");
  assert.equal(plan.target.changelog, "Fork changelog 0.13.2");
  assert.equal(plan.installed, null);
  assert.ok(f.requests.every((url) => !url.includes("ai-hero")));
  const selected = JSON.parse(
    (
      await exec(process.execPath, [
        cliPath,
        "updates",
        "--cwd",
        f.cwd,
        "--version",
        "~0.13.1",
        "--dry-run",
      ])
    ).stdout,
  );
  assert.equal(selected.target.version, "0.13.2");
  assert.equal(
    (await cli(f, "--version", "0.13.*", "--dry-run")).target.version,
    "0.13.2",
  );
  await assert.rejects(readFile(join(f.cwd, ".sandcastle/package.json")), {
    code: "ENOENT",
  });
});

test("explicit fork registry wins over npm scope mappings for CLI preview and installation", async (t) => {
  const f = await fixture(t),
    other = await fixture(t);
  const version = "0.13.0-fork.registry";
  await registryReleases(f, [version]);
  await writeFile(
    join(f.cwd, ".npmrc"),
    `@test:registry=${other.config.registry}\n`,
  );
  assert.equal((await cli(f, "--dry-run")).target.version, version);
  assert.equal((await cli(f, "--install")).installed.version, version);
  assert.deepEqual(other.requests, []);
  assert.equal(
    (await cli(f, "--dry-run")).installed.archive,
    f.config.registry + "/fork-" + version + ".tgz",
  );
});

test("CLI rejects malformed installed runtime evidence instead of advertising it in a plan", async (t) => {
  const f = await fixture(t);
  await registryReleases(f, ["0.13.0-fork.evidence"]);
  await cli(f, "--install");
  const path = join(
    f.cwd,
    ".sandcastle/node_modules/@ai-hero/sandcastle/package.json",
  );
  const manifest = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...manifest, name: null }));
  await assert.rejects(cli(f, "--dry-run"), (error) =>
    error.stdout.includes("Invalid installed runtime metadata"),
  );
});

test("uniquely versioned candidate packs required runtime assets and installs into an isolated consumer with verified version", async (t) => {
  const f = await fixture(t);
  const out = join(f.cwd, "release");
  const { stdout } = await exec(process.execPath, [
    resolve("scripts/pack-fork.mjs"),
    "--name",
    "@test/fork",
    "--out",
    out,
    "--version",
    "0.13.0-fork.20261012.1",
  ]);
  const release = JSON.parse(stdout);
  assert.match(release.integrity, /^sha512-/);
  assert.equal(
    release.integrity,
    "sha512-" +
      createHash("sha512")
        .update(await readFile(release.archive))
        .digest("base64"),
  );
  assert.equal(
    release.source.commit,
    (await exec("git", ["rev-parse", "HEAD"])).stdout.trim(),
  );
  assert.equal(release.source.source, "https://github.com/hanhnghh/sandcastle");
  await assert.rejects(
    exec(process.execPath, [
      resolve("scripts/pack-fork.mjs"),
      "--name",
      "@test/fork",
      "--out",
      out,
      "--version",
      "0.13.0-fork.20261012.1",
    ]),
    (error) => error.stderr.includes("Candidate version already exists"),
  );
  const config = {
    ...f.config,
    source: { kind: "archive", path: release.archive },
  };
  await writeFile(
    join(f.cwd, ".sandcastle/updates.json"),
    JSON.stringify(config),
  );
  const result = JSON.parse(
    (
      await exec(process.execPath, [
        cliPath,
        "updates",
        "--cwd",
        f.cwd,
        "--install",
      ])
    ).stdout,
  );
  assert.equal(result.installed.version, "0.13.0-fork.20261012.1");
  const manifest = JSON.parse(
    await readFile(join(f.cwd, ".sandcastle/package.json"), "utf8"),
  );
  assert.equal(
    manifest.devDependencies["@ai-hero/sandcastle"],
    "file:" + release.archive,
  );
  await exec(
    "npm",
    [
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry",
      f.config.registry,
    ],
    {
      cwd: join(f.cwd, ".sandcastle"),
      env: { ...process.env, npm_config_cache: join(f.cwd, "ci-cache") },
    },
  );
  const installed = join(f.cwd, ".sandcastle/node_modules/@ai-hero/sandcastle");
  assert.equal(
    JSON.parse(await readFile(join(installed, "package.json"), "utf8")).name,
    "@test/fork",
  );
  assert.ok(
    (await readFile(join(installed, "LICENSE"), "utf8")).includes("MIT"),
  );
  await readFile(
    join(
      installed,
      "dist/templates/parallel-planner-with-review/implement-prompt.md",
    ),
  );
  const version = (
    await exec(process.execPath, [join(installed, "dist/main.js"), "--version"])
  ).stdout;
  assert.ok(version.includes("0.13.0-fork.20261012.1"));
  assert.equal(
    JSON.parse(
      (
        await exec(process.execPath, [
          cliPath,
          "updates",
          "--cwd",
          f.cwd,
          "--dry-run",
        ])
      ).stdout,
    ).pinned,
    true,
  );
  await assert.rejects(
    exec(process.execPath, [
      cliPath,
      "updates",
      "--cwd",
      f.cwd,
      "--version",
      "latest",
      "--dry-run",
    ]),
  );
});

import { chromium } from "playwright";
import {
  startOperator,
  createAgentMap,
  withWorkflowRecovery,
} from "../dist/index.js";
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
});
async function operator(t, f, run = async () => {}) {
  const server = await startOperator({
    cwd: f.cwd,
    port: 0,
    adapter: {
      promptFiles: {
        planner: null,
        implementer: null,
        reviewer: null,
        merger: null,
        readiness: null,
      },
      sandboxIdentity: async () => "fake",
      run,
    },
  });
  t.after(() => server.close());
  return server;
}
test("Updates browser displays fork plan and changelog with keyboard selected-version preview", async (t) => {
  const f = await fixture(t),
    server = await operator(t, f),
    context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(server.url);
  await page.getByRole("link", { name: "Updates", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector("#update-plan")?.textContent.includes("0.13.2"),
  );
  assert.ok(
    (await page.locator("#update-plan").innerText()).includes("@test/fork"),
  );
  assert.ok(
    (await page.locator("#update-plan").innerText()).includes("sha512-"),
  );
  assert.ok(
    (await page.locator("#update-plan").innerText()).includes(
      "Fork changelog 0.13.2",
    ),
  );
  await page.getByLabel("Runtime version or constraint").fill("0.13.1");
  await page.getByRole("button", { name: "Preview runtime update" }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document
      .querySelector("#update-plan")
      ?.textContent.includes("Fork changelog 0.13.1"),
  );
  await assert.rejects(readFile(join(f.cwd, ".sandcastle/package.json")), {
    code: "ENOENT",
  });
});

async function release(f, version) {
  return JSON.parse(
    (
      await exec(
        process.execPath,
        [
          resolve("scripts/pack-fork.mjs"),
          "--name",
          "@test/fork",
          "--out",
          join(f.cwd, "release"),
          "--version",
          version,
        ],
        {
          env: {
            ...process.env,
            npm_config_cache: join(f.cwd, "packing-cache"),
          },
        },
      )
    ).stdout,
  );
}
async function registryReleases(f, versions) {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const releases = [];
  const records = {};
  for (const version of versions) {
    const packed = await release(f, version);
    releases.push(packed);
    const route = "/fork-" + version + ".tgz";
    f.tarballs.set(route, await readFile(packed.archive));
    records[version] = {
      ...pkg,
      name: "@test/fork",
      version,
      scripts: {},
      sandcastleRuntime: packed.source,
      sandcastleChangelog: "Release notes " + version,
      dist: { tarball: f.config.registry + route, integrity: packed.integrity },
    };
  }
  f.setFork({
    name: "@test/fork",
    "dist-tags": { latest: versions.at(-1), beta: versions[0] },
    versions: records,
  });
  return releases;
}
async function cli(f, ...args) {
  return JSON.parse(
    (
      await exec(
        process.execPath,
        [cliPath, "updates", "--cwd", f.cwd, ...args],
        { env: { ...process.env, npm_config_cache: join(f.cwd, "npm-cache") } },
      )
    ).stdout,
  );
}

test("real registry root dependency installs selected fork, updates manifest and lock together and rolls back while preserving customization", async (t) => {
  const f = await fixture(t),
    versions = ["0.13.0-fork.1", "0.13.0-fork.2"];
  const releases = await registryReleases(f, versions);
  const config = { ...f.config, manifest: "package.json" };
  await writeFile(
    join(f.cwd, ".sandcastle/updates.json"),
    JSON.stringify(config),
  );
  await writeFile(
    join(f.cwd, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: {
        "@ai-hero/sandcastle": "npm:@test/fork@" + versions[0],
        sisteransi: "1.0.5",
      },
    }),
  );
  await writeFile(
    join(f.cwd, ".sandcastle/main.ts"),
    "custom workflow, do not rewrite",
  );
  await writeFile(
    join(f.cwd, ".sandcastle/implement-prompt.md"),
    "custom prompt",
  );
  assert.equal(
    (await cli(f, "--version", versions[0], "--install")).installed.version,
    versions[0],
  );
  const beforeManifest = await readFile(join(f.cwd, "package.json"), "utf8"),
    beforeLock = await readFile(join(f.cwd, "package-lock.json"), "utf8");
  assert.equal(
    (await cli(f, "--version", versions[0], "--dry-run")).action,
    "current",
  );
  const plan = await cli(f, "--dry-run");
  assert.equal(plan.target.version, versions[1]);
  assert.equal(plan.installed.version, versions[0]);
  assert.equal(plan.installed.integrity, releases[0].integrity);
  assert.deepEqual(plan.installed.provenance, releases[0].source);
  assert.equal(
    plan.installed.archive,
    f.config.registry + "/fork-" + versions[0] + ".tgz",
  );
  assert.equal((await cli(f, "--install")).installed.version, versions[1]);
  const manifest = JSON.parse(
      await readFile(join(f.cwd, "package.json"), "utf8"),
    ),
    lock = JSON.parse(await readFile(join(f.cwd, "package-lock.json"), "utf8"));
  assert.equal(
    manifest.dependencies["@ai-hero/sandcastle"],
    "npm:@test/fork@" + versions[1],
  );
  assert.equal(manifest.dependencies.sisteransi, "1.0.5");
  assert.equal(
    lock.packages["node_modules/@ai-hero/sandcastle"].version,
    versions[1],
  );
  assert.match(
    lock.packages["node_modules/@ai-hero/sandcastle"].integrity,
    /^sha512-/,
  );
  assert.equal(
    await readFile(join(f.cwd, ".sandcastle/main.ts"), "utf8"),
    "custom workflow, do not rewrite",
  );
  assert.equal(
    await readFile(join(f.cwd, ".sandcastle/implement-prompt.md"), "utf8"),
    "custom prompt",
  );
  await assert.rejects(readFile(join(f.cwd, ".sandcastle/package.json")), {
    code: "ENOENT",
  });
  await cli(f, "--rollback");
  assert.equal(
    await readFile(join(f.cwd, "package.json"), "utf8"),
    beforeManifest,
  );
  assert.equal(
    await readFile(join(f.cwd, "package-lock.json"), "utf8"),
    beforeLock,
  );
  assert.equal((await cli(f, "--dry-run")).installed.version, versions[0]);
});

test("configured fork channel, missing fork and missing authentication never fall back upstream or change consumer files", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.cwd, ".sandcastle/updates.json"),
    JSON.stringify({ ...f.config, channel: "beta" }),
  );
  assert.equal((await cli(f, "--dry-run")).target.version, "0.14.0-beta.1");
  await writeFile(
    join(f.cwd, ".sandcastle/updates.json"),
    JSON.stringify({ ...f.config, channel: "release_candidate" }),
  );
  assert.equal((await cli(f, "--dry-run")).target.version, "0.14.0-beta.1");
  assert.equal(
    (await cli(f, "--version", "release_candidate", "--dry-run")).target
      .version,
    "0.14.0-beta.1",
  );
  for (const mode of ["missing", "auth"]) {
    f.setMode(mode);
    await assert.rejects(
      cli(f, "--install"),
      (error) =>
        error.code === 1 &&
        error.stdout.includes("authentication") &&
        !error.stdout.includes("registry-token-value"),
    );
    await assert.rejects(readFile(join(f.cwd, ".sandcastle/package.json")), {
      code: "ENOENT",
    });
  }
  assert.ok(f.requests.every((url) => !url.includes("ai-hero")));
});

test("failed download and npm dependency installation preserve installed runtime and recoverable records", async (t) => {
  const f = await fixture(t),
    versions = ["0.13.0-fork.failure1", "0.13.0-fork.failure2"];
  await registryReleases(f, versions);
  await cli(f, "--install", "--version", versions[0]);
  const beforeManifest = await readFile(
      join(f.cwd, ".sandcastle/package.json"),
      "utf8",
    ),
    beforeLock = await readFile(
      join(f.cwd, ".sandcastle/package-lock.json"),
      "utf8",
    );
  f.failTarball(true);
  await assert.rejects(cli(f, "--install"), (error) =>
    error.stdout.includes("npm runtime operation failed"),
  );
  f.failTarball(false);
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const packed = JSON.parse(
    await readFile(
      join(f.cwd, "release", "test-fork-" + versions[1] + ".tgz.json"),
      "utf8",
    ),
  );
  f.setFork({
    name: "@test/fork",
    "dist-tags": { latest: versions[1] },
    versions: {
      [versions[1]]: {
        ...pkg,
        name: "@test/fork",
        version: versions[1],
        dependencies: { "missing-runtime-dependency": "1.0.0" },
        sandcastleRuntime: packed.source,
        dist: {
          tarball: f.config.registry + "/fork-" + versions[1] + ".tgz",
          integrity: packed.integrity,
        },
      },
    },
  });
  await assert.rejects(cli(f, "--install"), (error) =>
    error.stdout.includes("npm runtime operation failed"),
  );
  assert.equal(
    await readFile(join(f.cwd, ".sandcastle/package.json"), "utf8"),
    beforeManifest,
  );
  assert.equal(
    await readFile(join(f.cwd, ".sandcastle/package-lock.json"), "utf8"),
    beforeLock,
  );
  const journal = JSON.parse(
    await readFile(join(f.cwd, ".sandcastle/updates/latest.json"), "utf8"),
  );
  assert.equal(journal.status, "failed");
  assert.equal(journal.previous.version, versions[0]);
  assert.equal(
    JSON.parse(
      await readFile(
        join(
          f.cwd,
          ".sandcastle/node_modules/@ai-hero/sandcastle/package.json",
        ),
        "utf8",
      ),
    ).version,
    versions[0],
  );
  await cli(f, "--rollback");
  await assert.rejects(readFile(join(f.cwd, ".sandcastle/package.json")), {
    code: "ENOENT",
  });
});

test("installed exports/version verification rejects a bad archive without running lifecycle scripts or replacing the consumer", async (t) => {
  const f = await fixture(t),
    dir = join(f.cwd, "bad-package"),
    version = "0.13.0-fork.bad";
  await mkdir(join(dir, "dist/templates/parallel-planner-with-review"), {
    recursive: true,
  });
  const provenance = {
    schemaVersion: 1,
    source: "https://github.com/hanhnghh/sandcastle",
    commit: "b".repeat(40),
    version,
  };
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@test/fork",
      version,
      type: "module",
      exports: { ".": "./dist/index.js" },
      sandcastleRuntime: provenance,
      scripts: {
        install: `node -e "require('fs').writeFileSync('${join(f.cwd, "script-ran")}','unsafe')"`,
      },
    }),
  );
  for (const path of [
    "LICENSE",
    "dist/main.js",
    "dist/index.d.ts",
    "dist/templates/parallel-planner-with-review/implement-prompt.md",
  ])
    await writeFile(join(dir, path), "fixture");
  await writeFile(
    join(dir, "runtime-source.json"),
    JSON.stringify({
      version,
      commit: provenance.commit,
      source: provenance.source,
      schemaVersion: 1,
    }),
  );
  await writeFile(
    join(dir, "dist/index.js"),
    "export const runtimeVersion='wrong'; export const startOperator=()=>{}; export const openProjectRuntime=()=>{};export const planRuntimeUpdate=()=>{};export const installRuntimeUpdate=()=>{};",
  );
  const packed = JSON.parse(
    (
      await exec(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", f.cwd],
        { cwd: dir },
      )
    ).stdout,
  )[0];
  await writeFile(
    join(f.cwd, ".sandcastle/updates.json"),
    JSON.stringify({
      ...f.config,
      source: { kind: "archive", path: join(f.cwd, packed.filename) },
    }),
  );
  await assert.rejects(cli(f, "--install"), (error) =>
    error.stdout.includes("exports/version verification failed"),
  );
  await assert.rejects(readFile(join(f.cwd, "script-ran")), { code: "ENOENT" });
  await assert.rejects(readFile(join(f.cwd, ".sandcastle/package.json")), {
    code: "ENOENT",
  });
  assert.equal(
    JSON.parse(
      await readFile(join(f.cwd, ".sandcastle/updates/latest.json"), "utf8"),
    ).status,
    "failed",
  );
});

test("browser asynchronous install and rollback report progress; heartbeat stays responsive; active runs and request overrides cannot bypass guards", async (t) => {
  const f = await fixture(t),
    version = "0.13.0-fork.browser";
  const oldCache = process.env.npm_config_cache;
  process.env.npm_config_cache = join(f.cwd, "browser-cache");
  t.after(() => {
    if (oldCache === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = oldCache;
  });
  const [packed] = await registryReleases(f, [version]);
  let releaseRun;
  const runDone = new Promise((r) => {
    releaseRun = r;
  });
  t.after(() => releaseRun());
  const server = await operator(t, f, () => runDone),
    context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(server.url);
  await page.waitForFunction(() =>
    document
      .querySelector("#update-plan")
      ?.textContent.includes("0.13.0-fork.browser"),
  );
  f.setDelay(500);
  await page.getByRole("button", { name: "Install/update runtime" }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document.querySelector("#update-job")?.textContent.includes("running"),
  );
  const heartbeat = await fetch(server.url + "/api/run", {
    signal: AbortSignal.timeout(1000),
  });
  assert.equal(heartbeat.status, 200);
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector("#feedback")
      ?.textContent.includes("runtime update is active"),
  );
  await page.waitForFunction(() =>
    document
      .querySelector("#update-job")
      ?.textContent.includes("Installation completed"),
  );
  assert.ok(
    (await page.locator("#update-job").innerText()).includes(
      "Verifying installed exports",
    ),
  );
  await page.waitForFunction(() =>
    document
      .querySelector("#update-plan")
      ?.textContent.includes("Installed: 0.13.0-fork.browser"),
  );
  assert.ok(
    (await page.locator("#update-plan").innerText()).includes(
      "Installed: " +
        version +
        " · " +
        f.config.registry +
        "/fork-" +
        version +
        ".tgz · " +
        packed.integrity +
        " · " +
        packed.source.source +
        "@" +
        packed.source.commit,
    ),
  );
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector("#run")?.textContent.includes("running"),
  );
  await page.getByRole("button", { name: "Install/update runtime" }).click();
  await page.waitForFunction(() =>
    document
      .querySelector("#update-job")
      ?.textContent.includes("Active project run"),
  );
  const override = await page.evaluate(async () => {
    const response = await fetch("/api/updates/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: null,
        revision: "a".repeat(64),
        force: true,
        cwd: "/tmp",
      }),
    });
    return response.status;
  });
  assert.equal(override, 400);
  const unauthorized = await fetch(server.url + "/api/updates/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(unauthorized.status, 403);
  const foreign = await fetch(server.url + "/api/updates/plan", {
    method: "POST",
    headers: {
      Origin: "https://foreign.example",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(foreign.status, 403);
  releaseRun();
  await page.waitForFunction(() =>
    document.querySelector("#run")?.textContent.includes("completed"),
  );
  await page.getByRole("button", { name: "Roll back runtime" }).click();
  await page.waitForFunction(() =>
    document
      .querySelector("#update-job")
      ?.textContent.includes("Rollback completed"),
  );
  await assert.rejects(readFile(join(f.cwd, ".sandcastle/package.json")), {
    code: "ENOENT",
  });
  const recording = await createAgentMap({
    cwd: f.cwd,
    name: "CLI active run",
  });
  try {
    await assert.rejects(cli(f, "--install"), (error) =>
      error.stdout.includes("Active or unreconciled project run"),
    );
  } finally {
    await recording.finish("completed");
  }
  const failedVersion = "0.13.0-fork.browser.failed-fetch." + Date.now();
  await registryReleases(f, [failedVersion]);
  await page.getByRole("button", { name: "Preview runtime update" }).click();
  await page.waitForFunction(
    (version) =>
      document
        .querySelector("#update-plan")
        ?.textContent.includes("Available: " + version),
    failedVersion,
  );
  f.failTarball(true);
  await page.getByRole("button", { name: "Install/update runtime" }).click();
  await page.waitForFunction(() =>
    document.querySelector("#update-job")?.textContent.includes("failed"),
  );
  assert.ok(
    (await page.locator("#update-job").innerText()).includes(
      "Original installation retained",
    ),
  );
});

test("consumer can plan and replace a declared legacy upstream archive with the explicit fork", async (t) => {
  const f = await fixture(t),
    version = "0.13.0-fork.legacy";
  await registryReleases(f, [version]);
  const legacy = join(f.cwd, "legacy");
  await mkdir(legacy);
  await cp("dist", join(legacy, "dist"), { recursive: true });
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  await writeFile(
    join(legacy, "package.json"),
    JSON.stringify({
      ...pkg,
      scripts: {},
      name: "@ai-hero/sandcastle",
      version,
    }),
  );
  const packed = JSON.parse(
    (
      await exec(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", f.cwd],
        { cwd: legacy },
      )
    ).stdout,
  )[0];
  await writeFile(
    join(f.cwd, "package.json"),
    JSON.stringify({
      private: true,
      devDependencies: {
        "@ai-hero/sandcastle": "file:" + join(f.cwd, packed.filename),
      },
    }),
  );
  await exec(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry",
      f.config.registry,
      "--fetch-retries=0",
    ],
    { cwd: f.cwd },
  );
  await writeFile(
    join(f.cwd, ".sandcastle/updates.json"),
    JSON.stringify({ ...f.config, manifest: "package.json" }),
  );
  const plan = await cli(f, "--dry-run");
  assert.equal(plan.installed.package, "@ai-hero/sandcastle");
  assert.equal(plan.installed.version, version);
  assert.equal(plan.installed.provenance, null);
  assert.equal(plan.target.package, "@test/fork");
  assert.equal(plan.action, "update");
  assert.equal((await cli(f, "--install")).installed.version, version);
  assert.equal((await cli(f, "--dry-run")).installed.package, "@test/fork");
});

test("CLI rejects active recovery-owned project runs even without an Agent Map recording", async (t) => {
  const f = await fixture(t);
  await exec("git", ["init", "-qb", "main"], { cwd: f.cwd });
  await exec(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "baseline",
    ],
    { cwd: f.cwd },
  );
  let started, finish;
  const ready = new Promise((r) => {
      started = r;
    }),
    done = new Promise((r) => {
      finish = r;
    });
  const run = withWorkflowRecovery(
    {
      cwd: f.cwd,
      targetBranch: "main",
      runId: "active",
      workflowVersion: "v1",
    },
    async () => {
      started();
      await done;
    },
  );
  await ready;
  try {
    await assert.rejects(cli(f, "--install"), (error) =>
      error.stdout.includes("Active or unreconciled project run"),
    );
  } finally {
    finish();
    await run;
  }
});

test("project run ownership protects against a second operator and CLI without relying on adapter recordings", async (t) => {
  const f = await fixture(t);
  let finish;
  const done = new Promise((r) => {
    finish = r;
  });
  const first = await operator(t, f, () => done),
    second = await operator(t, f);
  async function session(server) {
    const response = await fetch(server.url);
    return {
      "Content-Type": "application/json",
      Origin: server.url,
      Cookie: response.headers.get("set-cookie").split(";")[0],
    };
  }
  const headers = await session(first);
  try {
    const run = await fetch(first.url + "/api/run", {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(run.status, 202);
    await assert.rejects(cli(f, "--install"), (error) =>
      /Active|locked/.test(error.stdout),
    );
    const otherHeaders = await session(second);
    const otherRun = await fetch(second.url + "/api/run", {
      method: "POST",
      headers: otherHeaders,
      body: "{}",
    });
    assert.equal(otherRun.status, 409);
  } finally {
    finish();
    await new Promise((r) => setTimeout(r, 50));
  }
});

test("reviewed browser revision rejects changed manifests and candidate identity; selected project never writes to another consumer", async (t) => {
  const f = await fixture(t),
    other = await fixture(t),
    server = await operator(t, f);
  const response = await fetch(server.url),
    headers = {
      "Content-Type": "application/json",
      Origin: server.url,
      Cookie: response.headers.get("set-cookie").split(";")[0],
    };
  const plan = await (await fetch(server.url + "/api/updates")).json();
  const invalidRevision = await fetch(server.url + "/api/updates/install", {
    method: "POST",
    headers,
    body: JSON.stringify({ version: null, revision: [plan.revision] }),
  });
  assert.equal(invalidRevision.status, 400);
  await writeFile(
    join(f.cwd, ".sandcastle/package.json"),
    JSON.stringify({ private: true, description: "Host edited after preview" }),
  );
  const started = await fetch(server.url + "/api/updates/install", {
    method: "POST",
    headers,
    body: JSON.stringify({ version: null, revision: plan.revision }),
  });
  assert.equal(started.status, 202);
  let job;
  for (let attempt = 0; attempt < 100; attempt++) {
    job = (await (await fetch(server.url + "/api/updates/job")).json()).job;
    if (job.status !== "running") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(job.status, "failed");
  assert.ok(job.error.includes("plan changed"));
  assert.equal(
    JSON.parse(await readFile(join(f.cwd, ".sandcastle/package.json"), "utf8"))
      .description,
    "Host edited after preview",
  );
  await assert.rejects(readFile(join(other.cwd, ".sandcastle/package.json")), {
    code: "ENOENT",
  });
  f.setFork({
    name: "@test/fork",
    "dist-tags": { latest: "0.13.2" },
    versions: {
      "0.13.2": {
        name: "@ai-hero/sandcastle",
        version: "0.13.2",
        dist: {
          tarball: f.config.registry + "/upstream.tgz",
          integrity: "sha512-" + Buffer.alloc(64).toString("base64"),
        },
        sandcastleRuntime: {
          schemaVersion: 1,
          source: "https://github.com/mattpocock/sandcastle",
          commit: "a".repeat(40),
          version: "0.13.2",
        },
      },
    },
  });
  await assert.rejects(cli(f, "--dry-run"), (error) =>
    error.stdout.includes("match the configured fork"),
  );
  assert.ok(f.requests.every((url) => !url.includes("upstream.tgz")));
  await writeFile(
    join(f.cwd, ".sandcastle/updates.json"),
    JSON.stringify({ ...f.config, manifest: "package.json" }),
  );
  await writeFile(
    join(f.cwd, "package.json"),
    JSON.stringify({ private: true }),
  );
  await assert.rejects(cli(f, "--dry-run"), (error) =>
    error.stdout.includes("declared runtime dependency"),
  );
});

test("staged installation preserves host edits made after preview and keeps private evidence out of consumer Git status", async (t) => {
  const f = await fixture(t);
  await registryReleases(f, ["0.13.0-fork.concurrent"]);
  await exec("git", ["init", "-qb", "main"], { cwd: f.cwd });
  await writeFile(
    join(f.cwd, ".sandcastle/updates.json"),
    JSON.stringify({ ...f.config, manifest: "package.json" }),
  );
  const path = join(f.cwd, "package.json"),
    initial = {
      private: true,
      devDependencies: {
        "@ai-hero/sandcastle": "npm:@test/fork@0.13.0-fork.concurrent",
      },
    },
    edited = { ...initial, description: "Host edit while npm was staging" };
  await writeFile(path, JSON.stringify(initial));
  const { installRuntimeUpdate } = await import("../dist/index.js");
  await assert.rejects(
    installRuntimeUpdate({
      cwd: f.cwd,
      version: null,
      expectedRevision: null,
      onProgress: (phase) => {
        if (phase.startsWith("Installing in"))
          writeFileSync(path, JSON.stringify(edited));
      },
    }),
    /manifest.*changed/i,
  );
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), edited);
  await assert.rejects(readFile(join(f.cwd, "package-lock.json")), {
    code: "ENOENT",
  });
  await exec("git", ["check-ignore", ".sandcastle/updates/latest.json"], {
    cwd: f.cwd,
  });
});
