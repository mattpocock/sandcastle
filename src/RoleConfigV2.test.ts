import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  loadRoleConfig,
  migrateRoleConfig,
  operatorRoles,
  roleSetting,
  saveRoleConfig,
  type RoleConfig,
} from "./Operator.js";
import { createProjectRuntime } from "./OperatorRuntime.js";
import { buildRoleAgent } from "./RoleAgents.js";

const directories: string[] = [];
async function project() {
  const cwd = await mkdtemp(join(tmpdir(), "roles-v2-"));
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
const print = (agent: ReturnType<typeof buildRoleAgent>) =>
  agent.buildPrintCommand({ prompt: "test", dangerouslySkipPermissions: true })
    .command;
const v2 = (
  roles: Partial<Record<(typeof operatorRoles)[number], unknown>>,
): unknown => {
  const base = migrateRoleConfig(
    // Version-one defaults, explicitly converted.
    {
      schemaVersion: 1,
      revision: "",
      roles: Object.fromEntries(
        operatorRoles.map((role) => [
          role,
          { provider: "codex", model: "gpt-6.1-sol", effort: "high" },
        ]),
      ),
    } as RoleConfig,
  );
  return { ...base, roles: { ...base.roles, ...roles } };
};

test("schema version 2 saves every provider with capability-checked effort and an ordered fallback chain", async () => {
  const cwd = await project();
  const saved = await saveRoleConfig({
    cwd,
    config: v2({
      planner: {
        provider: "claudeCode",
        model: "claude-opus-5-5",
        effort: "max",
      },
      implementer: {
        provider: "codex",
        model: "gpt-6.1-sol",
        effort: "medium",
        fallback: [
          {
            provider: "claudeCode",
            model: "claude-sonnet-5-5",
            effort: "high",
          },
          { provider: "opencode", model: "xai/grok-x", effort: "high" },
          { provider: "pi", model: "google/gemini-x", effort: "minimal" },
        ],
      },
      reviewer: { provider: "copilot", model: "gpt-x", effort: "low" },
      merger: { provider: "cursor", model: "composer" },
      readiness: { provider: "opencode", model: "google/gemini-x" },
    }),
  });
  expect(saved.schemaVersion).toBe(2);
  expect(await loadRoleConfig({ cwd })).toEqual(saved);
  expect(
    roleSetting(saved, "implementer").fallback.map((t) => t.provider),
  ).toEqual(["claudeCode", "opencode", "pi"]);
  expect(roleSetting(saved, "merger")).toEqual({
    provider: "cursor",
    model: "composer",
    fallback: [],
  });
});

test("schema version 2 rejects unsupported efforts, duplicate or excessive fallbacks and unknown providers without changing the saved file", async () => {
  const cwd = await project();
  const original = await saveRoleConfig({ cwd, config: v2({}) });
  const target = { provider: "claudeCode", model: "claude-opus-5-5" };
  for (const reviewer of [
    { provider: "claudeCode", model: "claude-opus-5-5", effort: "off" },
    { provider: "pi", model: "m", effort: "max" },
    { provider: "copilot", model: "m", effort: "xhigh" },
    { provider: "cursor", model: "m", effort: "low" },
    { provider: "gemini", model: "m" },
    { provider: "opencode", model: "m", effort: "$(touch /tmp/x)" },
    {
      provider: "codex",
      model: "gpt-6.1-sol",
      effort: "high",
      fallback: [{ provider: "codex", model: "gpt-6.1-sol", effort: "high" }],
    },
    {
      provider: "codex",
      model: "gpt-6.1-sol",
      effort: "high",
      fallback: [target, target],
    },
    {
      provider: "codex",
      model: "gpt-6.1-sol",
      effort: "high",
      fallback: [
        target,
        { ...target, model: "b" },
        { ...target, model: "c" },
        { ...target, model: "d" },
      ],
    },
    {
      provider: "codex",
      model: "gpt-6.1-sol",
      effort: "high",
      fallback: [{ ...target, auth: "secret" }],
    },
  ]) {
    await expect(
      saveRoleConfig({ cwd, config: v2({ reviewer }) }),
    ).rejects.toThrow();
    expect(await loadRoleConfig({ cwd })).toEqual(original);
  }
});

test("version-one files keep loading unchanged and explicit migration preserves every role's behaviour", async () => {
  const cwd = await project();
  const v1 = await loadRoleConfig({ cwd });
  expect(v1.schemaVersion).toBe(1);
  await saveRoleConfig({ cwd, config: v1 });
  expect(await loadRoleConfig({ cwd })).toEqual(v1);
  const migrated = migrateRoleConfig(v1);
  expect(migrated.schemaVersion).toBe(2);
  expect(migrated.revision).not.toBe(v1.revision);
  for (const role of operatorRoles) {
    expect(roleSetting(migrated, role)).toEqual(roleSetting(v1, role));
    expect(print(buildRoleAgent(roleSetting(migrated, role)))).toBe(
      print(buildRoleAgent(roleSetting(v1, role))),
    );
  }
  await saveRoleConfig({ cwd, config: migrated });
  expect(await loadRoleConfig({ cwd })).toEqual(migrated);
});

test("each provider receives its model, mapped effort flag and only its own project options", () => {
  const options = {
    env: { CODEX_ONLY: "1" },
    providers: { claudeCode: { env: { CLAUDE_ONLY: "1" } } },
  };
  const claude = buildRoleAgent(
    { provider: "claudeCode", model: "claude-opus-5-5", effort: "max" },
    options,
  );
  expect(claude.name).toBe("claude-code");
  expect(print(claude)).toContain("claude-opus-5-5");
  expect(print(claude)).toContain("max");
  expect(claude.env).toEqual({ CLAUDE_ONLY: "1" });
  const codexAgent = buildRoleAgent(
    { provider: "codex", model: "gpt-6.1-sol", effort: "xhigh" },
    options,
  );
  expect(codexAgent.env).toEqual({ CODEX_ONLY: "1" });
  expect(print(codexAgent)).toContain('model_reasoning_effort="xhigh"');
  expect(
    print(buildRoleAgent({ provider: "pi", model: "m", effort: "minimal" })),
  ).toContain("--thinking minimal");
  expect(
    buildRoleAgent({
      provider: "opencode",
      model: "xai/grok-x",
      effort: "high",
    }).name,
  ).toBe("opencode");
  expect(buildRoleAgent({ provider: "cursor", model: "composer" }).env).toEqual(
    {},
  );
});

test("runtime builds configured providers and exposes the frozen fallback chain", async () => {
  const cwd = await project();
  const promptPath = join(cwd, "prompt.md");
  await writeFile(promptPath, "prompt");
  await saveRoleConfig({
    cwd,
    config: v2({
      reviewer: {
        provider: "claudeCode",
        model: "claude-opus-5-5",
        effort: "high",
        fallback: [{ provider: "codex", model: "gpt-6.1-sol", effort: "high" }],
      },
    }),
  });
  const runtime = await createProjectRuntime({
    cwd,
    sandboxIdentity: "sha256:test",
    promptFiles: Object.fromEntries(
      operatorRoles.map((role) => [role, promptPath]),
    ) as Record<(typeof operatorRoles)[number], string>,
  });
  expect(runtime.agent("reviewer").name).toBe("claude-code");
  expect(runtime.agent("implementer").name).toBe("codex");
  expect(
    runtime.agentChain("reviewer").map((entry) => entry.agent.name),
  ).toEqual(["claude-code", "codex"]);
  expect(runtime.roleSetting("reviewer").fallback).toHaveLength(1);
});

test("runtime.agent attaches the configured fallback chain; roles without fallback stay plain providers", async () => {
  const { agentChainOf } = await import("./AgentFallback.js");
  const cwd = await project();
  const promptPath = join(cwd, "prompt.md");
  await writeFile(promptPath, "prompt");
  await saveRoleConfig({
    cwd,
    config: v2({
      implementer: {
        provider: "codex",
        model: "gpt-6.1-sol",
        effort: "low",
        fallback: [
          {
            provider: "claudeCode",
            model: "claude-sonnet-5-5",
            effort: "high",
          },
        ],
      },
    }),
  });
  const runtime = await createProjectRuntime({
    cwd,
    sandboxIdentity: "sha256:test",
    promptFiles: Object.fromEntries(
      operatorRoles.map((role) => [role, promptPath]),
    ) as Record<(typeof operatorRoles)[number], string>,
  });
  expect(
    agentChainOf(runtime.agent("implementer")).map((e) => e.target),
  ).toEqual([
    { provider: "codex", model: "gpt-6.1-sol", effort: "low" },
    { provider: "claudeCode", model: "claude-sonnet-5-5", effort: "high" },
  ]);
  expect(agentChainOf(runtime.agent("reviewer"))).toHaveLength(1);
});
