import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { run, type AgentProvider } from "@ai-hero/sandcastle";
import { coder, type CoderOnClose } from "@ai-hero/sandcastle/sandboxes/coder";

const execFileAsync = promisify(execFile);

const template = process.env.CODER_DOGFOOD_TEMPLATE ?? "coder";
const preset = process.env.CODER_DOGFOOD_PRESET ?? "Pittsburgh";
const suffix =
  process.env.CODER_DOGFOOD_SUFFIX ?? randomBytes(3).toString("hex");
const prefix = `sc-dogfood-${suffix}`;

interface DogfoodCase {
  readonly onClose: CoderOnClose;
  readonly workspaceName: string;
}

interface WorkspaceSummary {
  readonly id?: string;
  readonly name?: string;
  readonly owner_name?: string;
  readonly latest_build?: {
    readonly status?: string;
    readonly resources?: ReadonlyArray<{
      readonly agents?: ReadonlyArray<{
        readonly name?: string;
        readonly status?: string;
        readonly directory?: string;
      }>;
    }>;
  };
}

// Keep dogfood non-interactive for templates that have prompts with defaults.
process.env.CODER_WORKSPACE_USE_PARAMETER_DEFAULTS ??= "true";

const cases: readonly DogfoodCase[] = [
  { onClose: "stop", workspaceName: `${prefix}-stop` },
  { onClose: "delete", workspaceName: `${prefix}-delete` },
  { onClose: "leave", workspaceName: `${prefix}-leave` },
];

const dogfoodAgent = (dogfoodCase: DogfoodCase): AgentProvider => ({
  name: `coder-dogfood-${dogfoodCase.onClose}`,
  env: {},
  captureSessions: false,
  buildPrintCommand() {
    const script = [
      "set -eu",
      `echo ${JSON.stringify(`coder dogfood workspace=${dogfoodCase.workspaceName} onClose=${dogfoodCase.onClose}`)}`,
      'echo "sandbox cwd=$(pwd)"',
      "test -f package.json",
      "git rev-parse --show-toplevel >/dev/null",
      'echo "<promise>COMPLETE</promise>"',
    ].join("; ");

    return { command: `sh -lc ${JSON.stringify(script)}` };
  },
  parseStreamLine() {
    return [];
  },
});

const listDogfoodWorkspaces = async (): Promise<WorkspaceSummary[]> => {
  const { stdout } = await execFileAsync(
    "coder",
    ["list", "--all", "-o", "json"],
    {
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  const parsed = JSON.parse(stdout) as WorkspaceSummary[];
  return parsed.filter((workspace) => workspace.name?.startsWith(prefix));
};

const summarize = (
  workspace: WorkspaceSummary | undefined,
): Record<string, unknown> => ({
  id: workspace?.id,
  owner: workspace?.owner_name,
  name: workspace?.name,
  status: workspace?.latest_build?.status ?? "missing",
  agents:
    workspace?.latest_build?.resources?.flatMap(
      (resource) =>
        resource.agents?.map((agent) => ({
          name: agent.name,
          status: agent.status,
          directory: agent.directory,
        })) ?? [],
    ) ?? [],
});

console.log(`Coder dogfood template: ${template}`);
console.log(`Coder dogfood preset: ${preset || "<none>"}`);
console.log(`Coder dogfood prefix: ${prefix}`);
console.log(
  `Expected final state: ${prefix}-stop stopped, ${prefix}-delete deleted/missing, ${prefix}-leave running.`,
);

for (const dogfoodCase of cases) {
  console.log(
    `\n=== Creating ${dogfoodCase.workspaceName} with onClose=${dogfoodCase.onClose} ===`,
  );
  const result = await run({
    name: dogfoodCase.workspaceName,
    agent: dogfoodAgent(dogfoodCase),
    sandbox: coder({
      template,
      ...(preset ? { preset } : {}),
      workspaceName: dogfoodCase.workspaceName,
      onClose: dogfoodCase.onClose,
    }),
    prompt: `Dogfood the Coder provider for ${dogfoodCase.workspaceName}`,
    logging: {
      type: "file",
      path: `.sandcastle/logs/${dogfoodCase.workspaceName}.log`,
    },
    idleTimeoutSeconds: 120,
  });

  console.log(
    JSON.stringify(
      {
        workspaceName: dogfoodCase.workspaceName,
        onClose: dogfoodCase.onClose,
        completionSignal: result.completionSignal,
        iterations: result.iterations.length,
        logFilePath: result.logFilePath,
      },
      null,
      2,
    ),
  );
}

const workspaces = await listDogfoodWorkspaces();
const summary = Object.fromEntries(
  cases.map((dogfoodCase) => [
    dogfoodCase.workspaceName,
    summarize(
      workspaces.find(
        (workspace) => workspace.name === dogfoodCase.workspaceName,
      ),
    ),
  ]),
);

console.log("\n=== Final Coder workspace summary ===");
console.log(JSON.stringify(summary, null, 2));

const reportPath = `.sandcastle/logs/coder-dogfood-${suffix}.json`;
await writeFile(
  reportPath,
  `${JSON.stringify({ template, prefix, summary }, null, 2)}\n`,
);
console.log(`\nWrote report: ${reportPath}`);
