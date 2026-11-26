import { FileSystem } from "@effect/platform";
import { Effect, Option, Schema } from "effect";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Package manager detection (internal — not part of public API)
// ---------------------------------------------------------------------------

const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;

/** A package manager Sandcastle can detect on the host and build install commands for. */
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

// Lockfiles checked in priority order. bun.lock / bun.lockb are both valid bun
// lockfiles (text vs binary), so both map to bun.
const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

const PackageJson = Schema.parseJson(
  Schema.Record({ key: Schema.String, value: Schema.Unknown }),
);

/**
 * The host project's package.json, or None when it is missing, unreadable, or
 * not a JSON object.
 */
export const readHostPackageJson = (
  repoDir: string,
): Effect.Effect<
  Option.Option<Record<string, unknown>>,
  never,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pkgPath = join(repoDir, "package.json");
    const exists = yield* fs
      .exists(pkgPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return Option.none();
    }
    const content = yield* fs
      .readFileString(pkgPath)
      .pipe(Effect.orElseSucceed(() => ""));
    return Schema.decodeUnknownOption(PackageJson)(content);
  });

/**
 * Detect the host project's package manager. An explicit corepack-style
 * `packageManager` field in package.json wins; otherwise the first matching
 * lockfile decides. Defaults to npm when nothing matches.
 */
export const detectPackageManager = (
  repoDir: string,
): Effect.Effect<PackageManager, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    // A missing or malformed package.json falls through to lockfile detection.
    const pkg = yield* readHostPackageJson(repoDir);
    const field = Option.getOrUndefined(pkg)?.["packageManager"];
    if (typeof field === "string") {
      const [name] = field.split("@");
      const match = PACKAGE_MANAGERS.find((pm) => pm === name);
      if (match) {
        return match;
      }
    }

    for (const [file, pm] of LOCKFILES) {
      const exists = yield* fs
        .exists(join(repoDir, file))
        .pipe(Effect.orElseSucceed(() => false));
      if (exists) {
        return pm;
      }
    }

    return "npm";
  });

/** Build the command that adds a runtime dependency for the given package manager. */
export const addDependencyCommand = (
  packageManager: PackageManager,
  pkg: string,
): string => {
  switch (packageManager) {
    case "pnpm": {
      return `pnpm add ${pkg}`;
    }
    case "yarn": {
      return `yarn add ${pkg}`;
    }
    case "bun": {
      return `bun add ${pkg}`;
    }
    case "npm": {
      return `npm install ${pkg}`;
    }
  }
};

/**
 * Whether the host package.json already declares `pkg` in any of its dependency
 * maps. Used so init doesn't tell you to install something already present.
 */
export const hostHasDependency = (
  repoDir: string,
  pkg: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const parsed = yield* readHostPackageJson(repoDir);
    if (Option.isNone(parsed)) {
      return false;
    }
    const depMaps = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ];
    return depMaps.some((key) => {
      const deps = parsed.value[key];
      return typeof deps === "object" && deps !== null && pkg in deps;
    });
  });
