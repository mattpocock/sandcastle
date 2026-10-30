import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { codex } from "./AgentProvider.js";
import { withAgentFallback } from "./AgentFallback.js";
import { credentialsToUnset, scopeCommand } from "./CredentialScope.js";
import { buildRoleAgent } from "./RoleAgents.js";

test("a role-configured provider keeps only its own agent credentials", () => {
  const codexUnset = credentialsToUnset(
    buildRoleAgent({ provider: "codex", model: "m" }),
  );
  expect(codexUnset).not.toContain("OPENAI_API_KEY");
  expect(codexUnset).not.toContain("CODEX_API_KEY");
  expect(codexUnset).toEqual(
    expect.arrayContaining([
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "GEMINI_API_KEY",
      "CURSOR_API_KEY",
    ]),
  );
  const claudeUnset = credentialsToUnset(
    buildRoleAgent({ provider: "claudeCode", model: "m" }),
  );
  expect(claudeUnset).toContain("OPENAI_API_KEY");
  expect(claudeUnset).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
  const piUnset = credentialsToUnset(
    buildRoleAgent({ provider: "pi", model: "google/gemini-x" }),
  );
  expect(piUnset).not.toContain("GEMINI_API_KEY");
  expect(piUnset).not.toContain("XAI_API_KEY");
  expect(piUnset).toEqual(
    expect.arrayContaining(["CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY"]),
  );
  for (const unset of [codexUnset, claudeUnset, piUnset]) {
    expect(unset).not.toContain("GH_TOKEN");
    expect(unset).not.toContain("GITHUB_TOKEN");
  }
});

test("providers built outside role configuration are unscoped; fallback copies keep the primary scope", () => {
  expect(credentialsToUnset(codex("m"))).toEqual([]);
  const primary = buildRoleAgent({ provider: "claudeCode", model: "m" });
  const chained = withAgentFallback(
    { agent: primary, target: { provider: "claudeCode" } },
    [
      {
        agent: buildRoleAgent({ provider: "codex", model: "m" }),
        target: { provider: "codex" },
      },
    ],
  );
  expect(credentialsToUnset(chained)).toEqual(credentialsToUnset(primary));
});

test("the scoped command really removes the variables in a shell", () => {
  const command = scopeCommand(
    `sh -c 'echo "\${ANTHROPIC_API_KEY-unset} \${OPENAI_API_KEY-unset}"'`,
    ["ANTHROPIC_API_KEY"],
  );
  expect(command.startsWith("env -u ANTHROPIC_API_KEY ")).toBe(true);
  const output = execFileSync("sh", ["-c", command], {
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "secret-a",
      OPENAI_API_KEY: "secret-o",
    },
    encoding: "utf8",
  });
  expect(output.trim()).toBe("unset secret-o");
  expect(scopeCommand("codex exec", [])).toBe("codex exec");
});
