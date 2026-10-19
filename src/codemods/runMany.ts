/**
 * Codemod: migrate pre-split `run()` loop calls to `runMany()` (#562, ADR 0022).
 *
 * Rules, per call to `run` imported from `@ai-hero/sandcastle`
 * (`run(...)`, `sandcastle.run(...)`) and per `x.run({ agent, ... })` method
 * call (`sandbox.run` / `wt.run`):
 *
 * - Object-literal options with `maxIterations`, `completionSignal` or
 *   `completionTimeoutSeconds` (the last only without `output`) → rename the
 *   callee to `runMany` / `.runMany`. Behaviour-preserving: `runMany()`
 *   defaults `maxIterations` to 1 like the old `run()`.
 * - Loop options alongside `output` / `resumeSession` (run()-only):
 *   `maxIterations: 1` is dropped (it was a no-op); anything else gets a TODO.
 * - Calls left on one-shot `run()` whose result is bound to a variable:
 *   `r.iterations.at(-1)?.sessionId` / `r.iterations[0]!.usage` etc. →
 *   `r.sessionId` / `r.usage`; `r.iterations.length` → `1`; any other
 *   `r.iterations` / `r.completionSignal` access gets a TODO.
 * - Named imports gain `runMany` when needed and drop `run` once unused.
 *
 * Anything that can't be decided statically gets a
 * `// TODO(sandcastle-codemod): …` comment instead of a guess.
 *
 * The TypeScript compiler is passed in, so the package does not depend on it
 * at runtime — the CLI loads the caller's own `typescript`.
 */
import type * as TS from "typescript";

export const SANDCASTLE_MODULE = "@ai-hero/sandcastle";
export const TODO_PREFIX = "TODO(sandcastle-codemod):";

const LOOP_KEYS = [
  "maxIterations",
  "completionSignal",
  "completionTimeoutSeconds",
] as const;
const RUN_ONLY_KEYS = ["output", "resumeSession"] as const;
const FLAT_FIELDS = new Set(["sessionId", "sessionFilePath", "usage"]);

export interface RunManyCodemodResult {
  readonly output: string;
  readonly changed: boolean;
  /** TODO comments inserted (one per undecidable site). */
  readonly todos: readonly string[];
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const scriptKindFor = (ts: typeof TS, fileName: string): TS.ScriptKind => {
  if (/\.tsx$/i.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(fileName)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
};

export const transformRunMany = (
  ts: typeof TS,
  source: string,
  fileName = "file.ts",
): RunManyCodemodResult => {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(ts, fileName),
  );

  // --- Imports from @ai-hero/sandcastle ---------------------------------
  const namespaces = new Set<string>();
  let namedImports: TS.NamedImports | undefined;
  let runLocal: string | undefined;
  let runSpecifier: TS.ImportSpecifier | undefined;
  let runManyLocal: string | undefined;

  for (const stmt of sf.statements) {
    if (
      !ts.isImportDeclaration(stmt) ||
      !ts.isStringLiteral(stmt.moduleSpecifier) ||
      stmt.moduleSpecifier.text !== SANDCASTLE_MODULE
    )
      continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    } else {
      namedImports = bindings;
      for (const el of bindings.elements) {
        const imported = (el.propertyName ?? el.name).text;
        if (imported === "run") {
          runLocal = el.name.text;
          runSpecifier = el;
        } else if (imported === "runMany") {
          runManyLocal = el.name.text;
        }
      }
    }
  }

  // Only touch files that use Sandcastle at all.
  if (!namedImports && namespaces.size === 0) {
    return { output: source, changed: false, todos: [] };
  }

  const edits: Edit[] = [];
  const todos: string[] = [];
  const todoKeys = new Set<string>();
  const convertedCallees = new Set<TS.Node>();
  let needRunManyImport = false;
  let anyConverted = false;

  const enclosingStatement = (node: TS.Node): TS.Node => {
    let cur: TS.Node = node;
    while (
      cur.parent &&
      !(
        ts.isSourceFile(cur.parent) ||
        ts.isBlock(cur.parent) ||
        ts.isModuleBlock(cur.parent) ||
        ts.isCaseClause(cur.parent) ||
        ts.isDefaultClause(cur.parent)
      )
    ) {
      cur = cur.parent;
    }
    return cur;
  };

  const addTodo = (node: TS.Node, message: string) => {
    const stmt = enclosingStatement(node);
    const start = stmt.getStart(sf);
    const key = `${start}:${message}`;
    if (todoKeys.has(key)) return;
    todoKeys.add(key);
    // Idempotent: a previous pass already left this TODO above the statement.
    const leading = source.slice(stmt.getFullStart(), start);
    if (leading.includes(`${TODO_PREFIX} ${message}`)) return;
    const lineStart = source.lastIndexOf("\n", start - 1) + 1;
    const indent = /^[ \t]*/.exec(source.slice(lineStart, start))?.[0] ?? "";
    edits.push({
      start,
      end: start,
      text: `// ${TODO_PREFIX} ${message}\n${indent}`,
    });
    todos.push(message);
  };

  const propName = (p: TS.ObjectLiteralElementLike): string | undefined => {
    if (
      (ts.isPropertyAssignment(p) ||
        ts.isShorthandPropertyAssignment(p) ||
        ts.isMethodDeclaration(p)) &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
    ) {
      return p.name.text;
    }
    return undefined;
  };

  /** Remove an object-literal property plus its trailing comma. */
  const removeProperty = (prop: TS.ObjectLiteralElementLike) => {
    const start = prop.getFullStart();
    let end = prop.getEnd();
    const rest = source.slice(end);
    const comma = /^\s*,/.exec(rest);
    if (comma) end += comma[0].length;
    edits.push({ start, end, text: "" });
  };

  /** Variable the (awaited) call result is bound to, if a plain identifier. */
  const bindingOf = (
    call: TS.CallExpression,
  ): TS.Identifier | TS.ObjectBindingPattern | undefined => {
    let node: TS.Node = call;
    while (
      node.parent &&
      (ts.isAwaitExpression(node.parent) ||
        ts.isParenthesizedExpression(node.parent) ||
        ts.isAsExpression(node.parent) ||
        ts.isNonNullExpression(node.parent))
    ) {
      node = node.parent;
    }
    const parent = node.parent;
    if (
      parent &&
      ts.isVariableDeclaration(parent) &&
      parent.initializer === node
    ) {
      if (
        ts.isIdentifier(parent.name) ||
        ts.isObjectBindingPattern(parent.name)
      )
        return parent.name;
    }
    return undefined;
  };

  /** Rewrite `r.iterations…` / `r.completionSignal` on a one-shot result. */
  const rewriteOneShotResultAccess = (varName: string) => {
    const visit = (node: TS.Node) => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === varName
      ) {
        const field = node.name.text;
        if (field === "completionSignal") {
          addTodo(
            node,
            `run() is one-shot and no longer reports \`${varName}.completionSignal\` — use runMany() if this call needs the loop.`,
          );
          return;
        }
        if (field === "iterations") {
          if (!rewriteIterationsAccess(node, varName)) {
            addTodo(
              node,
              `one-shot run() has no \`${varName}.iterations\` — read \`${varName}.sessionId\` / \`.sessionFilePath\` / \`.usage\` directly, or switch the call to runMany().`,
            );
          }
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  };

  /**
   * `r.iterations.at(-1)?.x`, `r.iterations.at(0)!.x`, `r.iterations[0].x`
   * → `r.x`; `r.iterations.length` → `1`. Returns false when unrecognised.
   */
  const rewriteIterationsAccess = (
    iterations: TS.PropertyAccessExpression,
    varName: string,
  ): boolean => {
    const parent = iterations.parent;
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === iterations &&
      parent.name.text === "length"
    ) {
      edits.push({
        start: parent.getStart(sf),
        end: parent.getEnd(),
        text: "1",
      });
      return true;
    }
    let single: TS.Expression | undefined;
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.name.text === "at" &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent &&
      parent.parent.arguments.length === 1
    ) {
      const arg = parent.parent.arguments[0]!.getText(sf).replace(/\s/g, "");
      if (arg === "-1" || arg === "0") single = parent.parent;
    } else if (
      ts.isElementAccessExpression(parent) &&
      parent.expression === iterations &&
      parent.argumentExpression.getText(sf).trim() === "0"
    ) {
      single = parent;
    }
    if (!single) return false;
    let node: TS.Node = single;
    while (node.parent && ts.isNonNullExpression(node.parent))
      node = node.parent;
    const access = node.parent;
    if (
      access &&
      ts.isPropertyAccessExpression(access) &&
      access.expression === node &&
      FLAT_FIELDS.has(access.name.text)
    ) {
      edits.push({
        start: iterations.getStart(sf),
        end: access.getEnd(),
        text: `${varName}.${access.name.text}`,
      });
      return true;
    }
    return false;
  };

  const handleCall = (call: TS.CallExpression) => {
    const callee = call.expression;
    let kind: "top" | "method" | undefined;
    let renameTarget: TS.Identifier | undefined;

    if (ts.isIdentifier(callee) && runLocal && callee.text === runLocal) {
      kind = "top";
      renameTarget = callee;
    } else if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.name) &&
      callee.name.text === "run"
    ) {
      renameTarget = callee.name;
      if (
        ts.isIdentifier(callee.expression) &&
        namespaces.has(callee.expression.text)
      ) {
        kind = "top";
      } else {
        const arg = call.arguments[0];
        if (
          arg &&
          ts.isObjectLiteralExpression(arg) &&
          arg.properties.some((p) => propName(p) === "agent")
        ) {
          kind = "method";
        }
      }
    }
    if (!kind || !renameTarget) return;

    const arg = call.arguments[0];
    const binding = bindingOf(call);
    if (!arg || !ts.isObjectLiteralExpression(arg)) {
      if (binding && ts.isIdentifier(binding)) {
        // Options come from a variable — can't see the loop keys.
        const usesLoopResult = new RegExp(
          `\\b${binding.text}\\s*\\.\\s*(iterations|completionSignal)\\b`,
        ).test(source);
        if (usesLoopResult) {
          addTodo(
            call,
            "options aren't an object literal, so the codemod can't tell whether this call loops — if it passes maxIterations/completionSignal, rename it to runMany().",
          );
        }
      }
      return;
    }

    const props = new Map<string, TS.ObjectLiteralElementLike>();
    let hasSpread = false;
    for (const p of arg.properties) {
      if (ts.isSpreadAssignment(p)) hasSpread = true;
      const name = propName(p);
      if (name) props.set(name, p);
    }
    const hasOutput = props.has("output");
    const runOnly = RUN_ONLY_KEYS.filter((k) => props.has(k));
    const loopKeys = LOOP_KEYS.filter(
      (k) => props.has(k) && !(k === "completionTimeoutSeconds" && hasOutput),
    );

    if (loopKeys.length > 0 && runOnly.length === 0) {
      // Loop call → runMany.
      convertedCallees.add(renameTarget);
      anyConverted = true;
      if (ts.isIdentifier(callee)) {
        needRunManyImport = runManyLocal === undefined;
        edits.push({
          start: renameTarget.getStart(sf),
          end: renameTarget.getEnd(),
          text: runManyLocal ?? "runMany",
        });
      } else {
        edits.push({
          start: renameTarget.getStart(sf),
          end: renameTarget.getEnd(),
          text: "runMany",
        });
      }
      if (binding && ts.isObjectBindingPattern(binding)) {
        // Destructuring stays valid: runMany() has the old result shape.
      }
      return;
    }

    if (loopKeys.length > 0) {
      const max = props.get("maxIterations");
      const onlyMaxOne =
        loopKeys.length === 1 &&
        loopKeys[0] === "maxIterations" &&
        max !== undefined &&
        ts.isPropertyAssignment(max) &&
        max.initializer.getText(sf).trim() === "1";
      if (onlyMaxOne) {
        removeProperty(max!);
      } else {
        addTodo(
          call,
          `this call mixes the loop option ${loopKeys.join("/")} with the run()-only ${runOnly.join("/")}, and runMany() rejects ${runOnly.join("/")}. Split the loop from the one-shot part by hand.`,
        );
        return;
      }
    } else if (hasSpread) {
      if (binding && ts.isIdentifier(binding)) {
        const usesLoopResult = new RegExp(
          `\\b${binding.text}\\s*\\.\\s*(iterations|completionSignal)\\b`,
        ).test(source);
        if (usesLoopResult) {
          addTodo(
            call,
            "options include a spread, so the codemod can't tell whether this call loops — if the spread carries maxIterations/completionSignal, rename it to runMany().",
          );
        }
      }
      return;
    }

    // Stays a one-shot run(): rewrite result access.
    if (binding && ts.isIdentifier(binding)) {
      rewriteOneShotResultAccess(binding.text);
    } else if (binding && ts.isObjectBindingPattern(binding)) {
      const names = binding.elements.map((e) =>
        (e.propertyName ?? e.name).getText(sf),
      );
      if (names.includes("iterations") || names.includes("completionSignal")) {
        addTodo(
          call,
          "one-shot run() no longer returns iterations/completionSignal — destructure sessionId/sessionFilePath/usage instead, or switch the call to runMany().",
        );
      }
    }
  };

  const visitCalls = (node: TS.Node) => {
    if (ts.isCallExpression(node)) handleCall(node);
    ts.forEachChild(node, visitCalls);
  };
  visitCalls(sf);

  // `typeof run` / `typeof sandcastle.run` type queries may need to follow.
  if (anyConverted) {
    const visitTypes = (node: TS.Node) => {
      if (ts.isTypeQueryNode(node)) {
        const text = node.exprName.getText(sf);
        const last = text.split(".").pop();
        if (
          text === runLocal ||
          (last === "run" && namespaces.has(text.split(".")[0]!))
        ) {
          addTodo(
            node,
            `\`typeof ${text}\` — if this describes a call that now uses runMany(), change it to \`typeof ${text.replace(/run$/, "runMany")}\` (or use the RunManyResult type).`,
          );
        }
      }
      ts.forEachChild(node, visitTypes);
    };
    visitTypes(sf);
  }

  // --- Import specifiers ------------------------------------------------
  if (namedImports && runSpecifier && runLocal && needRunManyImport) {
    let remainingRunRefs = 0;
    const countRefs = (node: TS.Node) => {
      if (
        ts.isIdentifier(node) &&
        node.text === runLocal &&
        !convertedCallees.has(node) &&
        node !== runSpecifier!.name &&
        node !== runSpecifier!.propertyName &&
        !(
          ts.isPropertyAccessExpression(node.parent) &&
          node.parent.name === node
        ) &&
        !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)
      ) {
        remainingRunRefs++;
      }
      ts.forEachChild(node, countRefs);
    };
    countRefs(sf);

    const specs = namedImports.elements
      .filter((el) => el !== runSpecifier || remainingRunRefs > 0)
      .map((el) => el.getText(sf));
    specs.push("runMany");
    edits.push({
      start: namedImports.getStart(sf),
      end: namedImports.getEnd(),
      text: `{ ${specs.join(", ")} }`,
    });
  }

  if (edits.length === 0) return { output: source, changed: false, todos };

  // Apply back-to-front; for a shared start, the wider edit first so a
  // zero-width TODO insertion lands before the replaced text.
  const sorted = [...edits].sort((a, b) =>
    b.start !== a.start ? b.start - a.start : b.end - a.end,
  );
  let output = source;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const e of sorted) {
    if (e.end > lastStart && e.start !== e.end) continue; // overlapping — skip
    output = output.slice(0, e.start) + e.text + output.slice(e.end);
    lastStart = e.start;
  }
  return { output, changed: output !== source, todos };
};
