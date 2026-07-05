import { WorkflowLoadError, WorkflowValidationError } from "./errors.js";
import {
  loadWorkflowSource,
  type LoadedWorkflowSource,
  type LoadWorkflowSourceOptions,
} from "./WorkflowLoader.js";
import type {
  WorkflowDiagnostic,
  WorkflowProviderName,
  WorkflowSandboxName,
  WorkflowValidationResult,
} from "./types.js";

export interface ValidateWorkflowSourceOptions
  extends LoadWorkflowSourceOptions {
  readonly allowedProviders?: readonly WorkflowProviderName[];
  readonly allowedSandboxes?: readonly WorkflowSandboxName[];
  readonly allowedSkills?: readonly string[];
  readonly maxConcurrency?: number;
  readonly maxAgents?: number;
}

export async function validateWorkflowSource(
  options: ValidateWorkflowSourceOptions,
): Promise<WorkflowValidationResult<LoadedWorkflowSource>> {
  let loaded: LoadedWorkflowSource;

  try {
    loaded = await loadWorkflowSource(options);
  } catch (error) {
    return {
      ok: false,
      errors: [diagnosticFromLoadError(error)],
      warnings: [],
    };
  }

  const errors = validateLoadedWorkflow(loaded, options);

  if (errors.length > 0) {
    return {
      ok: false,
      value: loaded,
      meta: loaded.definition.meta,
      errors,
      warnings: [],
    };
  }

  return {
    ok: true,
    value: loaded,
    meta: loaded.definition.meta,
    errors: [],
    warnings: [],
  };
}

function validateLoadedWorkflow(
  loaded: LoadedWorkflowSource,
  options: ValidateWorkflowSourceOptions,
) {
  const errors: WorkflowDiagnostic[] = [];
  const defaults = loaded.definition.defaults ?? {};

  if (
    defaults.provider !== undefined &&
    options.allowedProviders !== undefined &&
    !options.allowedProviders.includes(defaults.provider)
  ) {
    errors.push({
      code: "workflow_provider_unknown",
      message: `Workflow defaults.provider is not allowed: ${defaults.provider}`,
      path: ["defaults", "provider"],
      severity: "error",
      details: {
        received: defaults.provider,
        allowed: options.allowedProviders,
      },
    });
  }

  if (
    defaults.sandbox !== undefined &&
    options.allowedSandboxes !== undefined &&
    !options.allowedSandboxes.includes(defaults.sandbox)
  ) {
    errors.push({
      code: "workflow_sandbox_unknown",
      message: `Workflow defaults.sandbox is not allowed: ${defaults.sandbox}`,
      path: ["defaults", "sandbox"],
      severity: "error",
      details: {
        received: defaults.sandbox,
        allowed: options.allowedSandboxes,
      },
    });
  }

  if (
    defaults.maxConcurrency !== undefined &&
    options.maxConcurrency !== undefined &&
    defaults.maxConcurrency > options.maxConcurrency
  ) {
    errors.push({
      code: "workflow_limit_invalid",
      message: `Workflow defaults.maxConcurrency exceeds the host ceiling: ${defaults.maxConcurrency} > ${options.maxConcurrency}`,
      path: ["defaults", "maxConcurrency"],
      severity: "error",
      details: {
        received: defaults.maxConcurrency,
        maximum: options.maxConcurrency,
      },
    });
  }

  if (
    defaults.maxAgents !== undefined &&
    options.maxAgents !== undefined &&
    defaults.maxAgents > options.maxAgents
  ) {
    errors.push({
      code: "workflow_limit_invalid",
      message: `Workflow defaults.maxAgents exceeds the host ceiling: ${defaults.maxAgents} > ${options.maxAgents}`,
      path: ["defaults", "maxAgents"],
      severity: "error",
      details: {
        received: defaults.maxAgents,
        maximum: options.maxAgents,
      },
    });
  }

  if (
    defaults.skills !== undefined &&
    options.allowedSkills !== undefined
  ) {
    const allowedSkills = new Set(options.allowedSkills);

    defaults.skills.forEach((skill, index) => {
      if (!allowedSkills.has(skill)) {
        errors.push({
          code: "workflow_skill_unknown",
          message: `Workflow defaults.skills contains an unknown skill: ${skill}`,
          path: ["defaults", "skills", index],
          severity: "error",
          details: {
            received: skill,
            allowed: options.allowedSkills,
          },
        });
      }
    });
  }

  return errors;
}

function diagnosticFromLoadError(error: unknown): WorkflowDiagnostic {
  if (error instanceof WorkflowValidationError) {
    return {
      code: "workflow_shape_invalid",
      message: error.message,
      severity: "error",
      details: error.details,
    };
  }

  if (error instanceof WorkflowLoadError) {
    return {
      code: "workflow_load_failed",
      message: error.message,
      severity: "error",
      details: error.details,
    };
  }

  return {
    code: "workflow_load_failed",
    message: getErrorMessage(error),
    severity: "error",
  };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
