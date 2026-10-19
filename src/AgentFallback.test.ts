import { expect, test } from "vitest";
import { codex } from "./AgentProvider.js";
import {
  agentChainOf,
  classifyProviderFailure,
  withAgentFallback,
} from "./AgentFallback.js";

test("classifies provider and infrastructure failures, never task failures", () => {
  expect(classifyProviderFailure("HTTP 429 Too Many Requests")).toBe(
    "rate-limit",
  );
  expect(classifyProviderFailure("You have hit your usage limit")).toBe(
    "rate-limit",
  );
  expect(classifyProviderFailure("error: model gpt-x not found")).toBe(
    "model-unavailable",
  );
  expect(classifyProviderFailure("Not logged in. Please log in")).toBe(
    "authentication",
  );
  expect(
    classifyProviderFailure(
      "codex exited with code 127:\nsh: codex: command not found",
    ),
  ).toBe("missing-cli");
  expect(classifyProviderFailure("503 Service Unavailable")).toBe(
    "unavailable",
  );
  expect(classifyProviderFailure("ECONNRESET")).toBe("unavailable");
  for (const message of [
    "codex exited with code 1:\nTests failed: 3",
    "TypeError: cannot read properties of undefined",
    "merge conflict in src/index.ts",
  ])
    expect(classifyProviderFailure(message)).toBeNull();
});

test("a provider without fallback is its own single-entry chain and is returned unchanged", () => {
  const primary = codex("gpt-6.1-sol");
  expect(
    withAgentFallback({ agent: primary, target: { provider: "codex" } }, []),
  ).toBe(primary);
  expect(agentChainOf(primary)).toEqual([
    { agent: primary, target: { provider: "codex" } },
  ]);
});

test("a chained provider behaves like its primary and exposes the ordered chain", () => {
  const primary = codex("gpt-6.1-sol", { effort: "high" });
  const second = codex("gpt-5.4");
  const chained = withAgentFallback(
    { agent: primary, target: { provider: "codex", model: "gpt-6.1-sol" } },
    [{ agent: second, target: { provider: "codex", model: "gpt-5.4" } }],
  );
  const opts = { prompt: "x", dangerouslySkipPermissions: true };
  expect(chained.name).toBe("codex");
  expect(chained.buildPrintCommand(opts)).toEqual(
    primary.buildPrintCommand(opts),
  );
  expect(agentChainOf(chained).map((entry) => entry.target.model)).toEqual([
    "gpt-6.1-sol",
    "gpt-5.4",
  ]);
  expect(Object.keys(chained)).toEqual(Object.keys(primary));
});
