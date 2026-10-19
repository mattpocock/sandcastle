import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  claudeCode,
  codex,
  copilot,
  cursor,
  opencode,
  pi,
} from "./AgentProvider.js";
import {
  loadRoleConfig,
  migrateRoleConfig,
  operatorRoles,
  roleSetting,
  saveRoleConfig,
  type RoleConfig,
} from "./Operator.js";
import { createProjectRuntime } from "./OperatorRuntime.js";
import { loadWorkflowConfig, saveWorkflowConfig } from "./OperatorWorkflow.js";
import {
  applyCrossProviderReviewPreset,
  ensureProviderInstructions,
  reviewProviderConflict,
} from "./ReviewProviders.js";

const directories: string[] = [];
async function project() {
  const cwd = await mkdtemp(join(tmpdir(), "review-providers-"));
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
const withRoles = (base: RoleConfig, roles: Record<string, unknown>) => {
  const v2 = migrateRoleConfig(base);
  return { ...v2, roles: { ...v2.roles, ...roles } } as unknown as RoleConfig;
};
const codexRole = { provider: "codex", model: "gpt-6.1-sol", effort: "high" };
const claudeRole = {
  provider: "claudeCode",
  model: "claude-opus-5-5",
  effort: "high",
};

test("conflict detection covers primaries and fallbacks in both directions", async () => {
  const base = await loadRoleConfig({ cwd: await project() });
  expect(reviewProviderConflict(base)).toMatch(/both run on codex/);
  expect(
    reviewProviderConflict(withRoles(base, { reviewer: claudeRole })),
  ).toBeNull();
  expect(
    reviewProviderConflict(
      withRoles(base, { implementer: claudeRole, reviewer: codexRole }),
    ),
  ).toBeNull();
  const viaFallback = reviewProviderConflict(
    withRoles(base, { reviewer: { ...claudeRole, fallback: [codexRole] } }),
  );
  expect(viaFallback).toMatch(/codex/);
  expect(viaFallback).toMatch(/reviewer: claudeCode -> codex/);
  expect(viaFallback).toMatch(/roles\.json/);
});

test("the cross-provider preset changes only the reviewer and never shares the implementer provider", async () => {
  const cwd = await project();
  const base = await loadRoleConfig({ cwd });
  const preset = applyCrossProviderReviewPreset(base);
  expect(roleSetting(preset, "reviewer")).toMatchObject({
    provider: "claudeCode",
    model: "claude-opus-5-5",
  });
  for (const role of operatorRoles.filter((r) => r !== "reviewer"))
    expect(roleSetting(preset, role)).toEqual(roleSetting(base, role));
  expect(reviewProviderConflict(preset)).toBeNull();
  expect(await saveRoleConfig({ cwd, config: preset })).toEqual(preset);
  const reversed = applyCrossProviderReviewPreset(
    withRoles(base, { implementer: claudeRole }),
  );
  expect(roleSetting(reversed, "reviewer").provider).toBe("codex");
  expect(reviewProviderConflict(reversed)).toBeNull();
  expect((await loadRoleConfig({ cwd: await project() })).schemaVersion).toBe(
    1,
  );
});

test("run admission enforces review.requireDifferentProvider only when enabled", async () => {
  const cwd = await project();
  const prompt = join(cwd, "prompt.md");
  await writeFile(prompt, "prompt");
  const options = {
    cwd,
    sandboxIdentity: "sha256:test",
    promptFiles: Object.fromEntries(
      operatorRoles.map((role) => [role, prompt]),
    ) as Record<(typeof operatorRoles)[number], string>,
  };
  await expect(createProjectRuntime(options)).resolves.toBeDefined();
  const workflow = await loadWorkflowConfig({ cwd });
  expect(workflow.review).toBeUndefined();
  await saveWorkflowConfig({
    cwd,
    config: { ...workflow, review: { requireDifferentProvider: true } },
  });
  await expect(createProjectRuntime(options)).rejects.toThrow(
    /requireDifferentProvider/,
  );
  const base = await loadRoleConfig({ cwd });
  for (const [implementer, reviewer] of [
    [codexRole, claudeRole],
    [claudeRole, codexRole],
  ]) {
    await saveRoleConfig({
      cwd,
      config: withRoles(base, { implementer, reviewer }),
    });
    const runtime = await createProjectRuntime(options);
    expect(runtime.agent("implementer").name).not.toBe(
      runtime.agent("reviewer").name,
    );
  }
  await saveRoleConfig({
    cwd,
    config: withRoles(base, {
      implementer: codexRole,
      reviewer: { ...claudeRole, fallback: [codexRole] },
    }),
  });
  await expect(createProjectRuntime(options)).rejects.toThrow(/fallback|codex/);
});

test("Claude Code roles get a CLAUDE.md importing AGENTS.md, without touching an existing CLAUDE.md", async () => {
  const cwd = await project();
  const base = await loadRoleConfig({ cwd });
  const claude = withRoles(base, { reviewer: claudeRole });
  expect(await ensureProviderInstructions({ cwd, config: base })).toBe(
    "not-needed",
  );
  expect(await ensureProviderInstructions({ cwd, config: claude })).toBe(
    "no-agents-md",
  );
  await writeFile(join(cwd, "AGENTS.md"), "# Project rules\n");
  expect(await ensureProviderInstructions({ cwd, config: claude })).toBe(
    "created",
  );
  const created = await readFile(join(cwd, "CLAUDE.md"), "utf8");
  expect(created).toMatch(/^@AGENTS\.md$/m);
  expect(created).not.toContain("Project rules");
  expect(await ensureProviderInstructions({ cwd, config: claude })).toBe(
    "already-linked",
  );
  await writeFile(join(cwd, "CLAUDE.md"), "# Own instructions\n");
  expect(await ensureProviderInstructions({ cwd, config: claude })).toBe(
    "claude-md-unlinked",
  );
  expect(await readFile(join(cwd, "CLAUDE.md"), "utf8")).toBe(
    "# Own instructions\n",
  );
});

test("every supported provider's stream parser surfaces the review completion signal", () => {
  const signal = "Review approved. <promise>COMPLETE</promise>";
  const samples = [
    [
      claudeCode("m"),
      {
        type: "assistant",
        message: { content: [{ type: "text", text: signal }] },
      },
    ],
    [claudeCode("m"), { type: "result", result: signal }],
    [
      cursor("m"),
      {
        type: "assistant",
        message: { content: [{ type: "text", text: signal }] },
      },
    ],
    [
      codex("m"),
      { type: "item.completed", item: { type: "agent_message", text: signal } },
    ],
    [
      pi("m"),
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: signal },
      },
    ],
    [opencode("m"), { type: "text", part: { type: "text", text: signal } }],
    [copilot("m"), { type: "assistant.message", data: { content: signal } }],
  ] as const;
  for (const [provider, event] of samples) {
    const text = provider
      .parseStreamLine(JSON.stringify(event))
      .map((parsed) =>
        parsed.type === "text"
          ? parsed.text
          : parsed.type === "result"
            ? parsed.result
            : "",
      )
      .join("");
    expect(text, provider.name).toContain("<promise>COMPLETE</promise>");
  }
});

test("bundled review and implementation prompts contain no provider-specific instructions", async () => {
  const templates = join(import.meta.dirname, "templates");
  for (const template of await readdir(templates)) {
    let files: string[] = [];
    try {
      files = (await readdir(join(templates, template))).filter((name) =>
        name.endsWith("-prompt.md"),
      );
    } catch {
      continue;
    }
    for (const file of files) {
      const text = await readFile(join(templates, template, file), "utf8");
      expect(text, `${template}/${file}`).not.toMatch(
        /\b(codex|claude|gpt-|anthropic|openai|gemini|grok|copilot|cursor)\b/i,
      );
    }
  }
});

test("Agent Map records distinct implementer and reviewer providers", async () => {
  const { startDashboard } = await import("./AgentMap.js");
  const cwd = await project();
  const prompt = join(cwd, "prompt.md");
  await writeFile(prompt, "prompt");
  await saveRoleConfig({
    cwd,
    config: applyCrossProviderReviewPreset(await loadRoleConfig({ cwd })),
  });
  const runtime = await createProjectRuntime({
    cwd,
    sandboxIdentity: "sha256:test",
    promptFiles: Object.fromEntries(
      operatorRoles.map((role) => [role, prompt]),
    ) as Record<(typeof operatorRoles)[number], string>,
  });
  const map = await runtime.createAgentMap("Cross-provider review");
  for (const role of ["implementer", "reviewer"] as const)
    await map.track(
      { batch: 1, role, title: role, branch: "main" },
      async () => ({}),
    );
  const server = await startDashboard({ cwd, port: 0 });
  try {
    const snapshot = (await fetch(`${server.url}/api/runs/${map.id}`).then(
      (r) => r.json(),
    )) as {
      nodes: { role: string; provider?: string; model?: string }[];
    };
    const byRole = Object.fromEntries(
      snapshot.nodes.map((node) => [node.role, node]),
    );
    expect(byRole.implementer).toMatchObject({
      provider: "codex",
      model: "gpt-6.1-sol",
    });
    expect(byRole.reviewer).toMatchObject({
      provider: "claudeCode",
      model: "claude-opus-5-5",
    });
  } finally {
    await map.finish("completed");
    await server.close();
  }
});
