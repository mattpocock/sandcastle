import { loadWorkflowConfig, saveWorkflowConfig } from "./OperatorWorkflow.js";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { execFile } from "node:child_process";
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
import { expect, test } from "vitest";
import { getAgent, scaffold } from "./InitService.js";
import { saveEnvironmentConfig } from "./OperatorEnvironment.js";

// Exercise copied consumers unchanged against the built package. Only the
// external tracker and Docker executables are replaced, never SDK modules.
test.each([
  { template: "parallel-planner-with-review", project: "node" },
  { template: "codex-afk", project: "node" },
  { template: "codex-afk", project: "android" },
])(
  "generated $template/$project uses the selected immutable image at Docker's boundary",
  async ({ template, project }) => {
    const cwd = await mkdtemp(join(tmpdir(), "operator-generated-"));
    try {
      await writeFile(
        join(cwd, "package.json"),
        JSON.stringify({ type: "module", scripts: { test: "vitest run" } }),
      );
      if (project === "android") {
        await mkdir(join(cwd, "app"));
        await writeFile(
          join(cwd, "settings.gradle.kts"),
          'rootProject.name = "fixture"\n',
        );
        await writeFile(join(cwd, "gradlew"), "#!/usr/bin/env sh\n");
        await writeFile(
          join(cwd, "app/build.gradle.kts"),
          'plugins { id("com.android.application") }\nandroid { compileSdk = 35 }\n',
        );
      }
      const runHost = (file: string, args: string[]) =>
        new Promise<{ code: number; stdout: string; stderr: string }>(
          (resolve) => {
            execFile(
              file,
              args,
              {
                cwd,
                timeout: 20_000,
                env: {
                  ...process.env,
                  PATH: join(cwd, "bin") + ":" + process.env.PATH,
                },
              },
              (error, stdout, stderr) => {
                resolve({ code: error ? 1 : 0, stdout, stderr });
              },
            );
          },
        );
      for (const args of [
        ["init", "-b", "main"],
        ["config", "user.name", "Fixture"],
        ["config", "user.email", "fixture@example.test"],
      ])
        expect((await runHost("git", args)).code).toBe(0);
      const { mainFilename } = await Effect.runPromise(
        scaffold(cwd, {
          templateName: template,
          agent: getAgent("codex")!,
          model: "fixture-model",
          ...(template === "codex-afk"
            ? { agentAuth: "chatgpt" as const }
            : {}),
        }).pipe(Effect.provide(NodeFileSystem.layer)),
      );
      await saveEnvironmentConfig({
        cwd,
        config: {
          schemaVersion: 1,
          image: "fixture:chosen",
          dockerfile: ".sandcastle/Dockerfile",
          buildArgs: {},
        },
      });
      await mkdir(join(cwd, "node_modules/@ai-hero"), { recursive: true });
      await symlink(
        process.cwd(),
        join(cwd, "node_modules/@ai-hero/sandcastle"),
        "dir",
      );
      for (const name of ["tsx", "zod"])
        await symlink(
          join(process.cwd(), "node_modules", name),
          join(cwd, "node_modules", name),
          "dir",
        );
      await mkdir(join(cwd, "bin"));
      await writeFile(
        join(cwd, "bin/gh"),
        "#!/usr/bin/env node\nconsole.log('[]');\n",
      );
      await writeFile(
        join(cwd, "bin/docker"),
        `#!/usr/bin/env node
import fs from 'node:fs'; const args = process.argv.slice(2);
fs.appendFileSync('docker-calls.jsonl', JSON.stringify(args)+'\\n');
if(args[0]==='image' && args[1]==='inspect') console.log(args.includes('{{.Config.User}}') ? '' : 'sha256:'+'d'.repeat(64));
if(args[0]==='run') { console.error('fixture stops at container launch'); process.exit(1); }
`,
      );
      for (const name of ["gh", "docker"])
        await chmod(join(cwd, "bin", name), 0o755);
      await writeFile(
        join(cwd, ".gitignore"),
        "node_modules/\nbin/\ndocker-calls.jsonl\n",
      );
      expect((await runHost("git", ["add", "."])).code).toBe(0);
      expect((await runHost("git", ["commit", "-m", "Fixture"])).code).toBe(0);
      const missingRepository = await runHost(process.execPath, [
        "--import",
        "tsx",
        ".sandcastle/" + mainFilename,
      ]);
      expect(missingRepository.code).toBe(1);
      expect(missingRepository.stderr).toContain(
        "Explicit repository required",
      );
      expect(
        (await readFile(join(cwd, "docker-calls.jsonl"), "utf8")).includes(
          '"run"',
        ),
      ).toBe(false);
      const workflow = await loadWorkflowConfig({ cwd });
      await saveWorkflowConfig({
        cwd,
        config: { ...workflow, repository: "owner/project" },
      });
      expect(
        (await runHost("git", ["add", ".sandcastle/workflow.json"])).code,
      ).toBe(0);
      expect(
        (await runHost("git", ["commit", "-m", "Configure explicit tracker"]))
          .code,
      ).toBe(0);
      const result = await runHost(process.execPath, [
        "--import",
        "tsx",
        ".sandcastle/" + mainFilename,
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("fixture stops at container launch");
      const calls = (await readFile(join(cwd, "docker-calls.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(calls[0]).toEqual([
        "image",
        "inspect",
        "fixture:chosen",
        "--format",
        "{{.Id}}",
      ]);
      const launch = calls.find((args) => args[0] === "run")!;
      expect(launch.at(-1)).toBe("sha256:" + "d".repeat(64));
      if (template === "codex-afk") {
        const volumes = launch.filter((_, index) => launch[index - 1] === "-v");
        expect(
          volumes.some((value) => value.includes("/home/agent/.codex")),
        ).toBe(true);
        expect(
          volumes.some((value) =>
            value.includes(
              project === "android"
                ? "/home/agent/.gradle"
                : "/home/agent/.npm",
            ),
          ),
        ).toBe(true);
        expect(
          volumes.some((value) =>
            value.includes("/home/agent/FEEDBACK_LOOPS.md:ro"),
          ),
        ).toBe(true);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  30_000,
);
