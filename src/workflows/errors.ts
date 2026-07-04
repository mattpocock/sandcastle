export interface WorkflowErrorOptions {
  readonly cause?: unknown;
  readonly details?: unknown;
}

abstract class WorkflowError extends Error {
  readonly details?: unknown;

  protected constructor(message: string, options?: WorkflowErrorOptions) {
    super(
      message,
      options === undefined ? undefined : { cause: options.cause },
    );
    this.details = options?.details;
  }
}

export class WorkflowLoadError extends WorkflowError {
  override readonly name = "WorkflowLoadError";

  constructor(
    message = "Failed to load workflow.",
    options?: WorkflowErrorOptions,
  ) {
    super(message, options);
  }
}

export class WorkflowValidationError extends WorkflowError {
  override readonly name = "WorkflowValidationError";

  constructor(
    message = "Workflow validation failed.",
    options?: WorkflowErrorOptions,
  ) {
    super(message, options);
  }
}

export class WorkflowRunNotFoundError extends WorkflowError {
  override readonly name = "WorkflowRunNotFoundError";
  readonly runId: string;

  constructor(runId: string, options?: WorkflowErrorOptions) {
    super(`Workflow run not found: ${runId}`, options);
    this.runId = runId;
  }
}

export class WorkflowStoppedError extends WorkflowError {
  override readonly name = "WorkflowStoppedError";

  constructor(
    message = "Workflow run stopped.",
    options?: WorkflowErrorOptions,
  ) {
    super(message, options);
  }
}

export class WorkflowAgentLimitError extends WorkflowError {
  override readonly name = "WorkflowAgentLimitError";

  constructor(
    message = "Workflow agent limit exceeded.",
    options?: WorkflowErrorOptions,
  ) {
    super(message, options);
  }
}

export class WorkflowSchemaValidationError extends WorkflowError {
  override readonly name = "WorkflowSchemaValidationError";

  constructor(
    message = "Workflow schema validation failed.",
    options?: WorkflowErrorOptions,
  ) {
    super(message, options);
  }
}
