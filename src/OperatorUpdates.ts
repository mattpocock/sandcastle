import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { writePrivateRecord } from "./writePrivateRecord.js";
import { join, resolve, dirname } from "node:path";
import { z } from "zod";
import { rcompare, valid } from "semver";
import { OperatorError } from "./Operator.js";

const packageName = z
  .string()
  .regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/);
const releaseVersion = z.string().refine((value) => valid(value) !== null);
const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    package: packageName,
    registry: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          (url.protocol === "https:" ||
            (url.protocol === "http:" &&
              ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
        );
      }, "Use HTTPS or a loopback registry without embedded credentials"),
    channel: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]*$/),
    manifest: z.enum(["package.json", ".sandcastle/package.json"]),
    dependency: packageName,
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("registry") }).strict(),
      z
        .object({ kind: z.literal("archive"), path: z.string().min(1) })
        .strict(),
    ]),
  })
  .strict();
const provenanceSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.string().url(),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    version: z.string(),
  })
  .strict();
/** Explicit project-owned fork identity and installation destination. Never accepted from browser requests. */
export type RuntimeUpdateConfig = z.infer<typeof configSchema>;
/** Reviewable runtime candidate; installation never migrates project workflows or prompts. */
export interface RuntimeCandidate {
  /** Configured package identity. */ package: string;
  /** Exact package version. */ version: string;
  /** Registry archive or pinned local archive. */ archive: string;
  /** SHA-512 npm archive integrity. */ integrity: string;
  /** Source-qualified release provenance. */ provenance: z.infer<
    typeof provenanceSchema
  >;
  /** Release notes carried by the candidate. */ changelog: string;
}
/** Installed package evidence, including unqualified legacy archives which may be replaced explicitly. */
export interface RuntimeInstallation extends Omit<
  RuntimeCandidate,
  "provenance"
> {
  /** Null for legacy packages without source-qualified release metadata. */ provenance:
    | RuntimeCandidate["provenance"]
    | null;
}
/** Shared CLI/web install plan. */
export interface RuntimeUpdatePlan {
  /** Digest binding the reviewed target and current consumer manifest/lock. */ revision: string;
  /** Project-owned identity, source and destination. */ config: RuntimeUpdateConfig;
  /** Installed runtime evidence from the selected manifest and lock. */ installed: RuntimeInstallation | null;
  /** Exact available candidate. */ target: RuntimeCandidate;
  /** Archive sources never track npm channels. */ pinned: boolean;
  /** Package replacement only; project migration is separate. */ action:
    | "install"
    | "update"
    | "current";
}
const fail = (message: string) => Effect.fail(new OperatorError({ message }));
const parse = <T>(run: () => T, message: string) =>
  Effect.try({ try: run, catch: () => new OperatorError({ message }) });
const json = (text: string) =>
  parse(() => JSON.parse(text), "Invalid runtime update JSON");
const normalized = (path: string) => path.replace(/\\/g, "/");
const safePath = (fs: FileSystem.FileSystem, root: string, path: string) =>
  Effect.gen(function* () {
    const relative = normalized(path).slice(normalized(root).length);
    if (
      !normalized(path).startsWith(normalized(root) + "/") &&
      normalized(path) !== normalized(root)
    )
      return yield* fail("Runtime update path escapes selected project");
    let current = root;
    for (const part of relative.split("/").filter(Boolean)) {
      current = join(current, part);
      if (
        (yield* fs.exists(current)) &&
        normalized(yield* fs.realPath(current)) !== normalized(current)
      )
        return yield* fail("Runtime update paths must not be symbolic links");
    }
    return path;
  });
const context = (cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(resolve(cwd));
    const path = yield* safePath(
      fs,
      root,
      join(root, ".sandcastle", "updates.json"),
    );
    if (!(yield* fs.exists(path)))
      return yield* fail(
        "Configure .sandcastle/updates.json with explicit fork package, registry, channel, source and manifest first",
      );
    const value = yield* json(yield* fs.readFileString(path));
    const config = yield* parse(
      () => configSchema.parse(value),
      "Invalid runtime update configuration; use explicit package, registry, channel, dependency, source and manifest",
    );
    const directory = dirname(
      yield* safePath(fs, root, join(root, config.manifest)),
    );
    return { fs, root, config, directory };
  });
const npm = (cwd: string, args: string[]) =>
  Effect.async<string, OperatorError>((resume) => {
    const child = execFile(
      process.platform === "win32" ? "npm.cmd" : "npm",
      args,
      { cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        resume(
          error
            ? fail(
                "npm runtime operation failed; check registry authentication, network, package compatibility and disk permissions. Original installation retained; inspect the private update record.",
              )
            : Effect.succeed(stdout),
        );
      },
    );
    return Effect.sync(() => child.kill());
  });
const registryArgs = (config: RuntimeUpdateConfig): string[] => [
  "--registry",
  config.registry,
  // npm scope mappings take precedence over its default registry setting.
  ...(config.package.startsWith("@")
    ? [`--${config.package.split("/")[0]}:registry=${config.registry}`]
    : []),
];
const candidate = (metadata: unknown, config: RuntimeUpdateConfig) =>
  parse(() => {
    const data = z
      .object({
        name: z.string(),
        version: releaseVersion,
        dist: z.object({
          tarball: z.string(),
          integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+=*$/),
        }),
        sandcastleRuntime: provenanceSchema,
        sandcastleChangelog: z.string().optional(),
        description: z.string().optional(),
      })
      .parse(metadata);
    if (
      data.name !== config.package ||
      data.sandcastleRuntime.version !== data.version
    )
      throw new OperatorError({
        message: "Candidate identity/provenance mismatch",
      });
    if (config.source.kind === "registry") {
      const url = new URL(data.dist.tarball),
        registry = new URL(config.registry);
      if (
        url.origin !== registry.origin ||
        url.username ||
        url.password ||
        url.hash ||
        url.search
      )
        throw new OperatorError({
          message: "Archive must use the configured registry origin",
        });
    }
    return {
      package: data.name,
      version: data.version,
      archive: data.dist.tarball,
      integrity: data.dist.integrity,
      provenance: data.sandcastleRuntime,
      changelog:
        data.sandcastleChangelog ??
        data.description ??
        "No release notes supplied",
    };
  }, "Candidate must match the configured fork and carry versioned source/integrity metadata");
const readInstalled = (
  fs: FileSystem.FileSystem,
  root: string,
  directory: string,
  config: RuntimeUpdateConfig,
) =>
  Effect.gen(function* () {
    const path = yield* safePath(
      fs,
      root,
      join(
        directory,
        "node_modules",
        ...config.dependency.split("/"),
        "package.json",
      ),
    );
    if (!(yield* fs.exists(path))) return null;
    const metadata = yield* json(yield* fs.readFileString(path));
    const data = yield* parse(
      () =>
        z
          .object({
            name: packageName,
            version: z.string().min(1),
            sandcastleRuntime: provenanceSchema.nullish(),
            sandcastleChangelog: z.string().optional(),
            description: z.string().optional(),
          })
          .parse(metadata),
      "Invalid installed runtime metadata; reconcile the installed package before updating",
    );
    const lockPath = yield* safePath(
      fs,
      root,
      join(directory, "package-lock.json"),
    );
    if (!(yield* fs.exists(lockPath)))
      return yield* fail(
        "Installed runtime has no package lock; reconcile before updating",
      );
    const lock = yield* json(yield* fs.readFileString(lockPath));
    const record = yield* parse(
      () =>
        z
          .object({
            version: z.string().min(1),
            resolved: z.string().min(1),
            integrity: z.string().min(1),
          })
          .parse(lock.packages?.["node_modules/" + config.dependency]),
      "Installed runtime does not match its package lock; reconcile before updating",
    );
    if (record.version !== data.version)
      return yield* fail(
        "Installed runtime does not match its package lock; reconcile before updating",
      );
    const provenance = data.sandcastleRuntime ?? null;
    if (provenance && provenance.version !== data.version)
      return yield* fail(
        "Invalid installed runtime provenance version; reconcile before updating",
      );
    return {
      package: data.name,
      version: data.version,
      archive: record.resolved,
      integrity: record.integrity,
      provenance,
      changelog:
        data.sandcastleChangelog ??
        data.description ??
        "Legacy runtime; no release notes supplied",
    };
  });
const planEffect = (cwd: string, selection: string | null) =>
  Effect.gen(function* () {
    const { fs, root, config, directory } = yield* context(cwd);
    const manifest = join(directory, "package.json");
    if (yield* fs.exists(manifest)) {
      const data = yield* json(yield* fs.readFileString(manifest));
      if (
        config.manifest === "package.json" &&
        !data.dependencies?.[config.dependency] &&
        !data.devDependencies?.[config.dependency]
      )
        return yield* fail(
          "Root installation requires a declared runtime dependency; choose the isolated automation manifest for a new install",
        );
    } else if (config.manifest === "package.json")
      return yield* fail("Root package.json is missing");
    const installed = yield* readInstalled(fs, root, directory, config);
    let target: RuntimeCandidate;
    if (config.source.kind === "archive") {
      if (selection !== null)
        return yield* fail(
          "Local archive is pinned; change the project-owned archive path to select another version",
        );
      const archive = resolve(root, config.source.path);
      const bytes = yield* fs.readFile(archive);
      const metadata = yield* parse(() => {
        const tar = gunzipSync(bytes, { maxOutputLength: 134217728 });
        for (let offset = 0; offset + 512 <= tar.length; ) {
          const name = tar
            .subarray(offset, offset + 100)
            .toString()
            .replace(/\0.*$/s, "");
          const size = Number.parseInt(
            tar
              .subarray(offset + 124, offset + 136)
              .toString()
              .replace(/\0.*$/s, "")
              .trim(),
            8,
          );
          if (!Number.isFinite(size) || size < 0) break;
          if (name === "package/package.json")
            return JSON.parse(
              tar.subarray(offset + 512, offset + 512 + size).toString(),
            );
          offset += 512 + Math.ceil(size / 512) * 512;
        }
        throw new OperatorError({
          message: "Archive package manifest missing",
        });
      }, "Invalid pinned npm archive");
      target = yield* candidate(
        {
          ...metadata,
          dist: {
            tarball: archive,
            integrity:
              "sha512-" + createHash("sha512").update(bytes).digest("base64"),
          },
        },
        config,
      );
    } else {
      const version = selection ?? config.channel;
      if (
        !/^[A-Za-z0-9*~^<>=][A-Za-z0-9._*+~^<>=| -]*$/.test(version) ||
        version.length > 128
      )
        return yield* fail("Select a version, npm tag or semver constraint");
      const output = yield* npm(root, [
        "view",
        config.package + "@" + version,
        "--json",
        ...registryArgs(config),
        "--fetch-retries=0",
        "--fetch-timeout=10000",
      ]);
      const metadata = yield* json(output);
      const releases = yield* parse(
        () =>
          z
            .array(z.object({ version: releaseVersion }).passthrough())
            .parse(Array.isArray(metadata) ? metadata : [metadata])
            .sort((a, b) => rcompare(a.version, b.version)),
        "Configured fork returned invalid version metadata",
      );
      const selected = releases[0];
      if (!selected)
        return yield* fail("Configured fork has no matching release");
      target = yield* candidate(selected, config);
    }
    const lockPath = yield* safePath(
      fs,
      root,
      join(directory, "package-lock.json"),
    );
    const revision = createHash("sha256")
      .update(
        JSON.stringify({
          config,
          installed,
          target,
          manifest: (yield* fs.exists(manifest))
            ? yield* fs.readFileString(manifest)
            : null,
          lock: (yield* fs.exists(lockPath))
            ? yield* fs.readFileString(lockPath)
            : null,
        }),
      )
      .digest("hex");
    return {
      revision,
      config,
      installed,
      target,
      pinned: config.source.kind === "archive",
      action:
        installed === null
          ? "install"
          : installed.package === target.package &&
              installed.version === target.version &&
              installed.integrity === target.integrity &&
              JSON.stringify(installed.provenance) ===
                JSON.stringify(target.provenance)
            ? "current"
            : "update",
    } satisfies RuntimeUpdatePlan;
  });
const run = <T, E>(effect: Effect.Effect<T, E, FileSystem.FileSystem>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.mapError((error) =>
        error instanceof OperatorError
          ? error
          : new OperatorError({
              message:
                "Cannot read or write runtime update state; check project paths and permissions",
            }),
      ),
      Effect.provide(NodeFileSystem.layer),
    ),
  );
/** Resolve only the explicitly configured fork; dry-run never modifies the consumer manifest/lock. */
export const planRuntimeUpdate = (options: {
  /** Selected host project. */ cwd: string;
  /** Version/tag/constraint, or configured channel with null. */ version:
    | string
    | null;
}): Promise<RuntimeUpdatePlan> => run(planEffect(options.cwd, options.version));

/** Internal guard shared by runtime installation and project migration. */
export const assertInactive = (fs: FileSystem.FileSystem, root: string) =>
  Effect.gen(function* () {
    // Unknown/stale running recordings require reconciliation, never an override from the browser.
    for (const folder of ["runs"]) {
      const path = join(root, ".sandcastle", folder);
      if (!(yield* fs.exists(path))) continue;
      yield* safePath(fs, root, path);
      for (const file of yield* fs.readDirectory(path)) {
        if (!file.endsWith(".json")) continue;
        const record = yield* json(
          yield* fs.readFileString(yield* safePath(fs, root, join(path, file))),
        );
        if (record.status === "running" || record.owner)
          return yield* fail(
            "Active or unreconciled project run; finish/reconcile it before installing or rolling back the runtime",
          );
      }
    }
    const common = yield* Effect.async<string | null, OperatorError>(
      (resume) => {
        execFile(
          "git",
          ["rev-parse", "--git-common-dir"],
          { cwd: root, encoding: "utf8", timeout: 10000 },
          (error, stdout, stderr) => {
            resume(
              error
                ? /not a git repository/i.test(stderr)
                  ? Effect.succeed(null)
                  : fail(
                      "Cannot inspect project recovery ownership; reconcile Git access before updating",
                    )
                : Effect.succeed(stdout.trim()),
            );
          },
        );
      },
    );
    if (common !== null) {
      const gitRoot = yield* fs.realPath(resolve(root, common));
      const recovery = yield* safePath(
        fs,
        gitRoot,
        join(gitRoot, "sandcastle", "recovery"),
      );
      if (yield* fs.exists(recovery))
        for (const branch of yield* fs.readDirectory(recovery)) {
          const folder = yield* safePath(fs, gitRoot, join(recovery, branch));
          if (yield* fs.exists(join(folder, "ownership-claim")))
            return yield* fail(
              "Active or unreconciled project run; finish/reconcile it before installing or rolling back the runtime",
            );
          for (const file of yield* fs.readDirectory(folder))
            if (file.endsWith(".json")) {
              const record = yield* json(
                yield* fs.readFileString(
                  yield* safePath(fs, gitRoot, join(folder, file)),
                ),
              );
              if (record.owner || record.status === "running")
                return yield* fail(
                  "Active or unreconciled project run; finish/reconcile it before installing or rolling back the runtime",
                );
            }
        }
    }
  });
const journalSchema = z
  .object({
    id: z.string().uuid(),
    manifest: z.enum(["package.json", ".sandcastle/package.json"]),
    status: z.enum([
      "staging",
      "promoting",
      "completed",
      "failed",
      "rolled-back",
    ]),
    target: z.unknown(),
    previous: z.unknown(),
    original: z.object({
      manifest: z.boolean(),
      lock: z.boolean(),
      modules: z.boolean(),
    }),
    promoted: z.array(
      z.enum(["package.json", "package-lock.json", "node_modules"]),
    ),
    error: z.string().optional(),
  })
  .strict();
type Journal = z.infer<typeof journalSchema>;
const storage = (fs: FileSystem.FileSystem, root: string) =>
  Effect.gen(function* () {
    const directory = yield* safePath(
      fs,
      root,
      join(root, ".sandcastle", "updates"),
    );
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const ignore = yield* safePath(fs, root, join(directory, ".gitignore"));
    yield* writePrivateRecord(fs, ignore, "*\n");
    return directory;
  });
const saveJournal = (
  fs: FileSystem.FileSystem,
  path: string,
  journal: Journal,
) => writePrivateRecord(fs, path, JSON.stringify(journal, null, 2) + "\n");
const exclusive = <A, E>(
  fs: FileSystem.FileSystem,
  directory: string,
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.acquireUseRelease(
    fs
      .writeFileString(join(directory, "operation.lock"), String(process.pid), {
        flag: "wx",
        mode: 0o600,
      })
      .pipe(
        Effect.mapError(
          () =>
            new OperatorError({
              message:
                "Runtime operation is locked; reconcile any interrupted installation before retrying",
            }),
        ),
      ),
    () => effect,
    () => fs.remove(join(directory, "operation.lock")).pipe(Effect.orDie),
  );
const restore = (
  fs: FileSystem.FileSystem,
  root: string,
  directory: string,
  backup: string,
  journal: Journal,
) =>
  Effect.gen(function* () {
    for (const name of [...journal.promoted].reverse()) {
      const target = yield* safePath(fs, root, join(directory, name));
      const saved = yield* safePath(fs, root, join(backup, name));
      if (name === "node_modules") {
        if (!journal.original.modules || (yield* fs.exists(saved))) {
          if (yield* fs.exists(target))
            yield* fs.remove(target, { recursive: true });
          if (journal.original.modules) yield* fs.rename(saved, target);
        }
      } else {
        const existed =
          name === "package.json"
            ? journal.original.manifest
            : journal.original.lock;
        if (existed)
          yield* writePrivateRecord(
            fs,
            target,
            yield* fs.readFileString(saved),
          );
        else if (yield* fs.exists(target)) yield* fs.remove(target);
      }
    }
  });
/** Stage a real npm install, verify exports/version/provenance and lock integrity, then promote with retained rollback evidence. */
export const installRuntimeUpdate = (options: {
  /** Selected host project. */ cwd: string;
  /** Selected version or configured channel with null. */ version:
    | string
    | null;
  /** Bind a browser action to its reviewed plan; null lets the CLI resolve immediately. */ expectedRevision:
    | string
    | null;
  /** Safe phase notifications, never npm output/credentials. */ onProgress: (
    phase: string,
  ) => void;
}): Promise<{ installed: RuntimeCandidate; record: string }> =>
  run(
    Effect.gen(function* () {
      const { fs, root, config, directory } = yield* context(options.cwd);
      const store = yield* storage(fs, root);
      return yield* exclusive(
        fs,
        store,
        Effect.gen(function* () {
          yield* assertInactive(fs, root);
          const latest = join(store, "latest.json");
          if (yield* fs.exists(latest)) {
            const prior = yield* fs
              .readFileString(latest)
              .pipe(
                Effect.flatMap((text) =>
                  parse(
                    () => journalSchema.parse(JSON.parse(text)),
                    "Invalid update record",
                  ),
                ),
              );
            if (prior.status === "promoting" || prior.status === "staging")
              return yield* fail(
                "An interrupted update needs --rollback before a new installation",
              );
          }
          options.onProgress("Resolving configured fork");
          const plan = yield* planEffect(root, options.version);
          if (JSON.stringify(config) !== JSON.stringify(plan.config))
            return yield* fail(
              "Runtime identity changed; preview the project configuration again",
            );
          const baseline = new Map<string, string | null>();
          for (const name of ["package.json", "package-lock.json"]) {
            const path = join(directory, name);
            baseline.set(
              name,
              (yield* fs.exists(path)) ? yield* fs.readFileString(path) : null,
            );
          }
          if (
            options.expectedRevision !== null &&
            options.expectedRevision !== plan.revision
          )
            return yield* fail(
              "Runtime update plan changed; preview it again before installing",
            );
          const id = randomUUID(),
            work = join(store, id),
            stage = join(work, "stage"),
            backup = join(work, "backup");
          yield* fs.makeDirectory(stage, { recursive: true, mode: 0o700 });
          yield* fs.makeDirectory(backup, { mode: 0o700 });
          const original = {
            manifest: yield* fs.exists(join(directory, "package.json")),
            lock: yield* fs.exists(join(directory, "package-lock.json")),
            modules: yield* fs.exists(join(directory, "node_modules")),
          };
          const journal: Journal = {
            id,
            manifest: config.manifest,
            status: "staging",
            target: plan.target,
            previous: plan.installed,
            original,
            promoted: [],
          };
          const save = () =>
            saveJournal(fs, latest, journal).pipe(
              Effect.zipRight(
                saveJournal(fs, join(work, "record.json"), journal),
              ),
            );
          yield* save();
          const operation = Effect.gen(function* () {
            for (const name of ["package.json", "package-lock.json"])
              if (yield* fs.exists(join(directory, name))) {
                yield* safePath(fs, root, join(directory, name));
                yield* fs.copyFile(join(directory, name), join(stage, name));
                yield* fs.copyFile(join(directory, name), join(backup, name));
              }
            if (!original.manifest)
              yield* fs.writeFileString(
                join(stage, "package.json"),
                JSON.stringify({
                  private: true,
                  type: "module",
                  devDependencies: {},
                }),
              );
            // Preserve project npm authentication privately; never render it or npm's raw output.
            for (const path of [
              join(root, ".npmrc"),
              join(directory, ".npmrc"),
            ])
              if (yield* fs.exists(path)) {
                yield* safePath(fs, root, path);
                yield* fs.copyFile(path, join(stage, ".npmrc"));
                yield* fs.chmod(join(stage, ".npmrc"), 0o600);
              }
            const manifest = yield* json(
              yield* fs.readFileString(join(stage, "package.json")),
            );
            const section = manifest.dependencies?.[config.dependency]
              ? "dependencies"
              : "devDependencies";
            const spec =
              config.source.kind === "archive"
                ? "file:" + plan.target.archive
                : "npm:" + config.package + "@" + plan.target.version;
            manifest[section] = {
              ...manifest[section],
              [config.dependency]: spec,
            };
            yield* fs.writeFileString(
              join(stage, "package.json"),
              JSON.stringify(manifest, null, 2) + "\n",
            );
            const stageLock = join(stage, "package-lock.json");
            if (yield* fs.exists(stageLock)) {
              const lock = yield* json(yield* fs.readFileString(stageLock));
              // Resolve the reviewed runtime anew, even when a legacy package has
              // the same version. Keep unrelated dependencies locked.
              if (lock.packages)
                delete lock.packages["node_modules/" + config.dependency];
              if (lock.dependencies)
                delete lock.dependencies[config.dependency];
              yield* fs.writeFileString(
                stageLock,
                JSON.stringify(lock, null, 2) + "\n",
              );
            }
            options.onProgress(
              "Installing in isolated staging directory (lifecycle scripts disabled)",
            );
            yield* npm(stage, [
              "install",
              "--prefix",
              stage,
              "--global=false",
              "--workspaces=false",
              "--ignore-scripts",
              "--no-audit",
              "--no-fund",
              ...registryArgs(config),
              "--fetch-retries=0",
              "--fetch-timeout=10000",
            ]);
            options.onProgress(
              "Verifying installed exports, version, source and archive integrity",
            );
            const installed = yield* readInstalled(fs, root, stage, config);
            if (
              !installed ||
              installed.package !== plan.target.package ||
              installed.version !== plan.target.version ||
              (config.source.kind === "registry" &&
                installed.archive !== plan.target.archive) ||
              installed.integrity !== plan.target.integrity ||
              JSON.stringify(installed.provenance) !==
                JSON.stringify(plan.target.provenance)
            )
              return yield* fail(
                "Installed runtime version/source/integrity verification failed; original installation retained",
              );
            const packageDirectory = join(
              stage,
              "node_modules",
              ...config.dependency.split("/"),
            );
            for (const file of [
              "LICENSE",
              "runtime-source.json",
              "dist/main.js",
              "dist/index.js",
              "dist/index.d.ts",
              "dist/templates/parallel-planner-with-review/implement-prompt.md",
            ])
              if (!(yield* fs.exists(join(packageDirectory, file))))
                return yield* fail(
                  "Installed runtime is missing required CLI/UI/default/license/source assets",
                );
            const sourceMetadata = yield* json(
              yield* fs.readFileString(
                join(packageDirectory, "runtime-source.json"),
              ),
            );
            const source = yield* parse(
              () => provenanceSchema.parse(sourceMetadata),
              "Invalid installed source metadata",
            );
            if (JSON.stringify(source) !== JSON.stringify(installed.provenance))
              return yield* fail(
                "Installed source metadata does not match release provenance",
              );
            yield* Effect.async<void, OperatorError>((resume) => {
              execFile(
                process.execPath,
                [
                  "--input-type=module",
                  "-e",
                  `const sdk=await import(${JSON.stringify(config.dependency)}); if(sdk.runtimeVersion!==${JSON.stringify(installed.version)} || ['startOperator','openProjectRuntime','planRuntimeUpdate','installRuntimeUpdate'].some(name=>typeof sdk[name]!=='function')) process.exit(1);`,
                ],
                { cwd: stage, timeout: 30000 },
                (error) =>
                  resume(
                    error
                      ? fail(
                          "Installed runtime exports/version verification failed; original installation retained",
                        )
                      : Effect.void,
                  ),
              );
            });
            yield* assertInactive(fs, root);
            const currentConfig = yield* context(root);
            if (JSON.stringify(currentConfig.config) !== JSON.stringify(config))
              return yield* fail(
                "Runtime identity changed during installation; original installation retained",
              );
            for (const [name, previous] of baseline) {
              const path = yield* safePath(fs, root, join(directory, name));
              const current = (yield* fs.exists(path))
                ? yield* fs.readFileString(path)
                : null;
              if (current !== previous)
                return yield* fail(
                  "Consumer manifest/lock changed during staging; host edits and original installation retained. Preview again before installing.",
                );
            }
            options.onProgress(
              "Promoting verified manifest, lock and runtime; retaining rollback metadata",
            );
            journal.status = "promoting";
            yield* save();
            for (const name of [
              "node_modules",
              "package.json",
              "package-lock.json",
            ] as const) {
              yield* safePath(fs, root, join(directory, name));
              journal.promoted.push(name);
              yield* save();
              if (name === "node_modules") {
                if (original.modules)
                  yield* fs.rename(join(directory, name), join(backup, name));
                yield* fs.rename(join(stage, name), join(directory, name));
              } else
                yield* writePrivateRecord(
                  fs,
                  join(directory, name),
                  yield* fs.readFileString(join(stage, name)),
                );
            }
            journal.status = "completed";
            yield* save();
            yield* saveJournal(fs, join(store, "rollback.json"), journal);
            options.onProgress(
              "Completed; project workflow and customization preserved",
            );
            return {
              installed: plan.target,
              record: join(work, "record.json"),
            };
          });
          return yield* operation.pipe(
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                yield* restore(fs, root, directory, backup, journal);
                journal.status = "failed";
                journal.error =
                  error instanceof OperatorError
                    ? error.message
                    : "Runtime installation failed; original installation restored";
                yield* save();
                return yield* fail(journal.error);
              }),
            ),
          );
        }),
      );
    }),
  );

/** Restore the previous manifest, lock and node_modules from the latest retained update record. */
export const rollbackRuntimeUpdate = (options: {
  /** Selected project. */ cwd: string;
}): Promise<void> =>
  run(
    Effect.gen(function* () {
      const { fs, root } = yield* context(options.cwd),
        store = yield* storage(fs, root);
      yield* exclusive(
        fs,
        store,
        Effect.gen(function* () {
          yield* assertInactive(fs, root);
          const path = yield* safePath(fs, root, join(store, "latest.json"));
          let journal = yield* fs
            .readFileString(path)
            .pipe(
              Effect.flatMap((text) =>
                parse(
                  () => journalSchema.parse(JSON.parse(text)),
                  "Invalid rollback record",
                ),
              ),
            );
          if (
            journal.status === "failed" &&
            (yield* fs.exists(join(store, "rollback.json")))
          )
            journal = yield* fs
              .readFileString(
                yield* safePath(fs, root, join(store, "rollback.json")),
              )
              .pipe(
                Effect.flatMap((text) =>
                  parse(
                    () => journalSchema.parse(JSON.parse(text)),
                    "Invalid retained rollback record",
                  ),
                ),
              );
          if (journal.status === "rolled-back") return;
          if (journal.status === "failed")
            return yield* fail(
              "Failed installation already restored its original state",
            );
          const directory = dirname(
            yield* safePath(fs, root, join(root, journal.manifest)),
          );
          yield* restore(
            fs,
            root,
            directory,
            join(store, journal.id, "backup"),
            journal,
          );
          journal.status = "rolled-back";
          yield* saveJournal(fs, path, journal);
          yield* saveJournal(fs, join(store, "rollback.json"), journal);
          yield* saveJournal(
            fs,
            join(store, journal.id, "record.json"),
            journal,
          );
        }),
      );
    }),
  );

/** Claim project execution against runtime replacement across operator instances. The trusted adapter releases after its run settles. */
export const claimRuntimeRun = (cwd: string): Promise<() => Promise<void>> =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem,
        root = yield* fs.realPath(resolve(cwd)),
        store = yield* storage(fs, root);
      const token = randomUUID(),
        path = join(store, "operation.lock");
      yield* fs
        .writeFileString(
          path,
          JSON.stringify({ kind: "run", pid: process.pid, token }),
          { flag: "wx", mode: 0o600 },
        )
        .pipe(
          Effect.mapError(
            () =>
              new OperatorError({
                message:
                  "Project execution/runtime operation is locked; finish or reconcile the owner before starting another run",
              }),
          ),
        );
      return () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const owner = yield* json(yield* fs.readFileString(path));
            if (owner.token !== token)
              return yield* fail(
                "Project execution ownership changed; inspect runtime operation state",
              );
            yield* fs.remove(path);
          }),
        );
    }),
  );
