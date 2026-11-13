import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "..");
const apiReportDir = path.join(root, "api-report");

const packageJson: unknown = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
);

const declaredPackages = (field: string): string[] => {
  if (typeof packageJson !== "object" || packageJson === null) {
    return [];
  }
  const value: unknown = Reflect.get(packageJson, field);
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.keys(value);
};

const IMPORT_PATTERN = /^import .* from '(?<specifier>[^']+)';$/gmu;

const packageName = (specifier: string): string => {
  const parts = specifier.split("/");
  return specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : (parts[0] ?? specifier);
};

const publicTypeImports = (): string[] => {
  const names = new Set<string>();
  for (const file of readdirSync(apiReportDir)) {
    if (!file.endsWith(".api.md")) {
      continue;
    }
    const report = readFileSync(path.join(apiReportDir, file), "utf8");
    for (const match of report.matchAll(IMPORT_PATTERN)) {
      const specifier = match.groups?.specifier;
      if (specifier === undefined || specifier.startsWith("node:")) {
        continue;
      }
      names.add(packageName(specifier));
    }
  }
  return [...names];
};

describe("public type surface", () => {
  it("only imports packages that consumers install", () => {
    const installed = new Set([
      ...declaredPackages("dependencies"),
      ...declaredPackages("peerDependencies"),
    ]);
    const imports = publicTypeImports();

    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((name) => !installed.has(name))).toStrictEqual([]);
  });
});
