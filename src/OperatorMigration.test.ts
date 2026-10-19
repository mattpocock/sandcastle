import { loadEnvironmentConfig } from "./OperatorEnvironment.js";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  chmod,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect } from "vitest";
import { planProjectMigration } from "./OperatorMigration.js";

test("unsupported code is never evaluated or changed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "migration-"));
  try {
    await mkdir(join(cwd, ".sandcastle"));
    const code = 'throw new Error("MUST NOT EXECUTE");\n';
    await writeFile(join(cwd, ".sandcastle/main.ts"), code);
    const plan = await planProjectMigration({ cwd });
    expect(plan.status).toBe("unsupported");
    expect(plan.instructions).toContain("openProjectRuntime");
    expect(await readFile(join(cwd, ".sandcastle/main.ts"), "utf8")).toBe(code);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

import { scaffold, getAgent } from "./InitService.js";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { installRuntimeUpdate } from "./OperatorUpdates.js";
const exec = promisify(execFile);
const fixture = async (profile = "reviewed") => {
  const cwd = await mkdtemp(join(tmpdir(), "migration-consumer-"));
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ type: "module", scripts: { test: "vitest run" } }),
  );
  if (profile === "android") {
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
  await Effect.runPromise(
    scaffold(cwd, {
      templateName:
        profile === "reviewed" ? "parallel-planner-with-review" : "codex-afk",
      agent: getAgent("codex")!,
      model: "fixture-model",
      ...(profile === "reviewed" ? {} : { agentAuth: "chatgpt" as const }),
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
  await writeFile(
    join(cwd, ".sandcastle/main.ts"),
    await readFile(
      join(process.cwd(), "src/templates/migrations", profile + ".txt"),
      "utf8",
    ),
  );
  await rm(join(cwd, ".sandcastle/roles.json"));
  const pkg = join(cwd, "archive");
  await mkdir(join(pkg, "dist/templates/parallel-planner-with-review"), {
    recursive: true,
  });
  const source = {
    schemaVersion: 1,
    source: "https://github.com/hanhnghh/sandcastle",
    commit: "a".repeat(40),
    version: "0.12.0",
  };
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "@test/migration-fork",
      version: "0.12.0",
      type: "module",
      files: ["dist", "runtime-source.json", "LICENSE"],
      exports: {
        ".": "./dist/index.js",
        "./sandboxes/docker": "./dist/docker.js",
      },
      sandcastleRuntime: source,
    }),
  );
  await writeFile(join(pkg, "runtime-source.json"), JSON.stringify(source));
  for (const name of [
    "LICENSE",
    "dist/index.d.ts",
    "dist/main.js",
    "dist/templates/parallel-planner-with-review/implement-prompt.md",
  ])
    await writeFile(join(pkg, name), "fixture");
  await writeFile(
    join(pkg, "dist/index.js"),
    `export * from ${JSON.stringify("file://" + join(process.cwd(), "dist/index.js"))};`,
  );
  await writeFile(
    join(pkg, "dist/docker.js"),
    `export * from ${JSON.stringify("file://" + join(process.cwd(), "dist/sandboxes/docker.js"))};`,
  );
  const packed = JSON.parse(
    (await exec("npm", ["pack", "--json", "--ignore-scripts"], { cwd: pkg }))
      .stdout,
  )[0];
  await writeFile(
    join(cwd, ".sandcastle/updates.json"),
    JSON.stringify({
      schemaVersion: 1,
      package: "@test/migration-fork",
      dependency: "@ai-hero/sandcastle",
      registry: "http://127.0.0.1:9",
      channel: "latest",
      manifest: ".sandcastle/package.json",
      source: { kind: "archive", path: join(pkg, packed.filename) },
    }),
  );
  await installRuntimeUpdate({
    cwd,
    version: null,
    expectedRevision: null,
    onProgress: () => {},
  });
  return cwd;
};

test("migration plan binds installed source and files", async () => {
  const cwd = await fixture();
  try {
    const before = await readFile(join(cwd, ".sandcastle/main.ts"), "utf8");
    const plan = await planProjectMigration({ cwd });
    expect(plan.status).toBe("ready");
    expect(plan.runtime?.installed?.provenance?.commit).toBe("a".repeat(40));
    expect(
      plan.files.find((file) => file.path === ".sandcastle/main.ts")?.after,
    ).toContain("sandcastle.openProjectRuntime");
    expect(await readFile(join(cwd, ".sandcastle/main.ts"), "utf8")).toBe(
      before,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 30000);

import { applyProjectMigration } from "./OperatorMigration.js";
import { createProjectRuntime } from "./OperatorRuntime.js";
const promptFiles = {
  planner: ".sandcastle/plan-prompt.md",
  implementer: ".sandcastle/implement-prompt.md",
  reviewer: ".sandcastle/review-prompt.md",
  merger: ".sandcastle/merge-prompt.md",
  readiness: ".sandcastle/readiness-prompt.md",
};
test.each(["reviewed", "node", "android"])(
  "migrates %s preserving project settings",
  async (profile) => {
    const cwd = await fixture(profile);
    try {
      const main = join(cwd, ".sandcastle/main.ts");
      let old = (await readFile(main, "utf8"))
        .replaceAll("fixture-model", "custom-model")
        .replace("const MAX_ITERATIONS = 10;", "const MAX_ITERATIONS = 7;")
        .replace("npm install", "npm ci")
        .replace(
          "bash .sandcastle/scripts/ready.sh",
          "bash .sandcastle/scripts/custom-ready.sh",
        )
        .replace(".sandcastle/codex-home", ".sandcastle/custom-auth")
        .replace(".sandcastle/cache/npm", ".sandcastle/cache/custom-npm")
        .replace(".sandcastle/cache/gradle", ".sandcastle/cache/custom-gradle");
      if (profile === "reviewed") {
        for (const role of [
          "readiness",
          "planner",
          "implementer",
          "reviewer",
          "merger",
        ])
          old = old.replace(
            'sandcastle.codex("custom-model")',
            `sandcastle.codex("${role}-custom-model")`,
          );
      }
      await writeFile(main, old);
      const prompt =
        (await readFile(join(cwd, promptFiles.implementer), "utf8")) +
        "\nProject customization\n";
      await writeFile(join(cwd, promptFiles.implementer), prompt);
      await writeFile(
        join(cwd, ".sandcastle/readiness.json"),
        JSON.stringify({
          mode: "report-only",
          repository: "owner/project",
          holdLabels: ["manual-hold"],
          qualificationLabel: "qualified-by-project",
          verifyCommand: [
            process.execPath,
            "-e",
            `console.log(JSON.stringify({ proof: ${JSON.stringify(profile + "-project-verifier")} }))`,
          ],
        }),
      );
      await writeFile(
        join(cwd, ".sandcastle/feedback-gates.json"),
        JSON.stringify({
          gates: {
            project: [
              process.execPath,
              "-e",
              "let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>process.exit(JSON.parse(input).snapshot.repository==='owner/project'?0:1));",
            ],
          },
          requiredGates: ["project"],
        }),
      );
      const auth = "PRIVATE AUTH";
      await writeFile(join(cwd, ".sandcastle/.env"), auth);
      const plan = await planProjectMigration({ cwd });
      expect(plan.status).toBe("ready");
      await applyProjectMigration({
        cwd,
        expectedRevision: plan.revision,
        preserveOverrides: true,
        onProgress: () => {},
      });
      const runtime = await createProjectRuntime({
        cwd,
        promptFiles,
        sandboxIdentity: "sha256:" + "d".repeat(64),
      });
      expect(runtime.record.config.roles.implementer.model).toBe(
        profile === "reviewed" ? "implementer-custom-model" : "custom-model",
      );
      for (const role of [
        "planner",
        "implementer",
        "reviewer",
        "merger",
        "readiness",
      ] as const)
        expect(runtime.record.config.roles[role].model).toBe(
          profile === "reviewed" ? role + "-custom-model" : "custom-model",
        );
      expect(
        await runtime.verifyReadiness({
          snapshot: {
            head: "a".repeat(40),
            repository: "owner/project",
            issues: [],
          },
          assessment: { head: "a".repeat(40), decisions: [] },
          trigger: { kind: "startup" },
        }),
      ).toEqual({ proof: profile + "-project-verifier" });
      expect(runtime.workflow.config.limits.cycles).toBe(7);
      expect(runtime.record.prompts.implementer?.content).toBe(prompt);
      expect(runtime.readiness.holdLabels).toContain("manual-hold");
      expect(runtime.readiness.qualificationLabel).toBe("qualified-by-project");
      expect(runtime.readiness.mode).toBe("report-only");
      expect(await readFile(join(cwd, ".sandcastle/.env"), "utf8")).toBe(auth);
      const upgraded = await readFile(main, "utf8");
      expect(upgraded).toContain('runtime.agent("reviewer"');
      if (profile !== "reviewed") {
        expect(runtime.record.config.roles.reviewer.effort).toBe("xhigh");
        expect(upgraded).toContain(".sandcastle/custom-auth");
        expect(upgraded).toContain(
          profile === "android"
            ? ".sandcastle/cache/custom-gradle"
            : ".sandcastle/cache/custom-npm",
        );
        expect(upgraded).toContain("bash .sandcastle/scripts/custom-ready.sh");
      } else expect(upgraded).toContain("npm ci");
      expect((await planProjectMigration({ cwd })).status).toBe("current");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  30000,
);

import { rollbackProjectMigration } from "./OperatorMigration.js";
import { claimRuntimeRun } from "./OperatorUpdates.js";
test("repeat application is idempotent for the original reviewed plan", async () => {
  const cwd = await fixture();
  try {
    const plan = await planProjectMigration({ cwd });
    const options = {
      cwd,
      expectedRevision: plan.revision,
      preserveOverrides: true,
      onProgress: () => {},
    };
    await applyProjectMigration(options);
    expect(await applyProjectMigration(options)).toEqual({ status: "current" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 30000);

test("preserves explicit role effort and additional Docker mounts and bootstrap gates", async () => {
  const cwd = await fixture();
  try {
    const path = join(cwd, ".sandcastle/main.ts");
    await writeFile(
      path,
      (await readFile(path, "utf8"))
        .replaceAll(
          'sandcastle.codex("fixture-model")',
          'sandcastle.codex("fixture-model", { effort: "xhigh", approvalsReviewer: "auto_review" })',
        )
        .replaceAll(
          "docker({ env: trackerEnvironment })",
          'docker({ env: trackerEnvironment, mounts: [{ hostPath: ".sandcastle/custom-auth", sandboxPath: "/home/agent/.codex" }] })',
        ),
    );
    const plan = await planProjectMigration({ cwd });
    expect(plan.status).toBe("ready");
    await applyProjectMigration({
      cwd,
      expectedRevision: plan.revision,
      preserveOverrides: true,
      onProgress: () => {},
    });
    const runtime = await createProjectRuntime({
      cwd,
      promptFiles,
      sandboxIdentity: "image",
    });
    expect(runtime.record.config.roles.implementer.effort).toBe("xhigh");
    expect(await readFile(path, "utf8")).toContain(
      'approvalsReviewer: "auto_review"',
    );
    expect(await readFile(path, "utf8")).toContain(
      'hostPath: ".sandcastle/custom-auth"',
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 30000);

test("migration preserves a literal legacy image in versioned environment settings", async () => {
  const cwd = await fixture();
  try {
    const main = join(cwd, ".sandcastle/main.ts");
    await writeFile(
      main,
      (await readFile(main, "utf8")).replaceAll(
        /docker\(\{/g,
        'docker({ imageName: "custom:legacy",',
      ),
    );
    const plan = await planProjectMigration({ cwd });
    expect(plan.status).toBe("ready");
    await applyProjectMigration({
      cwd,
      expectedRevision: plan.revision,
      preserveOverrides: true,
      onProgress: () => {},
    });
    await expect(loadEnvironmentConfig({ cwd })).resolves.toMatchObject({
      image: "custom:legacy",
    });
    expect(await readFile(main, "utf8")).not.toContain(
      'imageName: "custom:legacy"',
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 30000);

test("rejects stale plans, unconfirmed conflicts and active runs", async () => {
  const cwd = await fixture();
  try {
    await writeFile(
      join(cwd, promptFiles.implementer),
      (await readFile(join(cwd, promptFiles.implementer), "utf8")) +
        "\nCustomized prompt\n",
    );
    const plan = await planProjectMigration({ cwd });
    const options = {
      cwd,
      expectedRevision: plan.revision,
      preserveOverrides: true,
      onProgress: () => {},
    };
    await expect(
      applyProjectMigration({ ...options, preserveOverrides: false }),
    ).rejects.toThrow("Prompt conflicts");
    const release = await claimRuntimeRun(cwd);
    try {
      await expect(applyProjectMigration(options)).rejects.toThrow("locked");
    } finally {
      await release();
    }
    await writeFile(
      join(cwd, promptFiles.planner),
      (await readFile(join(cwd, promptFiles.planner), "utf8")) +
        "\nHost edit\n",
    );
    await expect(applyProjectMigration(options)).rejects.toThrow(
      "snapshot changed",
    );
    expect(
      await readFile(join(cwd, ".sandcastle/main.ts"), "utf8"),
    ).not.toContain("openProjectRuntime");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 30000);

test("restores partial promotion and supports rollback without touching private project artifacts", async () => {
  const cwd = await fixture("android");
  try {
    const paths = [
      ".sandcastle/main.ts",
      ".sandcastle/Dockerfile",
      ".sandcastle/CODING_STANDARDS.md",
      ".sandcastle/readiness.json",
    ];
    const originals = await Promise.all(
      paths.map((path) => readFile(join(cwd, path), "utf8")),
    );
    const privatePaths = [
      ".sandcastle/codex-home/auth.json",
      ".sandcastle/codex-home/sessions/private.json",
      ".sandcastle/journals/private.json",
      ".git/refs/heads/work",
    ];
    for (const path of privatePaths) {
      await mkdir(join(cwd, path, ".."), { recursive: true });
      await writeFile(join(cwd, path), "PRIVATE ARTIFACT");
    }
    const plan = await planProjectMigration({ cwd });
    expect(
      plan.files.some((file) => /auth|session|journal|\.git\//.test(file.path)),
    ).toBe(false);
    await expect(
      applyProjectMigration({
        cwd,
        expectedRevision: plan.revision,
        preserveOverrides: true,
        onProgress: (phase) => {
          if (phase.endsWith("main.ts"))
            throw new Error("consumer listener failure");
        },
      }),
    ).rejects.toThrow("restoring managed files");
    expect(
      await Promise.all(paths.map((path) => readFile(join(cwd, path), "utf8"))),
    ).toEqual(originals);
    const retry = await planProjectMigration({ cwd });
    await applyProjectMigration({
      cwd,
      expectedRevision: retry.revision,
      preserveOverrides: true,
      onProgress: () => {},
    });
    await rollbackProjectMigration({ cwd });
    await rollbackProjectMigration({ cwd });
    expect(
      await Promise.all(paths.map((path) => readFile(join(cwd, path), "utf8"))),
    ).toEqual(originals);
    expect((await planProjectMigration({ cwd })).status).toBe("ready");
    for (const path of privatePaths)
      expect(await readFile(join(cwd, path), "utf8")).toBe("PRIVATE ARTIFACT");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 30000);

test("rollback preserves subsequent host edits", async () => {
  const cwd = await fixture();
  try {
    const plan = await planProjectMigration({ cwd });
    await applyProjectMigration({
      cwd,
      expectedRevision: plan.revision,
      preserveOverrides: true,
      onProgress: () => {},
    });
    const main = join(cwd, ".sandcastle/main.ts");
    const edit = (await readFile(main, "utf8")) + "\n// Host edit\n";
    await writeFile(main, edit);
    await expect(rollbackProjectMigration({ cwd })).rejects.toThrow(
      "Managed file changed",
    );
    expect(await readFile(main, "utf8")).toBe(edit);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 30000);

test.each(["source", "integrity"])(
  "same-version archives are distinguished by %s patch identity",
  async (identity) => {
    const cwd = await fixture();
    try {
      const plan = await planProjectMigration({ cwd });
      const pkg = join(cwd, "archive");
      const metadata = JSON.parse(
        await readFile(join(pkg, "package.json"), "utf8"),
      );
      metadata.sandcastleRuntime.commit = (
        identity === "source" ? "b" : "a"
      ).repeat(40);
      await writeFile(
        join(pkg, "dist/index.js"),
        (await readFile(join(pkg, "dist/index.js"), "utf8")) +
          "\n// Archive patch\n",
      );
      await writeFile(join(pkg, "package.json"), JSON.stringify(metadata));
      await writeFile(
        join(pkg, "runtime-source.json"),
        JSON.stringify(metadata.sandcastleRuntime),
      );
      await exec("npm", ["pack", "--json", "--ignore-scripts"], { cwd: pkg });
      const changed = await planProjectMigration({ cwd });
      expect(changed.status).toBe("unsupported");
      expect(changed.runtime?.target.version).toBe("0.12.0");
      expect(changed.runtime?.target.integrity).not.toBe(
        plan.runtime?.target.integrity,
      );
      expect(changed.runtime?.target.provenance.commit).toBe(
        (identity === "source" ? "b" : "a").repeat(40),
      );
      await expect(
        applyProjectMigration({
          cwd,
          expectedRevision: plan.revision,
          preserveOverrides: true,
          onProgress: () => {},
        }),
      ).rejects.toThrow("snapshot changed");
      await installRuntimeUpdate({
        cwd,
        version: null,
        expectedRevision: null,
        onProgress: () => {},
      });
      expect((await planProjectMigration({ cwd })).status).toBe("ready");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  30000,
);

test("custom statements after hooks remain unsupported and unevaluated", async () => {
  const cwd = await fixture();
  try {
    const path = join(cwd, ".sandcastle/main.ts");
    const source = (await readFile(path, "utf8")).replace(
      "const copyToWorktree =",
      'throw new Error("CUSTOM WORKFLOW MUST NOT EXECUTE");\nconst copyToWorktree =',
    );
    await writeFile(path, source);
    const plan = await planProjectMigration({ cwd });
    expect(plan.status).toBe("unsupported");
    expect(await readFile(path, "utf8")).toBe(source);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 30000);

test("incompatible installed runtime cannot accept a migration", async () => {
  const cwd = await fixture();
  try {
    await writeFile(
      join(cwd, ".sandcastle/node_modules/@ai-hero/sandcastle/dist/index.js"),
      'export const runtimeVersion="0.12.0";export function openProjectRuntime() {}\n',
    );
    const plan = await planProjectMigration({ cwd });
    expect(plan.status).toBe("unsupported");
    expect(plan.instructions).toContain("compatible");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 30000);

import {
  usePackagedPromptDefaults,
  saveProjectPrompt,
  loadProjectPrompts,
} from "./OperatorPrompts.js";
test("preserves prompt conflicts for explicit review with their original managed base", async () => {
  const cwd = await fixture("node");
  try {
    await usePackagedPromptDefaults({
      cwd,
      templateArgs: {
        VIEW_TASK_COMMAND: "gh issue view <ID>",
        CLOSE_TASK_COMMAND:
          'gh issue close <ID> --comment "Completed by Sandcastle"',
      },
    });
    const before = await loadProjectPrompts({ cwd, promptFiles });
    const content =
      before.implementer!.content + "\nManaged project override\n";
    await saveProjectPrompt({ cwd, promptFiles, role: "implementer", content });
    const expected = (await loadProjectPrompts({ cwd, promptFiles }))
      .implementer!;
    const plan = await planProjectMigration({ cwd });
    expect(
      plan.prompts.find((prompt) => prompt.role === "implementer"),
    ).toEqual({
      role: "implementer",
      base: expected.base.content,
      default: expected.default.content,
      override: content,
    });
    await applyProjectMigration({
      cwd,
      expectedRevision: plan.revision,
      preserveOverrides: true,
      onProgress: () => {},
    });
    expect(
      (await loadProjectPrompts({ cwd, promptFiles })).implementer,
    ).toEqual(expected);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 30000);

import { createHash } from "node:crypto";
test("invalid template provenance never selects a host path", async () => {
  const cwd = await fixture();
  try {
    const source = await readFile(join(cwd, ".sandcastle/main.ts"), "utf8");
    await writeFile(
      join(cwd, ".sandcastle/migration.json"),
      JSON.stringify({
        schemaVersion: 1,
        template: "../../private-host-data",
        workflowDigest: createHash("sha256").update(source).digest("hex"),
      }),
    );
    await expect(planProjectMigration({ cwd })).rejects.toThrow(
      "Invalid migration provenance",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 30000);

test("interrupted promotion requires recovery before repeat application", async () => {
  const cwd = await fixture();
  try {
    const original = await readFile(join(cwd, ".sandcastle/main.ts"), "utf8");
    const plan = await planProjectMigration({ cwd });
    const driver = join(cwd, "interrupt.mjs");
    await writeFile(
      driver,
      `import {applyProjectMigration} from ${JSON.stringify("file://" + join(process.cwd(), "dist/index.js"))};await applyProjectMigration({cwd:process.cwd(),expectedRevision:process.argv[2],preserveOverrides:true,onProgress:phase=>{if(phase.endsWith('migration.json'))process.exit(73);}});`,
    );
    await expect(
      exec(process.execPath, [driver, plan.revision], { cwd }),
    ).rejects.toMatchObject({ code: 73 });
    // The child has exited; reconcile only this fixture's proved-owned operation lock.
    await rm(join(cwd, ".sandcastle/updates/operation.lock"));
    const interrupted = await planProjectMigration({ cwd });
    expect(interrupted.status).toBe("unsupported");
    expect(interrupted.instructions).toContain("--rollback");
    await expect(
      applyProjectMigration({
        cwd,
        expectedRevision: interrupted.revision,
        preserveOverrides: true,
        onProgress: () => {},
      }),
    ).rejects.toThrow("Interrupted migration");
    await rollbackProjectMigration({ cwd });
    expect(await readFile(join(cwd, ".sandcastle/main.ts"), "utf8")).toBe(
      original,
    );
    expect((await planProjectMigration({ cwd })).status).toBe("ready");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 30000);

import { saveEnvironmentConfig } from "./OperatorEnvironment.js";
test.each([
  "dynamic",
  "per-role",
  "config-conflict",
  "implicit-default",
  "spread",
  "computed",
  "accessor",
  "escaped-key",
])(
  "unsupported %s image customization remains unchanged",
  async (kind) => {
    const cwd = await fixture();
    try {
      const main = join(cwd, ".sandcastle/main.ts");
      let source = await readFile(main, "utf8");
      if (["spread", "computed", "accessor", "escaped-key"].includes(kind))
        source = source.replaceAll(
          "docker({ env: trackerEnvironment })",
          kind === "spread"
            ? "docker({ env: trackerEnvironment, ...projectOptions })"
            : kind === "computed"
              ? 'docker({ env: trackerEnvironment, ["imageName"]: "custom:legacy" })'
              : kind === "accessor"
                ? 'docker({ env: trackerEnvironment, get imageName() { return "custom:legacy"; } })'
                : 'docker({ env: trackerEnvironment, "image\\u004eame": "custom:legacy" })',
        );
      else if (kind === "dynamic")
        source = source.replaceAll(
          "docker({ env: trackerEnvironment })",
          "docker({ env: trackerEnvironment, imageName: selectProjectImage() })",
        );
      else {
        source = source.replaceAll(
          kind === "implicit-default"
            ? /docker\(\{ env: trackerEnvironment/g
            : /docker\(\{/g,
          kind === "implicit-default"
            ? 'docker({ env: trackerEnvironment, imageName: "custom:legacy"'
            : 'docker({ imageName: "custom:legacy",',
        );
        if (kind === "per-role")
          source = source.replace(
            'imageName: "custom:legacy"',
            'imageName: "custom:different"',
          );
        else if (kind === "config-conflict")
          await saveEnvironmentConfig({
            cwd,
            config: {
              schemaVersion: 1,
              image: "custom:configured",
              dockerfile: ".sandcastle/Dockerfile",
              buildArgs: {},
            },
          });
      }
      await writeFile(main, source);
      const plan = await planProjectMigration({ cwd });
      expect(plan.status).toBe("unsupported");
      expect(plan.instructions).toMatch(/image|Image/);
      expect(await readFile(main, "utf8")).toBe(source);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  30000,
);

import { loadRoleConfig, saveRoleConfig } from "./Operator.js";
import { loadWorkflowConfig, saveWorkflowConfig } from "./OperatorWorkflow.js";
test("existing versioned role and workflow settings remain authoritative", async () => {
  const cwd = await fixture();
  try {
    const roles = await loadRoleConfig({ cwd });
    roles.roles.implementer = {
      provider: "codex",
      model: "managed-custom-model",
      effort: "xhigh",
    };
    await saveRoleConfig({ cwd, config: roles });
    const workflow = await loadWorkflowConfig({ cwd });
    await saveWorkflowConfig({
      cwd,
      config: {
        ...workflow,
        limits: { cycles: 19, concurrency: 2, plannerAttempts: 4 },
      },
    });
    const plan = await planProjectMigration({ cwd });
    await applyProjectMigration({
      cwd,
      expectedRevision: plan.revision,
      preserveOverrides: true,
      onProgress: () => {},
    });
    const runtime = await createProjectRuntime({
      cwd,
      promptFiles,
      sandboxIdentity: "image",
    });
    expect(runtime.record.config.roles.implementer).toEqual({
      provider: "codex",
      model: "managed-custom-model",
      effort: "xhigh",
    });
    expect(runtime.workflow.config.limits).toEqual({
      cycles: 19,
      concurrency: 2,
      plannerAttempts: 4,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 30000);

test("quoted effort keys and provider environment values are preserved independently", async () => {
  const cwd = await fixture();
  try {
    const main = join(cwd, ".sandcastle/main.ts");
    await writeFile(
      main,
      (await readFile(main, "utf8")).replaceAll(
        'sandcastle.codex("fixture-model")',
        'sandcastle.codex("fixture-model", { "effort": "xhigh", env: { effort: "low", CODEX_HOME: ".sandcastle/project-auth" } })',
      ),
    );
    const plan = await planProjectMigration({ cwd });
    expect(plan.status).toBe("ready");
    await applyProjectMigration({
      cwd,
      expectedRevision: plan.revision,
      preserveOverrides: true,
      onProgress: () => {},
    });
    const runtime = await createProjectRuntime({
      cwd,
      promptFiles,
      sandboxIdentity: "image",
    });
    expect(runtime.record.config.roles.implementer.effort).toBe("xhigh");
    expect(await readFile(main, "utf8")).toContain(
      'env: { effort: "low", CODEX_HOME: ".sandcastle/project-auth" }',
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 30000);

test.each([
  { profile: "reviewed", kind: "spacing" },
  { profile: "reviewed", kind: "nested-setting" },
  { profile: "reviewed", kind: "quoted-key" },
  { profile: "node", kind: "spacing" },
  { profile: "android", kind: "spacing" },
])(
  "migrated $profile workflow preserves $kind image settings at the Docker boundary",
  async ({ profile, kind }) => {
    const cwd = await fixture(profile);
    try {
      const main = join(cwd, ".sandcastle/main.ts");
      const source = (await readFile(main, "utf8"))
        .replaceAll(
          /docker\(\{/g,
          kind === "spacing"
            ? 'docker ({ imageName: "custom:legacy",'
            : kind === "quoted-key"
              ? `docker({ "imageName": 'custom:legacy',`
              : 'docker({ imageName: "custom:legacy",',
        )
        .replaceAll(
          /env: (readinessEnvironment|trackerEnvironment)/g,
          (_, env) =>
            kind === "nested-setting"
              ? `env: { ...${env}, imageName: "project-value" }`
              : `env: ${env}`,
        );
      await writeFile(main, source);
      const plan = await planProjectMigration({ cwd });
      expect(plan.status).toBe("ready");
      await applyProjectMigration({
        cwd,
        expectedRevision: plan.revision,
        preserveOverrides: true,
        onProgress: () => {},
      });
      expect((await loadEnvironmentConfig({ cwd })).image).toBe(
        "custom:legacy",
      );
      const workflow = await loadWorkflowConfig({ cwd });
      await saveWorkflowConfig({
        cwd,
        config: { ...workflow, repository: "owner/project" },
      });
      await mkdir(join(cwd, "node_modules"), { recursive: true });
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
import fs from 'node:fs'; const args=process.argv.slice(2);
fs.appendFileSync('docker-calls.jsonl', JSON.stringify(args)+'\\n');
if(args[0]==='image' && args[1]==='inspect') console.log(args.includes('{{.Config.User}}') ? '' : 'sha256:'+'d'.repeat(64));
if(args[0]==='run') { console.error('fixture stops at container launch'); process.exit(1); }
`,
      );
      for (const name of ["gh", "docker"])
        await chmod(join(cwd, "bin", name), 0o755);
      await writeFile(
        join(cwd, ".gitignore"),
        "node_modules/\nbin/\narchive/\ndocker-calls.jsonl\n.sandcastle/node_modules/\n.sandcastle/updates/\n.sandcastle/runtime/\n.sandcastle/migrations/\n",
      );
      for (const args of [
        ["init", "-qb", "main"],
        ["config", "user.name", "Fixture"],
        ["config", "user.email", "fixture@example.test"],
        ["add", "."],
        ["commit", "-qm", "consumer"],
      ])
        await exec("git", args, { cwd });
      await expect(
        exec(process.execPath, ["--import", "tsx", ".sandcastle/main.ts"], {
          cwd,
          timeout: 20000,
          env: {
            ...process.env,
            PATH: join(cwd, "bin") + ":" + process.env.PATH,
          },
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("fixture stops at container launch"),
      });
      const calls: string[][] = (
        await readFile(join(cwd, "docker-calls.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls[0]).toEqual([
        "image",
        "inspect",
        "custom:legacy",
        "--format",
        "{{.Id}}",
      ]);
      const launch = calls.find((args) => args[0] === "run")!;
      expect(launch.at(-1)).toBe("sha256:" + "d".repeat(64));
      if (kind === "nested-setting")
        expect(launch).toContain("imageName=project-value");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  30000,
);
