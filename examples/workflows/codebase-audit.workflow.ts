import type { WorkflowDefinition } from "../../src/index.js";

interface CodebaseAuditArgs {
  readonly areas?: readonly string[];
}

interface AuditOutput {
  readonly area: string;
  readonly summary: string;
  readonly recommendedAction: string;
}

const auditSchema = {
  type: "object",
  required: ["area", "summary", "recommendedAction"],
  properties: {
    area: { type: "string" },
    summary: { type: "string" },
    recommendedAction: { type: "string" },
  },
  additionalProperties: false,
} as const;

const workflow = {
  meta: {
    name: "codebase-audit",
    description:
      "Audit multiple codebase areas, retry transient failures locally, and return a prioritized action list.",
    phases: [{ title: "audit" }, { title: "prioritize" }],
  },
  defaults: {
    provider: "codex",
    model: "gpt-5.5",
    sandbox: "docker",
    maxConcurrency: 3,
    maxAgents: 10,
    branchPrefix: "sandcastle/workflow",
    skills: ["repo-audit-advisory", "tdd-workflow"],
  },
  async run(ctx) {
    const areas = ctx.args.areas ?? ["runtime", "tests", "docs"];

    await ctx.phase("audit");
    const audits = await ctx.parallel(
      areas.map(
        (area) => async () =>
          ctx.quality.retry(
            () =>
              ctx.agent.run<AuditOutput>(
                `Audit the ${area} area. Return one actionable finding.`,
                {
                  label: `audit-${area}`,
                  schema: auditSchema,
                  skills: ["repo-audit-advisory"],
                },
              ),
            { retries: 2, label: `retry-audit-${area}` },
          ),
      ),
      { concurrency: 3 },
    );

    await ctx.phase("prioritize");
    const actionList = audits
      .map((audit) => audit.output)
      .filter((output): output is AuditOutput => output !== undefined)
      .map((output) => ({
        area: output.area,
        next: output.recommendedAction,
        summary: output.summary,
      }));

    return {
      audited: actionList.length,
      actionList,
      runId: ctx.workflow.id,
      remainingAgents: ctx.budget.remainingAgents(),
    };
  },
} satisfies WorkflowDefinition<CodebaseAuditArgs>;

export default workflow;
