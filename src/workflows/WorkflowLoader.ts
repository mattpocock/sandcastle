import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Script, createContext } from "node:vm";
import ts from "typescript";
import { WorkflowLoadError, WorkflowValidationError } from "./errors.js";
import type { WorkflowDefinition, WorkflowDefaults } from "./types.js";

export interface LoadedWorkflowSource {
  definition: WorkflowDefinition;
  source: string;
  transpiledSource: string;
  sourceFile?: string;
}

export interface LoadWorkflowSourceOptions {
  source?: string;
  sourceFile?: string;
  cwd?: string;
}

const FALLBACK_DEFAULTS = {
  provider: "codex",
  model: "gpt-5.5",
  sandbox: "docker",
} satisfies Required<Pick<WorkflowDefaults, "provider" | "model" | "sandbox">>;

const BLOCKED_IDENTIFIERS = new Set([
  "process",
  "require",
  "Buffer",
  "fetch",
  "fs",
  "http",
  "https",
  "net",
  "XMLHttpRequest",
  "WebSocket",
]);

export async function loadWorkflowSource(
  options: LoadWorkflowSourceOptions,
): Promise<LoadedWorkflowSource> {
  const loadedSource = await readWorkflowSource(options);

  preflightWorkflowSource(loadedSource.source, loadedSource.sourceFile);

  const transpiledSource = transpileWorkflowSource(
    loadedSource.source,
    loadedSource.sourceFile,
  );

  const exportedDefinition = evaluateWorkflowSource(
    transpiledSource,
    loadedSource.sourceFile,
  );

  return {
    ...loadedSource,
    transpiledSource,
    definition: validateWorkflowDefinition(exportedDefinition),
  };
}

async function readWorkflowSource(options: LoadWorkflowSourceOptions): Promise<{
  source: string;
  sourceFile?: string;
}> {
  if (options.source !== undefined && options.sourceFile !== undefined) {
    throw new WorkflowLoadError(
      "Provide either workflow source or sourceFile, not both.",
    );
  }

  if (options.source === undefined && options.sourceFile === undefined) {
    throw new WorkflowLoadError("Provide workflow source or sourceFile.");
  }

  if (options.source !== undefined) {
    return { source: options.source };
  }

  const sourceFile = resolveSourceFile(options.sourceFile, options.cwd);

  try {
    return {
      source: await readFile(sourceFile, "utf8"),
      sourceFile,
    };
  } catch (cause) {
    throw new WorkflowLoadError(
      `Failed to read workflow source: ${sourceFile}`,
      {
        cause,
        details: { sourceFile },
      },
    );
  }
}

function resolveSourceFile(
  sourceFile: string | undefined,
  cwd: string | undefined,
) {
  if (sourceFile === undefined) {
    throw new WorkflowLoadError("Provide workflow sourceFile.");
  }

  return isAbsolute(sourceFile)
    ? sourceFile
    : resolve(cwd ?? process.cwd(), sourceFile);
}

function preflightWorkflowSource(
  source: string,
  sourceFile: string | undefined,
) {
  const parsedSource = ts.createSourceFile(
    sourceFile ?? "workflow.inline.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const errors: string[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && !isTypeOnlyImportDeclaration(node)) {
      errors.push("Runtime imports are not supported in workflow sources.");
    }

    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) {
      errors.push("Runtime imports are not supported in workflow sources.");
    }

    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      !node.isTypeOnly
    ) {
      errors.push(
        "Runtime exports from modules are not supported in workflow sources.",
      );
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      errors.push("Dynamic imports are not supported in workflow sources.");
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      errors.push("require() is not supported in workflow sources.");
    }

    if (ts.isIdentifier(node) && BLOCKED_IDENTIFIERS.has(node.text)) {
      errors.push(
        `Access to ${node.text} is not supported in workflow sources.`,
      );
    }

    ts.forEachChild(node, visit);
  };

  visit(parsedSource);

  if (errors.length > 0) {
    throw new WorkflowLoadError(
      "Workflow source uses unsupported runtime features.",
      {
        details: { errors: Array.from(new Set(errors)) },
      },
    );
  }
}

function isTypeOnlyImportDeclaration(node: ts.ImportDeclaration) {
  const importClause = node.importClause;
  if (importClause === undefined) {
    return false;
  }

  if (importClause.isTypeOnly) {
    return true;
  }

  if (importClause.name !== undefined) {
    return false;
  }

  const namedBindings = importClause.namedBindings;

  return (
    namedBindings !== undefined &&
    ts.isNamedImports(namedBindings) &&
    namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function transpileWorkflowSource(
  source: string,
  sourceFile: string | undefined,
) {
  const output = ts.transpileModule(source, {
    fileName: sourceFile ?? "workflow.inline.ts",
    reportDiagnostics: true,
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });

  const diagnostics = output.diagnostics?.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );

  if (diagnostics !== undefined && diagnostics.length > 0) {
    throw new WorkflowLoadError("Failed to transpile workflow source.", {
      details: { diagnostics: formatDiagnostics(diagnostics) },
    });
  }

  return output.outputText;
}

function evaluateWorkflowSource(
  transpiledSource: string,
  sourceFile: string | undefined,
) {
  const exports: Record<string, unknown> = {};
  const module = { exports };
  const context = createContext({
    exports,
    module,
  });

  try {
    const script = new Script(transpiledSource, {
      filename: sourceFile ?? "workflow.inline.js",
    });
    script.runInContext(context, { timeout: 1000 });
  } catch (cause) {
    throw new WorkflowLoadError("Failed to evaluate workflow source.", {
      cause,
      details: { message: getErrorMessage(cause), sourceFile },
    });
  }

  const moduleExports = module.exports as Record<string, unknown>;
  const defaultExport = moduleExports.default ?? exports.default;

  if (defaultExport === undefined) {
    throw new WorkflowValidationError(
      "Workflow source must default export a workflow definition.",
    );
  }

  return defaultExport;
}

function validateWorkflowDefinition(value: unknown): WorkflowDefinition {
  if (!isRecord(value)) {
    throw new WorkflowValidationError(
      "Workflow definition must be an object.",
      { details: { received: typeof value } },
    );
  }

  const meta = value.meta;
  if (!isRecord(meta)) {
    throw new WorkflowValidationError(
      "Workflow definition meta must be an object.",
    );
  }

  if (typeof meta.name !== "string" || meta.name.trim().length === 0) {
    throw new WorkflowValidationError(
      "Workflow definition meta.name must be a non-empty string.",
    );
  }

  const defaults = validateWorkflowDefaults(value.defaults);

  if (typeof value.run !== "function") {
    throw new WorkflowValidationError(
      "Workflow definition run must be a function.",
    );
  }

  return {
    ...(value as unknown as WorkflowDefinition),
    defaults: {
      ...FALLBACK_DEFAULTS,
      ...defaults,
    },
  };
}

function validateWorkflowDefaults(value: unknown): WorkflowDefaults {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    throw new WorkflowValidationError(
      "Workflow definition defaults must be an object when provided.",
    );
  }

  validateOptionalString(value.provider, "defaults.provider");
  validateOptionalString(value.model, "defaults.model");
  validateOptionalString(value.sandbox, "defaults.sandbox");
  validateOptionalString(value.branchPrefix, "defaults.branchPrefix");
  validateOptionalStringArray(value.skills, "defaults.skills");
  validateOptionalPositiveInteger(value.maxAgents, "defaults.maxAgents");
  validateOptionalPositiveInteger(
    value.maxConcurrency,
    "defaults.maxConcurrency",
  );

  return value;
}

function validateOptionalString(value: unknown, field: string) {
  if (value !== undefined && typeof value !== "string") {
    throw new WorkflowValidationError(
      `${field} must be a string when provided.`,
    );
  }
}

function validateOptionalStringArray(value: unknown, field: string) {
  if (
    value !== undefined &&
    (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
  ) {
    throw new WorkflowValidationError(
      `${field} must be an array of strings when provided.`,
    );
  }
}

function validateOptionalPositiveInteger(value: unknown, field: string) {
  if (
    value !== undefined &&
    (!Number.isInteger(value) || typeof value !== "number" || value < 1)
  ) {
    throw new WorkflowValidationError(
      `${field} must be a positive integer when provided.`,
    );
  }
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]) {
  return diagnostics.map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  );
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
