import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { loadWorkflowConfig, saveWorkflowConfig } from "./OperatorWorkflow.js";
import { loadRoleConfig } from "./Operator.js";

test("operator CLI serves only its explicit project and hands its frozen runtime to the fixed workflow", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "operator-cli-"));
  const configDir = join(cwd, ".sandcastle");
  const bin = join(cwd, "bin");
  await mkdir(configDir);
  await mkdir(bin);
  await writeFile(join(configDir, "Dockerfile.custom"), "FROM fixture");
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  await symlink(
    join(process.cwd(), "node_modules"),
    join(cwd, "node_modules"),
    "dir",
  );
  for (const role of ["plan", "implement", "review", "merge", "readiness"])
    await writeFile(join(configDir, role + "-prompt.md"), role + " prompt");
  await writeFile(
    join(bin, "docker"),
    `#!/usr/bin/env node
import fs from 'node:fs'; const args = process.argv.slice(2);
fs.appendFileSync('docker-calls.jsonl', JSON.stringify(args)+'\\n');
if(args[0]==='image' && args[1]==='inspect') console.log(args.includes('{{.Config.User}}') ? '' : 'sha256:'+(args.includes('fixture:selected') ? 'b' : args.includes('fixture:next') ? 'c' : 'a').repeat(64));
`,
  );
  await chmod(join(bin, "docker"), 0o755);
  await writeFile(
    join(configDir, "main.mts"),
    `
import * as sandcastle from ${JSON.stringify(pathToFileURL(join(process.cwd(), "dist/index.js")).href)};
import { readFile, writeFile, access } from "node:fs/promises";
import { docker } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "dist/sandboxes/docker.js")).href)};
const runtime = await sandcastle.openProjectRuntime({ cwd: process.cwd(), id: process.env.SANDCASTLE_RUNTIME_ID });
const provider = docker({imageName:runtime.record.sandboxIdentity, mounts:[{hostPath:'.sandcastle',sandboxPath:'/home/agent/.codex'}]});
const handle = await provider.create({hostRepoPath:process.cwd(),worktreePath:process.cwd(),mounts:[{hostPath:process.cwd(),sandboxPath:'/home/agent/workspace'}],env:{}});
await handle.close();
await writeFile(".sandcastle/observed.json", JSON.stringify({
  workflow: runtime.workflow.config,
  id: runtime.record.id, model: runtime.record.config.roles.planner.model,
  effort: runtime.record.config.roles.planner.effort, image: runtime.record.sandboxIdentity,
  prompt: await readFile(runtime.promptFile("implementer"), "utf8"),
}));
if (runtime.record.sandboxIdentity === 'sha256:'+'b'.repeat(64)) {
  while(true) {try {await access('.sandcastle/release'); break;} catch {await new Promise(resolve=>setTimeout(resolve,20));}}
}
`,
  );
  const child = spawn(
    process.execPath,
    [
      join(process.cwd(), "dist/main.js"),
      "operator",
      "--cwd",
      cwd,
      "--port",
      "0",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, PATH: bin + ":" + process.env.PATH },
    },
  );
  let output = "";
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  try {
    const url = await new Promise<string>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(new Error("Operator exited: " + code)),
      );
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        const match = /Operator: (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (match) resolve(match[1]!);
      });
    });
    const cookie = (await fetch(url)).headers.get("set-cookie")!.split(";")[0]!;
    const headers = { cookie, origin: url, "content-type": "application/json" };
    const workflow = await loadWorkflowConfig({ cwd });
    expect(
      (
        await fetch(url + "/api/workflow", {
          method: "PUT",
          headers,
          body: JSON.stringify({
            ...workflow,
            repository: "owner/project",
            limits: { ...workflow.limits, cycles: 2, concurrency: 1 },
          }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        (await (await fetch(url + "/api/workflow")).json()) as {
          config: unknown;
        }
      ).config,
    ).toEqual(await loadWorkflowConfig({ cwd }));
    const config = await loadRoleConfig({ cwd });
    config.roles.planner.model = "cli-selected";
    config.roles.planner.effort = "medium";
    expect(
      (
        await fetch(url + "/api/config", {
          method: "PUT",
          headers,
          body: JSON.stringify(config),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(url + "/api/prompts", {
          method: "PUT",
          headers,
          body: JSON.stringify({
            role: "implementer",
            content: "CLI selected prompt",
          }),
        })
      ).status,
    ).toBe(200);
    const environment = {
      schemaVersion: 1,
      image: "fixture:selected",
      dockerfile: ".sandcastle/Dockerfile.custom",
      buildArgs: {},
    };
    expect(
      (
        await fetch(url + "/api/environment", {
          method: "PUT",
          headers,
          body: JSON.stringify(environment),
        })
      ).status,
    ).toBe(200);
    expect(
      (await fetch(url + "/api/run", { method: "POST", headers, body: "{}" }))
        .status,
    ).toBe(202);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await readFile(join(configDir, "observed.json"));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(
      (
        await fetch(url + "/api/environment", {
          method: "PUT",
          headers,
          body: JSON.stringify({ ...environment, image: "fixture:next" }),
        })
      ).status,
    ).toBe(200);
    const active = (await (await fetch(url + "/api/run")).json()) as {
      run: { sandboxIdentity: string; status: string };
    };
    expect(active.run).toMatchObject({
      sandboxIdentity: "sha256:" + "b".repeat(64),
      status: "running",
    });
    await writeFile(join(configDir, "release"), "done");
    let status = "running";
    for (let attempt = 0; status === "running" && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const response = (await (await fetch(url + "/api/run")).json()) as {
        run: { status: string };
      };
      status = response.run.status;
    }
    expect(status).toBe("completed");
    const observed = JSON.parse(
      await readFile(join(configDir, "observed.json"), "utf8"),
    );
    expect(observed.workflow).toMatchObject({
      repository: "owner/project",
      limits: { cycles: 2, concurrency: 1 },
    });
    await saveWorkflowConfig({
      cwd,
      config: {
        ...(await loadWorkflowConfig({ cwd })),
        repository: "later/project",
      },
    });
    expect(observed).toMatchObject({
      model: "cli-selected",
      effort: "medium",
      image: "sha256:" + "b".repeat(64),
      prompt: "CLI selected prompt",
    });
    const current = (await (await fetch(url + "/api/run")).json()) as {
      run: { id: string };
    };
    expect(observed.id).toBe(current.run.id);
    expect(
      (
        await fetch(url + "/api/prompts", {
          method: "PUT",
          headers,
          body: JSON.stringify({
            role: "implementer",
            content: "CLI next prompt",
          }),
        })
      ).status,
    ).toBe(200);
    const nextResponse = await fetch(url + "/api/run", {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(nextResponse.status).toBe(202);
    const nextRun = (await nextResponse.json()) as { id: string };
    expect(nextRun.id).not.toBe(observed.id);
    status = "running";
    for (let attempt = 0; status === "running" && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const response = (await (await fetch(url + "/api/run")).json()) as {
        run: { id: string; status: string };
      };
      expect(response.run.id).toBe(nextRun.id);
      status = response.run.status;
    }
    expect(status).toBe("completed");
    const nextObserved = JSON.parse(
      await readFile(join(configDir, "observed.json"), "utf8"),
    );
    expect(nextObserved.workflow.repository).toBe("later/project");
    expect(nextObserved).toMatchObject({
      id: nextRun.id,
      prompt: "CLI next prompt",
      image: "sha256:" + "c".repeat(64),
    });
    const calls = (await readFile(join(cwd, "docker-calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const starts = calls.filter((args) => args[0] === "run");
    expect(starts.map((args) => args.at(-1))).toEqual([
      "sha256:" + "b".repeat(64),
      "sha256:" + "c".repeat(64),
    ]);
    expect(
      starts.every((args) =>
        args.some((arg) => arg.includes("/home/agent/.codex")),
      ),
    ).toBe(true);
    expect(
      calls.some((args) =>
        ["build", "push", "prune", "rmi"].includes(args[0]!),
      ),
    ).toBe(false);
  } finally {
    child.kill("SIGTERM");
    await closed;
    await rm(cwd, { recursive: true, force: true });
  }
}, 20_000);
