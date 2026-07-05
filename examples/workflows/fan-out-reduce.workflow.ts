import type { WorkflowDefinition } from "../../src/index.js";

interface FanOutArgs {
  readonly items?: readonly string[];
}

interface ReviewOutput {
  readonly summary: string;
  readonly risk: "low" | "medium" | "high";
}

const reviewSchema = {
  type: "object",
  required: ["summary", "risk"],
  properties: {
    summary: { type: "string" },
    risk: { type: "string", enum: ["low", "medium", "high"] },
  },
  additionalProperties: false,
} as const;

const workflow = {
  meta: {
    name: "fan-out-reduce",
    description:
      "Review several independent items in parallel, then reduce the findings into one synthesis.",
    phases: [{ title: "review" }, { title: "reduce" }],
  },
  defaults: {
    provider: "codex",
    model: "gpt-5.5",
    sandbox: "docker",
    maxConcurrency: 3,
    maxAgents: 8,
    branchPrefix: "sandcastle/workflow",
    skills: ["coding-standards"],
  },
  async run(ctx) {
    const items = ctx.args.items ?? ["api", "worker", "docs"];

    await ctx.phase("review");
    ctx.log.info("Reviewing items in parallel", { items });

    const reviews = await ctx.parallel.agents<ReviewOutput>(
      items.map((item) => ({
        prompt: `Review the ${item} surface. Return one concise risk summary.`,
        options: {
          label: `review-${item}`,
          schema: reviewSchema,
          skills: ["coding-standards"],
        },
      })),
      { concurrency: 3 },
    );

    await ctx.phase("reduce");
    const findings = reviews.map((review, index) => ({
      item: items[index],
      status: review.status,
      branch: review.branch,
      output: review.output,
    }));

    return {
      reviewed: findings.length,
      highRisk: findings.filter((finding) => finding.output?.risk === "high"),
      findings,
    };
  },
} satisfies WorkflowDefinition<FanOutArgs>;

export default workflow;
