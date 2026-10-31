// The public API report: every export of every package.json `exports` entry
// point, with its type, as API Extractor reads it from the built .d.ts files.
// One report per entry point, committed under api-report/. CODEOWNERS makes
// Matt the owner, so any change to the public surface gets his review.
//
//   npm run api:report          rewrite the reports from dist (build first)
//   npm run api:report -- --check   fail if a report is stale (CI)
//
// See .sandcastle/CODING_STANDARDS.md, "Where tests live": the public API is
// never extended or loosened to suit tests.

import path from "node:path";
import type { IConfigFile } from "@microsoft/api-extractor";
import {
  Extractor,
  ExtractorConfig,
  ExtractorLogLevel,
} from "@microsoft/api-extractor";
import pkg from "../package.json" with { type: "json" };

const ROOT = path.resolve(import.meta.dirname, "..");
const REPORT_FOLDER = path.join(ROOT, "api-report");

/** `.` -> `index`, `./sandboxes/docker` -> `sandboxes/docker`. */
const entryName = (subpath: string): string =>
  subpath === "." ? "index" : subpath.slice(2);

const configFor = (subpath: string): IConfigFile => {
  const name = entryName(subpath);
  return {
    projectFolder: ROOT,
    mainEntryPointFilePath: path.join(ROOT, "dist", `${name}.d.ts`),
    bundledPackages: [],
    compiler: {
      overrideTsconfig: {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          lib: ["ES2022"],
          types: ["node"],
          strict: true,
          skipLibCheck: true,
        },
        files: [`dist/${name}.d.ts`],
      },
    },
    apiReport: {
      enabled: true,
      reportFileName: `${name.replaceAll("/", "-")}.api.md`,
      reportFolder: REPORT_FOLDER,
      reportTempFolder: path.join(ROOT, "node_modules", ".api-report"),
    },
    docModel: { enabled: false },
    dtsRollup: { enabled: false },
    tsdocMetadata: { enabled: false },
    messages: {
      // The report records the surface; doc-comment style is not its job.
      tsdocMessageReporting: { default: { logLevel: ExtractorLogLevel.None } },
      extractorMessageReporting: {
        default: { logLevel: ExtractorLogLevel.Warning },
        "ae-missing-release-tag": { logLevel: ExtractorLogLevel.None },
        "ae-undocumented": { logLevel: ExtractorLogLevel.None },
        "ae-unresolved-link": { logLevel: ExtractorLogLevel.None },
        "ae-forgotten-export": {
          logLevel: ExtractorLogLevel.None,
          addToApiReportFile: true,
        },
      },
      compilerMessageReporting: {
        default: { logLevel: ExtractorLogLevel.Warning },
      },
    },
  };
};

const check = process.argv.includes("--check");

const stale = Object.keys(pkg.exports).filter((subpath) => {
  const config = ExtractorConfig.prepare({
    configObject: configFor(subpath),
    configObjectFullPath: path.join(ROOT, "api-extractor.json"),
    packageJsonFullPath: path.join(ROOT, "package.json"),
  });
  const result = Extractor.invoke(config, {
    localBuild: !check,
    showVerboseMessages: false,
  });
  return !result.succeeded || result.apiReportChanged;
});

if (check && stale.length > 0) {
  process.stderr.write(
    `The API report is stale for: ${stale.map((s) => entryName(s)).join(", ")}. The public API changed; run \`npm run build && npm run api:report\` and commit api-report/. Never extend or loosen the public API to suit a test.\n`,
  );
  process.exitCode = 1;
}
