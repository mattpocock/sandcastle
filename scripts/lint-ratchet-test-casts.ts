// The pure half of `ratchet/test-type-assertion`: an `as T` or `<T>x` type
// assertion in an end-to-end test (tests/). scripts/lint-ratchet-sources.ts
// reads the files; the test ratchet counts them in scripts/test-baseline.json.
//
// A cast tells the compiler a value's type instead of building a value of
// that type, so a test can pass while the shape it checks drifts from the
// public API's. `as const` only narrows a literal, and is allowed.

import ts from "typescript";

const isConstAssertion = (type: ts.TypeNode): boolean =>
  ts.isTypeReferenceNode(type) &&
  ts.isIdentifier(type.typeName) &&
  type.typeName.text === "const";

/** How many type assertions other than `as const` `source` has. */
export const typeAssertionCount = (
  source: string,
  fileName: string,
): number => {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
      !isConstAssertion(node.type)
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return count;
};
