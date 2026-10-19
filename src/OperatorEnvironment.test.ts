import { afterEach, describe, expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  chmod,
  rm,
  access,
  readFile,
  symlink,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadEnvironmentConfig,
  saveEnvironmentConfig,
  type EnvironmentConfig,
  type EnvironmentPolicy,
} from "./OperatorEnvironment.js";
import { startOperator } from "./OperatorServer.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(environment?: EnvironmentPolicy) {
  const cwd = await mkdtemp(join(tmpdir(), "environment-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".sandcastle"));
  await writeFile(join(cwd, ".sandcastle/Dockerfile"), "FROM fixture");
  const server = await startOperator({
    cwd,
    port: 0,
    adapter: {
      environment,
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
  cleanup.push(() => server.close());
  const cookie = (await fetch(server.url)).headers
    .get("set-cookie")!
    .split(";")[0]!;
  const headers = {
    cookie,
    origin: server.url,
    "content-type": "application/json",
  };
  return {
    cwd,
    server,
    headers,
    request: (path: string, method = "GET", body?: unknown) =>
      fetch(server.url + path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
  };
}

// These HTTP/container contracts spawn native processes; use a bounded integration budget.
describe("operator Docker environment", { timeout: 30_000 }, () => {
  test("environment selection persists and isolates projects", async () => {
    const first = await fixture();
    const second = await fixture();
    const response = await first.request("/api/environment");
    expect(response.status).toBe(200);
    const original = ((await response.json()) as { config: EnvironmentConfig })
      .config;
    const selected = { ...original, image: "registry.example/project:custom" };
    expect(
      (await first.request("/api/environment", "PUT", selected)).status,
    ).toBe(200);
    expect(
      (
        (await (await first.request("/api/environment")).json()) as {
          config: EnvironmentConfig;
        }
      ).config,
    ).toEqual(selected);
    expect(
      (
        (await (await second.request("/api/environment")).json()) as {
          config: EnvironmentConfig;
        }
      ).config.image,
    ).not.toBe(selected.image);
  });

  test("invalid environment settings preserve configuration", async () => {
    const { request, cwd } = await fixture();
    const original = (
      (await (await request("/api/environment")).json()) as {
        config: EnvironmentConfig;
      }
    ).config;
    const outside = cwd + "-outside-Dockerfile";
    await writeFile(outside, "private", { flag: "wx" });
    cleanup.push(() => rm(outside, { force: true }));
    await symlink(outside, join(cwd, "escape"));
    for (const change of [
      { image: "invalid::tag" },
      { image: "--privileged" },
      { image: "$(touch unsafe)" },
      { image: "image; echo secret" },
      { dockerfile: "../outside-Dockerfile" },
      { dockerfile: "/etc/passwd" },
      { dockerfile: "escape" },
      { dockerfile: ".sandcastle" },
      { dockerfile: "missing" },
      { dockerfile: "Dockerfile\\other" },
      { buildArgs: { "--secret": "value" } },
      { buildArgs: { ARG: "$(touch unsafe)" } },
      { buildArgs: { ARG: "x\ny" } },
      { command: "echo unsafe" },
      { auth: "secret" },
      { schemaVersion: 2 },
    ]) {
      expect(
        (await request("/api/environment", "PUT", { ...original, ...change }))
          .status,
      ).toBe(400);
      expect(
        (
          (await (await request("/api/environment")).json()) as {
            config: EnvironmentConfig;
          }
        ).config,
      ).toEqual(original);
    }
  });

  async function dockerFixture(environment?: EnvironmentPolicy) {
    const fixtureData = await fixture(environment);
    const { cwd } = fixtureData;
    const bin = join(cwd, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "docker"),
      `#!/usr/bin/env node
const fs = require('node:fs'); const args = process.argv.slice(2);
fs.appendFileSync('docker-calls.jsonl',JSON.stringify(args)+'\\n');
if(fs.existsSync('ignore-term')) process.on('SIGTERM',()=>{});
const identity = 'sha256:'+'a'.repeat(64);
if (args[0]==='image' && args[1]==='ls') console.log('fixture:installed');
else if (args[0]==='image' && args[1]==='inspect') {
 if(fs.existsSync('fail-image')) process.exit(1);
 if(args[2].startsWith('sandcastle-operator-build:')) {if(!fs.existsSync('staged-image')) process.exit(1);console.log('sha256:'+'b'.repeat(64));}
 else console.log(fs.existsSync('selected-identity') ? fs.readFileSync('selected-identity','utf8') : identity);
}
else if (args[0]==='image' && args[1]==='rm') {fs.rmSync('staged-image',{force:true});}
else if (args[0]==='info' && fs.existsSync('fail-daemon')) process.exit(1);
else if (args[0]==='run' && fs.existsSync('hold-preflight')) {setInterval(()=>{},1000);}
else if (args[0]==='run') {
 if(fs.existsSync('fail-tool') && args.includes('npm')) {console.error('credential-should-not-appear');process.exit(1);}
 if(args.includes('id')) console.log(fs.existsSync('wrong-uid') ? '99999' : String(process.getuid()));
 else console.log('credential-should-not-appear');
}
else if (args[0]==='tag') {
 const commit=()=>fs.writeFileSync('selected-identity',args[1]);
 if(fs.existsSync('hold-tag')) {fs.writeFileSync('tag-started','true');const timer=setInterval(()=>{if(fs.existsSync('release-tag')) {clearInterval(timer);commit();process.exit(0);}},20);}
 else commit();
}
else if (args[0]==='build') {
 console.log('live build output');
 if(fs.existsSync('partial-progress')) process.stdout.write('progress without newline');
 if(fs.existsSync('held-secret')) {process.stdout.write('credential-');process.stderr.write('stderr progress without newline');const secretTimer=setInterval(()=>{if(fs.existsSync('release-secret')) {clearInterval(secretTimer);process.stdout.write('should-not-appear');}},20);}
 if(fs.existsSync('split-secret')) {process.stdout.write('credential-');setTimeout(()=>process.stdout.write('should-not-appear\\n'),30);}
 const timer=setInterval(()=>{if(fs.existsSync('finish-build')) {clearInterval(timer); if(fs.readFileSync('finish-build','utf8')==='fail') process.exit(1); fs.writeFileSync('staged-image','built'); process.exit(0);}},20);
}
`,
    );
    await chmod(join(bin, "docker"), 0o755);
    const previous = process.env.PATH;
    process.env.PATH = bin + ":" + previous;
    cleanup.splice(cleanup.length - 1, 0, async () => {
      process.env.PATH = previous;
    });
    return fixtureData;
  }
  async function jobState(
    request: Awaited<ReturnType<typeof fixture>>["request"],
    id: string,
  ) {
    return (await (await request("/api/environment/jobs/" + id)).json()) as {
      id: string;
      status: string;
      logs: string;
      identity?: string;
    };
  }
  async function terminal(
    request: Awaited<ReturnType<typeof fixture>>["request"],
    id: string,
  ) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const state = await jobState(request, id);
      if (["completed", "failed", "cancelled"].includes(state.status))
        return state;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("job never settled");
  }
  test("build streams before completion and preserves the usable image on failure and cancellation", async () => {
    const { request, cwd, server } = await dockerFixture();
    const initial = (await (await request("/api/environment")).json()) as {
      config: EnvironmentConfig;
      images: string[];
      available: boolean;
      identity: string;
    };
    expect(initial.images).toContain("fixture:installed");
    expect(initial.available).toBe(true);
    await writeFile(join(cwd, "docker-calls.jsonl"), "");
    expect(
      (await request("/api/environment", "PUT", initial.config)).status,
    ).toBe(200);
    expect(await readFile(join(cwd, "docker-calls.jsonl"), "utf8")).toBe("");
    for (const outcome of ["completed", "failed", "cancelled"]) {
      await rm(join(cwd, "finish-build"), { force: true });
      const response = await request("/api/environment/jobs", "POST", {
        kind: "build",
      });
      expect(response.status).toBe(202);
      const { id } = (await response.json()) as { id: string };
      expect(
        (await request("/api/environment/jobs", "POST", { kind: "build" }))
          .status,
      ).toBe(409);
      const stream = await fetch(
        server.url + "/api/environment/jobs/" + id + "/events",
      );
      const reader = stream.body!.getReader();
      let text = "";
      while (!text.includes("live build output")) {
        const chunk = await reader.read();
        if (chunk.done)
          throw new Error("Build stream ended before live output");
        text += new TextDecoder().decode(chunk.value);
      }
      expect((await jobState(request, id)).status).toBe("running");
      if (outcome === "cancelled")
        expect(
          (await request("/api/environment/jobs/" + id + "/cancel", "POST", {}))
            .status,
        ).toBe(202);
      else
        await writeFile(
          join(cwd, "finish-build"),
          outcome === "failed" ? "fail" : "success",
        );
      const result = await terminal(request, id);
      expect(result.status).toBe(outcome);
      if (outcome === "completed")
        expect(result.identity).toBe("sha256:" + "b".repeat(64));
      if (outcome === "cancelled")
        expect((result as { error?: string }).error).not.toContain("failed");
      while (!text.includes('"status":"' + outcome + '"')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
      expect(text).toContain('"status":"' + outcome + '"');
      await reader.cancel();
      expect(
        (
          (await (await request("/api/environment")).json()) as {
            config: EnvironmentConfig;
            identity: string;
          }
        ).config,
      ).toEqual(initial.config);
      expect(
        (
          (await (await request("/api/environment")).json()) as {
            identity: string;
          }
        ).identity,
      ).toBe("sha256:" + "b".repeat(64));
    }
    const calls = (await readFile(join(cwd, "docker-calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.filter((args) => args[0] === "tag")).toHaveLength(1);
    expect(
      calls
        .filter((args) => args[0] === "build")
        .every((args) => args[args.indexOf("-t") + 1] !== initial.config.image),
    ).toBe(true);
    expect(
      calls.some((args) => ["push", "system", "prune"].includes(args[0]!)),
    ).toBe(false);
  });

  test.each([
    { scenario: "ready", failure: null, diagnostic: "" },
    {
      scenario: "missing tool",
      failure: "fail-tool",
      diagnostic: "Tool npm: failed",
    },
    {
      scenario: "UID mismatch",
      failure: "wrong-uid",
      diagnostic: "UID: failed",
    },
    {
      scenario: "daemon unavailable",
      failure: "fail-daemon",
      diagnostic: "Daemon: failed",
    },
    {
      scenario: "image unavailable",
      failure: "fail-image",
      diagnostic: "Image: failed",
    },
  ])(
    "preflight reports daemon image UID tools and declared authentication without credentials: $scenario",
    async ({ failure, diagnostic }) => {
      const { request, cwd } = await dockerFixture();
      await writeFile(
        join(cwd, ".sandcastle/project.json"),
        JSON.stringify({
          schemaVersion: 1,
          projectType: "node",
          packageManager: "npm",
        }),
      );
      await mkdir(join(cwd, ".sandcastle/codex-home"));
      await writeFile(
        join(cwd, ".sandcastle/codex-home/auth.json"),
        "credential-should-not-appear",
      );
      await writeFile(
        join(cwd, ".sandcastle/.env"),
        "GH_TOKEN=credential-should-not-appear\n",
      );
      if (failure) await writeFile(join(cwd, failure), "true");
      const response = await request("/api/environment/jobs", "POST", {
        kind: "preflight",
      });
      expect(response.status).toBe(202);
      const { id } = (await response.json()) as { id: string };
      const result = await terminal(request, id);
      expect(result.status).toBe(failure ? "failed" : "completed");
      if (diagnostic) expect(result.logs).toContain(diagnostic);
      expect(result.logs).not.toContain("credential-should-not-appear");
      if (failure === "fail-image")
        expect(
          (
            (await (await request("/api/environment")).json()) as {
              available: boolean;
            }
          ).available,
        ).toBe(false);
      if (!failure) {
        const calls = (await readFile(join(cwd, "docker-calls.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[]);
        const probes = calls.filter((args) => args[0] === "run");
        expect(probes.length).toBeGreaterThan(0);
        for (const args of probes) {
          expect(args[args.indexOf("--network") + 1]).toBe("none");
          expect(args).not.toContain("-v");
          expect(args).not.toContain("--mount");
          expect(args).not.toContain("-e");
          const name = args[args.indexOf("--name") + 1]!;
          expect(calls).toContainEqual(["rm", "-f", name]);
        }
        for (const text of [
          "Daemon: ready",
          "Image: sha256:",
          "UID: matches",
          "Tool git: ready",
          "Tool gh: ready",
          "Tool codex: ready",
          "Tool node: ready",
          "Tool npm: ready",
          "Auth Codex: present",
          "Auth GH_TOKEN: present",
        ])
          expect(result.logs).toContain(text);
      }
    },
  );

  test("preflight reports missing declared Codex authentication without credentials", async () => {
    const { request, cwd } = await dockerFixture();
    await writeFile(
      join(cwd, ".sandcastle/project.json"),
      JSON.stringify({
        schemaVersion: 1,
        projectType: "node",
        packageManager: "npm",
      }),
    );
    await mkdir(join(cwd, ".sandcastle/codex-home"));
    await writeFile(
      join(cwd, ".sandcastle/codex-home/auth.json"),
      "credential-should-not-appear",
    );
    await writeFile(
      join(cwd, ".sandcastle/.env"),
      "GH_TOKEN=credential-should-not-appear\n",
    );
    await rm(join(cwd, ".sandcastle/codex-home/auth.json"));
    const response = await request("/api/environment/jobs", "POST", {
      kind: "preflight",
    });
    const { id } = (await response.json()) as { id: string };
    const result = await terminal(request, id);
    expect(result.status).toBe("failed");
    expect(result.logs).toContain("Auth Codex: missing");
  });

  test("build streams partial lines while the process is still running", async () => {
    const { request, cwd } = await dockerFixture();
    await writeFile(join(cwd, "partial-progress"), "true");
    const { id } = (await (
      await request("/api/environment/jobs", "POST", { kind: "build" })
    ).json()) as { id: string };
    await expect
      .poll(async () => (await jobState(request, id)).logs, { timeout: 3000 })
      .toContain("progress without newline");
    expect((await jobState(request, id)).status).toBe("running");
    await request("/api/environment/jobs/" + id + "/cancel", "POST", {});
    expect((await terminal(request, id)).status).toBe("cancelled");
  });

  test("build logs redact declared credentials across output chunks", async () => {
    const { request, cwd } = await dockerFixture();
    await writeFile(
      join(cwd, ".sandcastle/.env"),
      "GH_TOKEN=credential-should-not-appear\n",
    );
    await writeFile(join(cwd, "split-secret"), "true");
    const response = await request("/api/environment/jobs", "POST", {
      kind: "build",
    });
    const { id } = (await response.json()) as { id: string };
    const deadline = Date.now() + 20_000;
    while (true) {
      const streaming = await jobState(request, id);
      expect(streaming.logs).not.toContain("credential-should-not-appear");
      if (streaming.logs.includes("[redacted]")) break;
      if (Date.now() >= deadline)
        throw new Error("The complete split credential was not streamed");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await writeFile(join(cwd, "finish-build"), "success");
    const result = await terminal(request, id);
    expect(result.logs).toContain("[redacted]");
    expect(result.logs).not.toContain("credential-");
    expect(result.logs).not.toContain("should-not-appear");
  });

  test.each(["completed", "cancelled"])(
    "build redaction withholds a credential prefix while stderr continues streaming: %s",
    async (outcome) => {
      const { request, cwd } = await dockerFixture();
      await writeFile(
        join(cwd, ".sandcastle/.env"),
        "GH_TOKEN=credential-should-not-appear\n",
      );
      await writeFile(join(cwd, "held-secret"), "true");
      const { id } = (await (
        await request("/api/environment/jobs", "POST", { kind: "build" })
      ).json()) as { id: string };
      await expect
        .poll(async () => (await jobState(request, id)).logs)
        .toContain("stderr progress without newline");
      expect((await jobState(request, id)).logs).not.toContain("credential-");
      if (outcome === "completed") {
        await writeFile(join(cwd, "release-secret"), "true");
        await expect
          .poll(async () => (await jobState(request, id)).logs)
          .toContain("[redacted]");
        await writeFile(join(cwd, "finish-build"), "success");
      } else
        await request("/api/environment/jobs/" + id + "/cancel", "POST", {});
      const result = await terminal(request, id);
      expect(result.status).toBe(outcome);
      expect(result.logs).toContain("[redacted]");
      expect(result.logs).not.toContain("credential-");
      expect(result.logs).not.toContain("should-not-appear");
    },
  );

  test("closing the server cleans up a build snapshot while saved settings change", async () => {
    const { request, cwd, server } = await dockerFixture();
    const original = await loadEnvironmentConfig({ cwd });
    const { id } = (await (
      await request("/api/environment/jobs", "POST", { kind: "build" })
    ).json()) as { id: string };
    await expect
      .poll(async () => (await jobState(request, id)).logs)
      .toContain("live build output");
    const next = { ...original, image: "fixture:next" };
    expect((await request("/api/environment", "PUT", next)).status).toBe(200);
    const snapshot = (await (
      await request("/api/environment/jobs/" + id)
    ).json()) as { config: EnvironmentConfig };
    expect(snapshot.config).toEqual(original);
    await server.close();
    expect(await loadEnvironmentConfig({ cwd })).toEqual(next);
    const calls = (await readFile(join(cwd, "docker-calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.filter((args) => args[0] === "tag")).toEqual([]);
    expect(
      calls.filter((args) => args[0] === "image" && args[1] === "rm"),
    ).toEqual([["image", "rm", "sandcastle-operator-build:" + id]]);
  });

  test("cancellation settles even when the build process ignores termination", async () => {
    const { request, cwd } = await dockerFixture();
    await writeFile(join(cwd, "ignore-term"), "true");
    const response = await request("/api/environment/jobs", "POST", {
      kind: "build",
    });
    const { id } = (await response.json()) as { id: string };
    for (let i = 0; i < 100; i++) {
      if ((await jobState(request, id)).logs.includes("live build")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await request("/api/environment/jobs/" + id + "/cancel", "POST", {});
    expect((await terminal(request, id)).status).toBe("cancelled");
  });

  test("simultaneous environment requests admit only one active job", async () => {
    const { request } = await dockerFixture();
    const responses = await Promise.all([
      request("/api/environment/jobs", "POST", { kind: "build" }),
      request("/api/environment/jobs", "POST", { kind: "preflight" }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      202, 409,
    ]);
  });

  test("preflight fails when declared authentication is missing", async () => {
    const { request, cwd } = await dockerFixture();
    await mkdir(join(cwd, ".sandcastle/codex-home"));
    await writeFile(join(cwd, ".sandcastle/codex-home/auth.json"), "private");
    await writeFile(
      join(cwd, ".sandcastle/.env"),
      "SANDCASTLE_ISSUE4_TEST_TOKEN=\n",
    );
    const { id } = (await (
      await request("/api/environment/jobs", "POST", { kind: "preflight" })
    ).json()) as { id: string };
    const result = await terminal(request, id);
    expect(result.status).toBe("failed");
    expect(result.logs).toContain("Auth SANDCASTLE_ISSUE4_TEST_TOKEN: missing");
  });

  test("a build cannot report cancellation after image promotion starts", async () => {
    const { request, cwd } = await dockerFixture();
    await writeFile(join(cwd, "hold-tag"), "true");
    await writeFile(join(cwd, "finish-build"), "success");
    const { id } = (await (
      await request("/api/environment/jobs", "POST", { kind: "build" })
    ).json()) as { id: string };
    for (let i = 0; i < 100; i++) {
      try {
        await access(join(cwd, "tag-started"));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    const cancelled = await request(
      "/api/environment/jobs/" + id + "/cancel",
      "POST",
      {},
    );
    await writeFile(join(cwd, "release-tag"), "true");
    expect(cancelled.status).toBe(409);
    expect((await terminal(request, id)).status).toBe("completed");
  });

  test("preflight cancellation reports a terminal cancelled result", async () => {
    const { request, cwd } = await dockerFixture();
    await writeFile(join(cwd, "hold-preflight"), "true");
    const { id } = (await (
      await request("/api/environment/jobs", "POST", { kind: "preflight" })
    ).json()) as { id: string };
    for (let i = 0; i < 100; i++) {
      if ((await jobState(request, id)).logs.includes("Image:")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(
      (await request("/api/environment/jobs/" + id + "/cancel", "POST", {}))
        .status,
    ).toBe(202);
    expect((await terminal(request, id)).status).toBe("cancelled");
  });

  test("environment HTTP protects mutations and isolates project job IDs", async () => {
    const first = await dockerFixture();
    const second = await fixture();
    for (const path of ["/api/environment", "/api/environment/jobs"]) {
      for (const headers of [
        {},
        { origin: "https://evil.example" },
        { ...first.headers, origin: "https://evil.example" },
      ]) {
        expect(
          (
            await fetch(first.server.url + path, {
              method: path.endsWith("jobs") ? "POST" : "PUT",
              headers,
              body: "{}",
            })
          ).status,
        ).toBe(403);
      }
    }
    for (const body of [
      { kind: "build", command: "touch unsafe" },
      { kind: "preflight", cwd: second.cwd },
      { kind: "shell" },
      null,
      [],
    ])
      expect(
        (await first.request("/api/environment/jobs", "POST", body)).status,
      ).toBe(400);
    expect(
      (
        await first.request(
          "/api/environment?cwd=" + encodeURIComponent(second.cwd),
        )
      ).status,
    ).toBe(400);
    const { id } = (await (
      await first.request("/api/environment/jobs", "POST", { kind: "build" })
    ).json()) as { id: string };
    expect((await second.request("/api/environment/jobs/" + id)).status).toBe(
      404,
    );
    expect(
      (await second.request("/api/environment/jobs/" + id + "/events")).status,
    ).toBe(404);
    expect(
      (
        await second.request(
          "/api/environment/jobs/" + id + "/cancel",
          "POST",
          {},
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await first.request("/api/environment/jobs/" + id + "/cancel", "POST", {
          command: "unsafe",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(
          first.server.url + "/api/environment/jobs/" + id + "/cancel",
          {
            method: "POST",
            headers: {
              origin: first.server.url,
              "content-type": "application/json",
            },
            body: "{}",
          },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await first.request(
          "/api/environment/jobs/" + id + "/cancel",
          "POST",
          {},
        )
      ).status,
    ).toBe(202);
    expect((await terminal(first.request, id)).status).toBe("cancelled");
  });

  test("environment storage fails closed on corrupt documents and authentication symlinks", async () => {
    const { cwd, request } = await fixture();
    const path = join(cwd, ".sandcastle/environment.json");
    const config = await loadEnvironmentConfig({ cwd });
    await saveEnvironmentConfig({ cwd, config });
    if (process.platform !== "win32")
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    for (const content of [
      "{",
      JSON.stringify({ ...config, schemaVersion: 2 }),
      JSON.stringify({ ...config, command: "unsafe" }),
    ]) {
      await writeFile(path, content);
      expect((await request("/api/environment")).status).toBe(400);
      await expect(loadEnvironmentConfig({ cwd })).rejects.toThrow();
    }
    await rm(path);
    await symlink(join(cwd, "missing-auth"), path);
    expect((await request("/api/environment")).status).toBe(400);
  });

  test("invalid project preflight declarations produce a truthful failed job", async () => {
    const { request, cwd } = await dockerFixture();
    await writeFile(join(cwd, ".sandcastle/project.json"), "null");
    const response = await request("/api/environment/jobs", "POST", {
      kind: "preflight",
    });
    const { id } = (await response.json()) as { id: string };
    expect((await terminal(request, id)).status).toBe("failed");
  });

  test("preflight checks Android project tools without running project bootstrap", async () => {
    const { request, cwd } = await dockerFixture();
    await writeFile(
      join(cwd, ".sandcastle/project.json"),
      JSON.stringify({
        schemaVersion: 1,
        projectType: "android",
        buildTool: "gradle",
        bootstrap: { command: "touch must-not-run" },
      }),
    );
    await mkdir(join(cwd, ".sandcastle/codex-home"));
    await writeFile(join(cwd, ".sandcastle/codex-home/auth.json"), "private");
    const { id } = (await (
      await request("/api/environment/jobs", "POST", { kind: "preflight" })
    ).json()) as { id: string };
    const result = await terminal(request, id);
    expect(result.status).toBe("completed");
    expect(result.logs).toContain("Tool java: ready");
    expect(result.logs).toContain("Tool sdkmanager: ready");
    await expect(access(join(cwd, "must-not-run"))).rejects.toThrow();
  });

  test("trusted SDK preflight policy observes project tools UID and auth file presence", async () => {
    const { request, cwd } = await dockerFixture({
      uid: 99999,
      tools: ["project-tool"],
      authFiles: { Project: "project-auth.json" },
    });
    await writeFile(join(cwd, "wrong-uid"), "true");
    await writeFile(
      join(cwd, "project-auth.json"),
      "credential-should-not-appear",
    );
    const { id } = (await (
      await request("/api/environment/jobs", "POST", { kind: "preflight" })
    ).json()) as { id: string };
    const result = await terminal(request, id);
    expect(result.status).toBe("completed");
    expect(result.logs).toContain("UID: matches");
    expect(result.logs).toContain("Tool project-tool: ready");
    expect(result.logs).toContain("Auth Project: present");
    expect(result.logs).not.toContain("credential-should-not-appear");
  });

  test("preflight does not report an auth directory as a credential file", async () => {
    const { request, cwd } = await dockerFixture({
      uid: process.getuid?.() ?? 1000,
      tools: [],
      authFiles: { Project: "auth.json" },
    });
    await mkdir(join(cwd, "auth.json"));
    const { id } = (await (
      await request("/api/environment/jobs", "POST", { kind: "preflight" })
    ).json()) as { id: string };
    const result = await terminal(request, id);
    expect(result.status).toBe("failed");
    expect(result.logs).toContain("Auth Project: missing");
  });

  test("web builds align the image UID and GID with the host by default", async () => {
    const { request, cwd } = await dockerFixture();
    await writeFile(join(cwd, "finish-build"), "success");
    const response = await request("/api/environment/jobs", "POST", {
      kind: "build",
    });
    expect(response.status).toBe(202);
    const { id } = (await response.json()) as { id: string };
    expect((await terminal(request, id)).status).toBe("completed");
    const calls = (await readFile(join(cwd, "docker-calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const build = calls.find((args) => args[0] === "build")!;
    if (process.getuid)
      expect(build).toContain("AGENT_UID=" + process.getuid());
    if (process.getgid)
      expect(build).toContain("AGENT_GID=" + process.getgid());
  });

  test("build uses the saved project's Dockerfile and literal argument vector", async () => {
    const { request, cwd } = await dockerFixture();
    await mkdir(join(cwd, "docker"));
    await writeFile(join(cwd, "docker/Dockerfile.dev"), "FROM fixture");
    const config = {
      schemaVersion: 1,
      image: "fixture:custom-build",
      dockerfile: "docker/Dockerfile.dev",
      buildArgs: { AGENT_UID: "1000", AGENT_GID: "2000", VERSION: "1.2.3" },
    };
    expect((await request("/api/environment", "PUT", config)).status).toBe(200);
    await writeFile(join(cwd, "finish-build"), "success");
    const { id } = (await (
      await request("/api/environment/jobs", "POST", { kind: "build" })
    ).json()) as { id: string };
    expect((await terminal(request, id)).status).toBe("completed");
    const commands = (await readFile(join(cwd, "docker-calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const build = commands.find((args) => args[0] === "build")!;
    expect(build.slice(3)).toEqual([
      "-f",
      join(cwd, "docker/Dockerfile.dev"),
      "--build-arg",
      "AGENT_UID=1000",
      "--build-arg",
      "AGENT_GID=2000",
      "--build-arg",
      "VERSION=1.2.3",
      cwd,
    ]);
    expect(commands.find((args) => args[0] === "tag")).toEqual([
      "tag",
      "sha256:" + "b".repeat(64),
      "fixture:custom-build",
    ]);
  });
});
