import type { WorkflowDefinition } from "../../src/index.js";

interface AdversarialReviewArgs {
  readonly proposal?: string;
}

interface CritiqueOutput {
  readonly strongestOption: string;
  readonly tradeoffs: string;
  readonly mustFix: boolean;
}

const critiqueSchema = {
  type: "object",
  required: ["strongestOption", "tradeoffs", "mustFix"],
  properties: {
    strongestOption: { type: "string" },
    tradeoffs: { type: "string" },
    mustFix: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

const workflow = {
  meta: {
    name: "adversarial-review",
    description:
      "Ask a judge agent to compare adversarial review perspectives, then verify the response plan.",
    phases: [{ title: "critique" }, { title: "verify" }],
  },
  defaults: {
    provider: "codex",
    model: "gpt-5.5",
    sandbox: "docker",
    maxConcurrency: 2,
    maxAgents: 6,
    branchPrefix: "sandcastle/workflow",
  },
  async run(ctx) {
    const proposal =
      ctx.args.proposal ?? "Ship dynamic workflows as an agent-first runtime.";

    await ctx.phase("critique");
    const critique = await ctx.quality.judgePanel<CritiqueOutput>(
      [
        { role: "security reviewer", proposal },
        { role: "runtime maintainer", proposal },
        { role: "agent-experience reviewer", proposal },
      ],
      {
        label: "adversarial-review",
        schema: critiqueSchema,
      },
    );

    await ctx.phase("verify");
    const verification = await ctx.quality.verify(
      {
        claim: "The critique has a concrete response plan.",
        critique: critique.output,
      },
      { label: "verify-response-plan" },
    );

    return {
      proposal,
      critique: critique.output,
      verification: verification.output,
    };
  },
} satisfies WorkflowDefinition<AdversarialReviewArgs>;

export default workflow;
