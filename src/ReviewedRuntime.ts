import { Effect } from "effect";
import { InitError } from "./errors.js";

/** Internal static rewrite of top-level image options; nested project settings remain byte-for-byte intact. */
export const rewriteSandboxImages = (
  content: string,
  engine: string,
  image: string | null,
) => {
  // Keep offsets while hiding punctuation in strings and comments. Never evaluate
  // consumer expressions, including template literals.
  const commentsHidden = content.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    (token) =>
      token.startsWith("//") || token.startsWith("/*")
        ? " ".repeat(token.length)
        : token,
  );
  const masked = commentsHidden.replace(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    (token) => " ".repeat(token.length),
  );
  const calls = [...masked.matchAll(new RegExp(`\\b${engine}\\s*\\(`, "g"))];
  const edits: { start: number; end: number; value: string }[] = [];
  const images: (string | null)[] = [];
  for (const call of calls) {
    const start = call.index + call[0].length;
    if (edits.some((edit) => start >= edit.start && start < edit.end))
      return { supported: false, content, images };
    const brace = masked.indexOf("{", start);
    if (brace < 0 || masked.slice(start, brace).trim())
      return { supported: false, content, images };
    let depth = 0,
      part = brace + 1,
      end = part;
    const properties: { start: number; end: number; separator: boolean }[] = [];
    for (; end < masked.length; end++) {
      const char = masked[end]!;
      if (char === "}" && depth === 0) break;
      if (char === "," && depth === 0) {
        properties.push({ start: part, end, separator: true });
        part = end + 1;
      }
      if ("{[(".includes(char)) depth++;
      if ("}])".includes(char)) depth--;
    }
    if (end === masked.length || !/^\s*\)/.test(masked.slice(end + 1)))
      return { supported: false, content, images };
    properties.push({ start: part, end, separator: false });
    let selected: string | null = null;
    let inner = content.slice(brace + 1, end);
    for (const property of properties.reverse()) {
      const text = commentsHidden.slice(property.start, property.end).trim();
      if (!text) continue;
      // Only plain data keys are statically known. Spreads, accessors and
      // computed/escaped keys can override the frozen image when executed.
      const key =
        /^(?:([A-Za-z_$][A-Za-z0-9_$]*)|"([^"\\\r\n]*)"|'([^'\\\r\n]*)')\s*:/.exec(
          text,
        );
      if (!key) return { supported: false, content, images };
      if ((key[1] ?? key[2] ?? key[3]) !== "imageName") continue;
      const literal = /^(?:"([^"\\\r\n]*)"|'([^'\\\r\n]*)')$/.exec(
        text.slice(key[0].length).trim(),
      );
      if (!literal || selected !== null)
        return { supported: false, content, images };
      selected = literal[1] ?? literal[2]!;
      const from = property.start - brace - 1;
      const to = property.end - brace - 1 + Number(property.separator);
      inner = inner.slice(0, from) + inner.slice(to);
    }
    images.push(selected);
    edits.push({
      start: brace + 1,
      end,
      value: (image === null ? "" : ` imageName: ${image},`) + inner,
    });
  }
  for (const edit of edits.reverse())
    content =
      content.slice(0, edit.start) + edit.value + content.slice(edit.end);
  return { supported: true, content, images };
};

/** Internal static reader: only literal models and top-level effort settings are discoverable without executing project code. */
export const readLegacyRoleCall = (args: string) => {
  const match = /^"([^"\\]+)"(?:,\s*(\{.*\}))?$/.exec(args.trim());
  let supported = match !== null;
  const model = match?.[1] ?? null;
  const options = match?.[2] ?? null;
  let effort: "low" | "medium" | "high" | "xhigh" | null = null;
  let remaining = options;
  if (options) {
    let depth = 1,
      position = 1,
      keyExpected = true;
    let removal: [number, number] | null = null;
    while (position < options.length && depth && supported) {
      const rest = options.slice(position);
      const char = options[position]!;
      if (/\s/.test(char)) {
        position++;
        continue;
      }
      if (depth === 1 && keyExpected && char !== "}") {
        const key =
          /^(?:"([A-Za-z_][A-Za-z0-9_]*)"|'([A-Za-z_][A-Za-z0-9_]*)'|([A-Za-z_][A-Za-z0-9_]*))\s*:\s*/.exec(
            rest,
          );
        if (!key) {
          supported = false;
          break;
        }
        const start = position;
        position += key[0].length;
        keyExpected = false;
        if ((key[1] ?? key[2] ?? key[3]) === "effort") {
          const value =
            /^(?:"(low|medium|high|xhigh)"|'(low|medium|high|xhigh)')\s*(?=[,}])/.exec(
              options.slice(position),
            );
          if (!value || removal) {
            supported = false;
            break;
          }
          effort = (value[1] ?? value[2]) as NonNullable<typeof effort>;
          position += value[0].length;
          removal = [start, position + (options[position] === "," ? 1 : 0)];
        }
        continue;
      }
      const literal =
        /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/.exec(rest);
      if (literal) {
        position += literal[0].length;
        continue;
      }
      if ("{[(".includes(char)) depth++;
      if ("}])".includes(char)) depth--;
      if (char === "," && depth === 1) keyExpected = true;
      position++;
    }
    if (depth !== 0) supported = false;
    if (removal)
      remaining = options.slice(0, removal[0]) + options.slice(removal[1]);
  }
  return { supported, model, effort, options: remaining };
};

/** Internal static wiring shared by initialization and recognized consumer migration. */
export const wireReviewedRuntime = (original: string, provider: string) =>
  Effect.gen(function* () {
    let content = original;
    // Preserve project-owned provider session options, without retaining role settings in copied code.
    const isolated = content.includes("const codexAgent =");
    if (isolated) {
      content = content.replace(
        /const codexAgent = \(effort:[\s\S]*?\n  \}\);/,
        "",
      );
    }
    const roles = ["readiness", "planner", "implementer", "reviewer", "merger"];
    let index = 0;
    let supported = true;
    content = content.replace(
      /agent: (?:sandcastle\.codex\([^\n]*\)|codexAgent\([^\n]*\)),/g,
      (call) => {
        const role = roles[index++];
        const session = isolated
          ? ", { sessionStorage: { hostSessionsDir: `\${CODEX_HOME_HOST}/sessions`, sandboxSessionsDir: `\${CODEX_HOME_SANDBOX}/sessions` } }"
          : (() => {
              const args = /sandcastle\.codex\((.*)\)/.exec(call)?.[1] ?? "";
              const settings = readLegacyRoleCall(args);
              supported &&= settings.supported;
              return settings.options ? ", " + settings.options : "";
            })();
        return `agent: runtime.agent("${role}"${session}),`;
      },
    );
    if (index !== roles.length || !supported)
      return yield* Effect.fail(
        new InitError({
          message:
            "Reviewed workflow role anchors changed; refusing incomplete runtime wiring",
        }),
      );
    for (const [role, file] of [
      ["planner", "plan"],
      ["implementer", "implement"],
      ["reviewer", "review"],
      ["merger", "merge"],
      ["readiness", "readiness"],
    ]) {
      content = content.replace(
        `promptFile: "./.sandcastle/${file}-prompt.md"`,
        `promptFile: runtime.promptFile("${role}")`,
      );
    }
    const engine = provider;
    const imageBased = engine === "docker" || engine === "podman";
    if (imageBased) {
      if (engine === "podman")
        content = content.replace(
          `import { ${engine} }`,
          `import { ${engine}, defaultImageName }`,
        );
      const rewritten = rewriteSandboxImages(
        content,
        engine,
        "runtime.record.sandboxIdentity",
      );
      if (!rewritten.supported)
        return yield* Effect.fail(
          new InitError({
            message: "Sandbox image settings require manual adaptation",
          }),
        );
      content = rewritten.content;
    }
    const inputs = `{
  cwd: process.cwd(),
  promptFiles: {
    planner: ".sandcastle/plan-prompt.md", implementer: ".sandcastle/implement-prompt.md",
    reviewer: ".sandcastle/review-prompt.md", merger: ".sandcastle/merge-prompt.md",
    readiness: ".sandcastle/readiness-prompt.md",
  },
  sandboxIdentity: ${
    imageBased
      ? `(await runHost("${engine}", ["image", "inspect", ${engine === "docker" ? "(await sandcastle.loadEnvironmentConfig({ cwd: process.cwd() })).image" : "defaultImageName(process.cwd())"}, "--format", "{{.Id}}"])).trim()`
      : JSON.stringify(engine)
  },
}`;
    const runtime = `const runtime = process.env.SANDCASTLE_RUNTIME_ID
  ? await sandcastle.openProjectRuntime({ cwd: process.cwd(), id: process.env.SANDCASTLE_RUNTIME_ID })
  : await sandcastle.createProjectRuntime(${inputs});

`;
    content = content.replace(
      "const MAX_ITERATIONS = 10;",
      runtime + "const MAX_ITERATIONS = runtime.workflow.config.limits.cycles;",
    );
    content = content.replace(
      "        console.log(\n          `Local implementation is complete;",
      '        await runtime.reportOutcome({code:"qualification-pending",issues:qualification});\n        console.log(\n          `Local implementation is complete;',
    );
    content = content.replace(
      '      await agentMap.finishBatch(iteration);\n      throw new Error(\n        "No verified implementation progress.',
      '      await agentMap.finishBatch(iteration);\n      await runtime.reportOutcome({code:"no-progress",issues:issues.map(issue => Number(issue.id))});\n      throw new Error(\n        "No verified implementation progress.',
    );
    content = content.replace(
      '  throw new Error(\n    "Iteration limit reached;',
      '  await runtime.reportOutcome({code:"iteration-limit",issues:[]});\n  throw new Error(\n    "Iteration limit reached;',
    );
    content = content.replace(
      "async function executeWorkflow() {",
      'async function executeWorkflow() {\n  if (!readiness.repository) throw new Error("Explicit repository required; configure owner/repository in operator Workflow settings before starting.");',
    );
    content = content.replace(
      "const MAX_PLANNER_ATTEMPTS = 3;",
      "const MAX_PLANNER_ATTEMPTS = runtime.workflow.config.limits.plannerAttempts;",
    );
    content = content.replace(
      "const READINESS_FULL_EVERY = 5;",
      "const READINESS_FULL_EVERY = runtime.workflow.config.readiness.fullEvery ?? 5;",
    );
    content = content.replace(
      'const MERGE_MODE: "batch" | "per-branch" = "batch";',
      'const MERGE_MODE: "batch" | "per-branch" = runtime.workflow.config.merge?.mode ?? "batch";',
    );
    content = content.replace(
      "const TASK_RETRIES = 1;",
      "const TASK_RETRIES = runtime.workflow.config.limits.taskRetries ?? 1;",
    );
    content = content.replace(
      "const PROVIDER_FAILURE_THRESHOLD = 3;",
      "const PROVIDER_FAILURE_THRESHOLD = runtime.workflow.config.limits.consecutiveProviderFailures ?? 3;",
    );
    content = content.replace(
      "    if (breaker.open) {\n      await agentMap.finishBatch(iteration);\n",
      '    if (breaker.open) {\n      await agentMap.finishBatch(iteration);\n      await runtime.reportOutcome({code:"provider-unavailable",issues:issues.map(issue => Number(issue.id))});\n',
    );
    content = content.replace(
      "const MAX_REPAIR_ROUNDS = 2;",
      "const MAX_REPAIR_ROUNDS = runtime.workflow.config.review?.maxRepairRounds ?? 2;",
    );
    content = content.replace(
      /const readiness = z[\s\S]*?\.parse\(JSON\.parse\(readFileSync\("\.sandcastle\/readiness\.json", "utf8"\)\)\);/,
      "const readiness = runtime.readiness;",
    );
    content = content.replace(
      /verify: readiness\.verifyCommand[\s\S]*?: undefined,/,
      "verify: runtime.workflow.config.readiness.verifier ? input => runtime.verifyReadiness(input) : undefined,",
    );
    content = content.replace(
      "const settled = await Promise.allSettled(\n      issues.map(async (issue) => {",
      "const settled = await runtime.settleIssues(issues, async (issue) => {",
    );
    content = content.replace(
      "      }),\n    );\n\n    // Log any agents",
      "      },\n    );\n\n    // Log any agents",
    );
    content = content.replace(
      /const agentMap = await sandcastle\.createAgentMap\(\{[\s\S]*?\}\);/,
      'const agentMap = await runtime.createAgentMap("Parallel planner with review");',
    );
    return content;
  });
