import {
  chmod,
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  stat,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { loadRoleConfig, saveRoleConfig } from "./Operator.js";
import { startOperator } from "./OperatorServer.js";
import { createProjectRuntime, openProjectRuntime } from "./OperatorRuntime.js";
import { startDashboard } from "./AgentMap.js";

const directories: string[] = [];
async function project() {
  const cwd = await mkdtemp(join(tmpdir(), "operator-"));
  directories.push(cwd);
  return cwd;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((cwd) => rm(cwd, { recursive: true, force: true })),
  );
});

test("missing configuration defaults to all five Codex roles and saves custom models durably", async () => {
  const cwd = await project();
  const initial = await loadRoleConfig({ cwd });
  expect(Object.keys(initial.roles)).toEqual([
    "planner",
    "implementer",
    "reviewer",
    "merger",
    "readiness",
  ]);
  expect(Object.values(initial.roles).map((role) => role.effort)).toEqual([
    "low",
    "low",
    "high",
    "high",
    "high",
  ]);
  const roles = structuredClone(initial.roles);
  roles.implementer.model = "custom-model";
  roles.implementer.effort = "medium";
  const saved = await saveRoleConfig({ cwd, config: { ...initial, roles } });
  expect(await loadRoleConfig({ cwd })).toEqual(saved);
  expect(saved.revision).not.toEqual(initial.revision);
});

test("all role, schema, provider, effort and unsafe-field failures leave the saved revision intact", async () => {
  const cwd = await project();
  const original = await saveRoleConfig({
    cwd,
    config: await loadRoleConfig({ cwd }),
  });
  const invalid: unknown[] = [
    { ...original, schemaVersion: 3 },
    { ...original, auth: "secret" },
    { ...original, command: "touch /tmp/unsafe" },
  ];
  for (const role of Object.keys(
    original.roles,
  ) as (keyof typeof original.roles)[]) {
    const missing = structuredClone(original);
    delete (missing.roles as Partial<typeof missing.roles>)[role];
    invalid.push(missing);
    for (const change of [
      { provider: "claude-code" },
      { effort: "max" },
      { model: "" },
      { model: "$(touch /tmp/unsafe)" },
    ]) {
      invalid.push({
        ...original,
        roles: {
          ...original.roles,
          [role]: { ...original.roles[role], ...change },
        },
      });
    }
  }
  for (const config of invalid) {
    await expect(saveRoleConfig({ cwd, config })).rejects.toThrow();
    expect(await loadRoleConfig({ cwd })).toEqual(original);
  }
});

test("stored configuration fails closed on malformed JSON, unsupported source schema and tampered revision", async () => {
  const cwd = await project();
  await mkdir(join(cwd, ".sandcastle"));
  for (const text of [
    "{",
    JSON.stringify({ ...(await loadRoleConfig({ cwd })), schemaVersion: 0 }),
  ]) {
    await writeFile(join(cwd, ".sandcastle/roles.json"), text);
    await expect(loadRoleConfig({ cwd })).rejects.toThrow();
    await rm(join(cwd, ".sandcastle/roles.json"));
  }
  const config = await loadRoleConfig({ cwd });
  await writeFile(
    join(cwd, ".sandcastle/roles.json"),
    JSON.stringify({ ...config, revision: "forged" }),
  );
  await expect(loadRoleConfig({ cwd })).rejects.toThrow(/revision/);
});

test("runtime freezes revision, prompt templates and image identity while the next run uses saved role settings", async () => {
  const cwd = await project();
  const promptPath = join(cwd, "prompt.md");
  await writeFile(promptPath, "original {{TASK}}");
  const options = {
    cwd,
    sandboxIdentity: "sha256:test-image",
    promptFiles: {
      planner: promptPath,
      implementer: promptPath,
      reviewer: promptPath,
      merger: promptPath,
      readiness: promptPath,
    },
  };
  const active = await createProjectRuntime(options);
  const original = active.record.config;
  const changed = structuredClone(original);
  changed.roles.implementer.model = "fake-next";
  changed.roles.implementer.effort = "xhigh";
  await saveRoleConfig({ cwd, config: changed });
  await writeFile(promptPath, "changed prompt");
  // Observe the configured provider through its public command boundary.
  expect(
    active
      .agent("implementer")
      .buildPrintCommand({ prompt: "test", dangerouslySkipPermissions: true })
      .command,
  ).toContain("-m 'gpt-6.1-sol'");
  expect(
    active
      .agent("implementer")
      .buildPrintCommand({ prompt: "test", dangerouslySkipPermissions: true })
      .command,
  ).toContain('model_reasoning_effort="low"');
  expect(await readFile(active.promptFile("implementer"), "utf8")).toBe(
    "original {{TASK}}",
  );
  expect(active.record.sandboxIdentity).toBe("sha256:test-image");
  expect(active.record.prompts.implementer?.digest).toBe(
    "d9ddf95378ebd79ec72efe79473ace516ae0e1c1ca7c52fe4f337b809acfa304",
  );
  if (process.platform !== "win32") {
    const directory = join(cwd, ".sandcastle/runtime", active.record.id);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    for (const name of ["record.json", "implementer.md"])
      expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
  }
  expect(active.record.runtimeVersion).toMatch(/^0\./);
  expect(() => {
    active.record.config.roles.implementer.model = "tamper";
  }).toThrow();
  const next = await createProjectRuntime(options);
  expect(next.record.config.revision).not.toBe(original.revision);
  expect(next.record.id).not.toBe(active.record.id);
  expect(
    next
      .agent("implementer")
      .buildPrintCommand({ prompt: "test", dangerouslySkipPermissions: true })
      .command,
  ).toContain("-m 'fake-next'");
  expect(
    next
      .agent("implementer")
      .buildPrintCommand({ prompt: "test", dangerouslySkipPermissions: true })
      .command,
  ).toContain('model_reasoning_effort="xhigh"');
});

async function operator(
  cwd: string,
  run: Parameters<typeof startOperator>[0]["adapter"]["run"] = async () => {},
) {
  return startOperator({
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
      run,
    },
  });
}
async function session(url: string) {
  const response = await fetch(url);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}
test("operator HTTP requires a local session and exact origin/host and cannot partially save malformed requests", async () => {
  const cwd = await project();
  const server = await operator(cwd);
  try {
    const config = await loadRoleConfig({ cwd });
    await writeFile(join(cwd, ".env"), "GH_TOKEN=never-return-this-token");
    const cookie = await session(server.url);
    const good = {
      cookie,
      origin: server.url,
      "content-type": "application/json",
    };
    const url = server.url + "/api/config";
    for (const headers of [
      { origin: server.url, "content-type": "application/json" },
      { ...good, origin: "https://evil.example" },
      { cookie, "content-type": "application/json" },
      { ...good, cookie: "sandcastle-session=forged" },
    ]) {
      expect(
        (
          await fetch(url, {
            method: "PUT",
            headers,
            body: JSON.stringify(config),
          })
        ).status,
      ).toBe(403);
    }
    const wrongHost = await new Promise<number>((resolve) => {
      const request = httpRequest(
        url,
        { method: "PUT", headers: { ...good, host: "evil.example" } },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      request.end(JSON.stringify(config));
    });
    expect(wrongHost).toBe(403);
    for (const body of [
      "{",
      JSON.stringify({ ...config, command: "echo unsafe" }),
      JSON.stringify({ ...config, auth: "secret" }),
    ]) {
      const response = await fetch(url, { method: "PUT", headers: good, body });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBeTruthy();
      expect(await loadRoleConfig({ cwd })).toEqual(config);
    }
    expect(
      (
        await fetch(url, {
          method: "PUT",
          headers: { ...good, "content-type": "text/plain" },
          body: "{}",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await fetch(url, {
          method: "PUT",
          headers: good,
          body: "x".repeat(17000),
        })
      ).status,
    ).toBe(413);
    const changed = structuredClone(config);
    changed.roles.planner.model = "custom-http";
    const saved = await fetch(url, {
      method: "PUT",
      headers: good,
      body: JSON.stringify(changed),
    });
    expect(saved.status).toBe(200);
    const observed = (await (await fetch(url)).json()) as {
      config: typeof config;
      capability: { efforts: string[] };
      project: string;
    };
    expect(observed.config.roles.planner.model).toBe("custom-http");
    expect(observed.capability.efforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(Object.keys(observed)).toEqual([
      "config",
      "capability",
      "providers",
      "project",
    ]);
    expect(JSON.stringify(observed)).not.toContain("never-return-this-token");
    const invalidRole = structuredClone(config);
    invalidRole.roles.reviewer.model = "invalid model";
    const diagnostic = await fetch(url, {
      method: "PUT",
      headers: good,
      body: JSON.stringify(invalidRole),
    });
    expect(((await diagnostic.json()) as { error: string }).error).toContain(
      "roles.reviewer.model:",
    );
    expect(
      (
        await fetch(server.url + "/api/run", {
          method: "POST",
          headers: good,
          body: JSON.stringify({ command: "echo unsafe" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (await fetch(server.url + "/api/config?cwd=/tmp/other")).status,
    ).toBe(400);
  } finally {
    await server.close();
  }
});

test("HTTP run uses a frozen runtime, reports actual roles, prevents overlapping starts, and isolates selected projects", async () => {
  const cwd = await project();
  const other = await project();
  let finish!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let completed!: () => void;
  const done = new Promise<void>((resolve) => {
    completed = resolve;
  });
  let active: Awaited<ReturnType<typeof createProjectRuntime>> | undefined;
  const server = await operator(cwd, async (runtime) => {
    active = runtime;
    const map = await runtime.createAgentMap("Fake workflow");
    await map.track(
      {
        batch: 1,
        role: "implementer",
        title: "Fake implementation",
        branch: "test",
      },
      async () => {
        started();
        await blocked;
        return { completionSignal: "<promise>COMPLETE</promise>" };
      },
    );
    await map.finish("completed");
    completed();
  });
  try {
    const cookie = await session(server.url);
    const headers = {
      cookie,
      origin: server.url,
      "content-type": "application/json",
    };
    const start = await fetch(server.url + "/api/run", {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(start.status).toBe(202);
    await ready;
    expect(
      (
        await fetch(server.url + "/api/run", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
    ).toBe(409);
    const changed = await loadRoleConfig({ cwd });
    changed.roles.implementer.model = "new-model";
    changed.roles.implementer.effort = "medium";
    expect(
      (
        await fetch(server.url + "/api/config", {
          method: "PUT",
          headers,
          body: JSON.stringify(changed),
        })
      ).status,
    ).toBe(200);
    expect(active!.record.config.roles.implementer.model).toBe("gpt-6.1-sol");
    expect((await loadRoleConfig({ cwd: other })).roles.implementer.model).toBe(
      "gpt-6.1-sol",
    );
    const runs = (await (await fetch(server.url + "/api/run")).json()) as {
      run: {
        config: typeof changed;
        runtimeVersion: string;
        prompts?: unknown;
      };
    };
    expect(runs.run.config.roles.implementer.effort).toBe("low");
    expect(runs.run.runtimeVersion).toMatch(/^0\./);
    expect(runs.run.prompts).toBeUndefined();
    const dashboard = await import("./AgentMap.js").then((m) =>
      m.startDashboard({ cwd, port: 0 }),
    );
    try {
      const list = (await (
        await fetch(dashboard.url + "/api/runs")
      ).json()) as { runs: { id: string }[] };
      const record = (await (
        await fetch(dashboard.url + "/api/runs/" + list.runs[0]!.id)
      ).json()) as {
        runtime: { id: string; configRevision: string };
        nodes: unknown[];
      };
      expect(record.runtime.id).toBe(active!.record.id);
      expect(record.runtime.configRevision).toBe(
        active!.record.config.revision,
      );
      expect(record.nodes[0]).toMatchObject({
        model: "gpt-6.1-sol",
        provider: "codex",
        effort: "low",
      });
    } finally {
      await dashboard.close();
    }
  } finally {
    finish();
    await done;
    await server.close();
  }
});

test("frozen runtime handoff verifies its source schema, version, revision and prompt integrity", async () => {
  const cwd = await project();
  await writeFile(join(cwd, "handoff.md"), "frozen handoff prompt");
  const runtime = await createProjectRuntime({
    cwd,
    sandboxIdentity: "sha256:handoff-image",
    promptFiles: {
      planner: "handoff.md",
      implementer: null,
      reviewer: null,
      merger: null,
      readiness: null,
    },
  });
  const reopened = await openProjectRuntime({ cwd, id: runtime.record.id });
  expect(reopened.record).toEqual(runtime.record);
  await expect(openProjectRuntime({ cwd, id: "../outside" })).rejects.toThrow(
    /Invalid/,
  );
  const recordPath = join(
    cwd,
    ".sandcastle/runtime",
    runtime.record.id,
    "record.json",
  );
  const original = await readFile(recordPath, "utf8");
  for (const change of [
    { runtimeVersion: "0.0.0-unsupported" },
    { id: "00000000-0000-0000-0000-000000000000" },
    { config: { ...runtime.record.config, schemaVersion: 2 } },
    { config: { ...runtime.record.config, revision: "forged" } },
    { unexpected: "unsupported-source-field" },
  ]) {
    await writeFile(
      recordPath,
      JSON.stringify({ ...runtime.record, ...change }),
    );
    await expect(
      openProjectRuntime({ cwd, id: runtime.record.id }),
    ).rejects.toThrow();
  }
  await writeFile(recordPath, original);
  await writeFile(runtime.promptFile("planner"), "altered frozen prompt");
  await expect(
    openProjectRuntime({ cwd, id: runtime.record.id }),
  ).rejects.toThrow(/integrity/);
});

test("created and reopened runtimes retain the explicit project after the host changes directory", async () => {
  const cwd = await project();
  const other = await project();
  const hostCwd = process.cwd();
  await writeFile(join(cwd, "prompt.md"), "selected project prompt");
  const dashboard = await startDashboard({ cwd, port: 0 });
  try {
    process.chdir(cwd);
    const runtime = await createProjectRuntime({
      cwd: ".",
      sandboxIdentity: "selected-image",
      promptFiles: {
        planner: "prompt.md",
        implementer: null,
        reviewer: null,
        merger: null,
        readiness: null,
      },
    });
    const reopened = await openProjectRuntime({
      cwd: ".",
      id: runtime.record.id,
    });
    process.chdir(other);
    for (const selected of [runtime, reopened]) {
      expect(await readFile(selected.promptFile("planner"), "utf8")).toBe(
        "selected project prompt",
      );
      const map = await selected.createAgentMap("Selected project");
      await map.finish("completed");
    }
    const runs = (await (await fetch(dashboard.url + "/api/runs")).json()) as {
      runs: { name: string }[];
    };
    expect(runs.runs.map((run) => run.name)).toEqual([
      "Selected project",
      "Selected project",
    ]);
  } finally {
    process.chdir(hostCwd);
    await dashboard.close();
  }
});

test("readers observe complete configurations during competing atomic saves", async () => {
  const cwd = await project();
  const original = await saveRoleConfig({
    cwd,
    config: await loadRoleConfig({ cwd }),
  });
  const models = ["gpt-6.1-sol", "atomic-a", "atomic-b"];
  const saves = Promise.all(
    Array.from({ length: 12 }, (_, index) => {
      const config = structuredClone(original);
      for (const role of Object.values(config.roles))
        role.model = models[1 + (index % 2)]!;
      return saveRoleConfig({ cwd, config });
    }),
  );
  const reads = Promise.all(
    Array.from({ length: 30 }, async () => {
      const config = await loadRoleConfig({ cwd });
      const observed = Object.values(config.roles).map((role) => role.model);
      expect(models).toContain(observed[0]);
      expect(new Set(observed).size).toBe(1);
    }),
  );
  await Promise.all([saves, reads]);
  expect(models.slice(1)).toContain(
    (await loadRoleConfig({ cwd })).roles.planner.model,
  );
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "filesystem save failure gives an actionable error and preserves the durable configuration",
  async () => {
    const cwd = await project();
    const config = await saveRoleConfig({
      cwd,
      config: await loadRoleConfig({ cwd }),
    });
    const changed = structuredClone(config);
    changed.roles.planner.model = "not-persisted";
    await chmod(join(cwd, ".sandcastle"), 0o500);
    try {
      await expect(saveRoleConfig({ cwd, config: changed })).rejects.toThrow(
        /Cannot save .sandcastle\/roles.json; check project permissions/,
      );
      expect(await loadRoleConfig({ cwd })).toEqual(config);
    } finally {
      await chmod(join(cwd, ".sandcastle"), 0o700);
    }
  },
);

test.each(["image", "prompt"])(
  "failed %s admission reports a safe error and permits a corrected run",
  async (failure) => {
    const cwd = await project();
    let invalid = true;
    const server = await startOperator({
      cwd,
      port: 0,
      adapter: {
        promptFiles: {
          planner: "prompt.md",
          implementer: null,
          reviewer: null,
          merger: null,
          readiness: null,
        },
        sandboxIdentity: async () => {
          if (invalid && failure === "image")
            throw new Error("credential-do-not-return");
          return "recovered-image";
        },
        run: async () => {},
      },
    });
    try {
      const cookie = await session(server.url);
      const headers = {
        cookie,
        origin: server.url,
        "content-type": "application/json",
      };
      const start = () =>
        fetch(server.url + "/api/run", { method: "POST", headers, body: "{}" });
      const failed = await start();
      expect(failed.status).toBe(400);
      const diagnostic = (await failed.json()) as { error: string };
      expect(diagnostic.error).toContain(
        failure === "image"
          ? "check project paths, adapter and permissions"
          : "check prompt paths and permissions",
      );
      expect(diagnostic.error).not.toContain("credential-do-not-return");
      expect(await (await fetch(server.url + "/api/run")).json()).toEqual({
        run: null,
      });
      invalid = false;
      await writeFile(join(cwd, "prompt.md"), "recovered prompt");
      expect((await start()).status).toBe(202);
      expect(await (await fetch(server.url + "/api/run")).json()).toMatchObject(
        {
          run: { sandboxIdentity: "recovered-image", status: "completed" },
        },
      );
    } finally {
      await server.close();
    }
  },
);

test("failed execution remains observable and releases the next-run guard", async () => {
  const cwd = await project();
  let invalid = true;
  const server = await operator(cwd, async () => {
    if (invalid) throw new Error("execution-secret-do-not-return");
  });
  try {
    const cookie = await session(server.url);
    const headers = {
      cookie,
      origin: server.url,
      "content-type": "application/json",
    };
    const start = () =>
      fetch(server.url + "/api/run", { method: "POST", headers, body: "{}" });
    expect((await start()).status).toBe(202);
    const failed = await (await fetch(server.url + "/api/run")).text();
    expect(JSON.parse(failed)).toMatchObject({ run: { status: "failed" } });
    expect(failed).not.toContain("execution-secret-do-not-return");
    invalid = false;
    expect((await start()).status).toBe(202);
    expect(await (await fetch(server.url + "/api/run")).json()).toMatchObject({
      run: { status: "completed" },
    });
  } finally {
    await server.close();
  }
});
