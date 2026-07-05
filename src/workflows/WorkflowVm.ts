import { WorkflowValidationError } from "./errors.js";
import type {
  WorkflowContext,
  WorkflowDefinition,
  WorkflowAgentInvoker,
  WorkflowBudget,
  WorkflowLogger,
  WorkflowParallelRunner,
  WorkflowPhaseReporter,
  WorkflowPipelineRunner,
  WorkflowRuntime,
  WorkflowValidator,
} from "./types.js";
import type { WorkflowQualityHelpers } from "./quality.js";

export interface LoadedWorkflowSource<Args = unknown, Result = unknown> {
  readonly definition: WorkflowDefinition<Args, Result>;
}

export interface WorkflowVmGlobals<Args = unknown> {
  readonly args: Args;
  readonly agent: WorkflowAgentInvoker;
  readonly parallel: WorkflowParallelRunner;
  readonly pipeline: WorkflowPipelineRunner;
  readonly phase: WorkflowPhaseReporter;
  readonly log: WorkflowLogger;
  readonly validate: WorkflowValidator;
  readonly quality: WorkflowQualityHelpers;
  readonly workflow: WorkflowRuntime;
  readonly budget: WorkflowBudget;
}

export type WorkflowVmContext<Args = unknown> = WorkflowVmGlobals<Args>;

export function createRestrictedWorkflowContext<Args>(
  globals: WorkflowVmGlobals<Args>,
): WorkflowContext<Args> {
  return {
    args: globals.args,
    agent: globals.agent,
    parallel: globals.parallel,
    pipeline: globals.pipeline,
    phase: globals.phase,
    log: globals.log,
    validate: globals.validate,
    quality: globals.quality,
    workflow: globals.workflow,
    budget: globals.budget,
  };
}

export async function executeWorkflowBody<Args = unknown>(
  loaded: LoadedWorkflowSource<Args>,
  globals: WorkflowVmGlobals<Args>,
): Promise<unknown> {
  const run = loaded.definition.run;

  if (typeof run !== "function") {
    throw new WorkflowValidationError(
      "Workflow definition is missing a run function.",
      {
        details: {
          path: ["definition", "run"],
          expected: "function",
          actual: typeof run,
        },
      },
    );
  }

  try {
    return await run(createRestrictedWorkflowContext(globals));
  } catch (cause) {
    throw new Error("Workflow execution failed while running definition.run.", {
      cause,
    });
  }
}
