import { resolveEnv } from "./EnvResolver.js";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { OperatorError } from "./Operator.js";
import { defaultImageName } from "./mountUtils.js";
import { writePrivateRecord } from "./writePrivateRecord.js";

const imageSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^(?:[a-z0-9][a-z0-9.-]*(?::[0-9]+)?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/,
  );
const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    image: imageSchema,
    dockerfile: z
      .string()
      .min(1)
      .max(400)
      .regex(/^[a-zA-Z0-9._/-]+$/)
      .refine(
        (path) => !path.startsWith("/") && !path.split("/").includes(".."),
        "Use a project-relative Dockerfile path without traversal",
      ),
    buildArgs: z.record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      z
        .string()
        .max(1000)
        .regex(/^[A-Za-z0-9._/:@,+-]*$/),
    ),
  })
  .strict();
/** Credential-free Docker image/build settings shared by host automation and web. */
export type EnvironmentConfig = z.infer<typeof configSchema>;
const safeError = (message: string) => new OperatorError({ message });
/** Internal compatibility validator shared by environment settings and migration. */
export const validateEnvironmentConfigEffect = (input: unknown) =>
  Effect.try({
    try: () => configSchema.parse(input),
    catch: () =>
      safeError(
        "Invalid environment settings: use an image name, project-relative Dockerfile and literal build arguments; commands/auth are not editable",
      ),
  });
const managedDirectory = (cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(resolve(cwd));
    const directory = join(root, ".sandcastle");
    if ((yield* fs.readDirectory(root)).includes(".sandcastle")) {
      if (
        (yield* fs.stat(directory)).type !== "Directory" ||
        (yield* fs.realPath(directory)).replace(/\\/g, "/") !==
          directory.replace(/\\/g, "/")
      )
        return yield* Effect.fail(
          safeError(
            "The project configuration directory must not be a symlink",
          ),
        );
    }
    return directory;
  });
/** Internal Effect loader for the project-scoped selected image. */
export const loadEnvironmentConfigEffect = (cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* managedDirectory(cwd);
    const path = join(directory, "environment.json");
    const files = (yield* fs.exists(directory))
      ? yield* fs.readDirectory(directory)
      : [];
    if (!files.includes("environment.json"))
      return {
        schemaVersion: 1,
        image: defaultImageName(resolve(cwd)),
        dockerfile: ".sandcastle/Dockerfile",
        buildArgs: {},
      } satisfies EnvironmentConfig;
    if (
      (yield* fs.realPath(path)).replace(/\\/g, "/") !==
      path.replace(/\\/g, "/")
    )
      return yield* Effect.fail(
        safeError("environment.json must not be a symlink"),
      );
    const text = yield* fs.readFileString(path);
    const input = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () => safeError("environment.json contains invalid JSON"),
    });
    return yield* validateEnvironmentConfigEffect(input);
  }).pipe(
    Effect.mapError(() =>
      safeError("Cannot read valid project environment settings"),
    ),
  );
/** Load selected Docker settings; only an absent file uses project defaults. */
export const loadEnvironmentConfig = (options: {
  /** Explicit host project. */ cwd: string;
}): Promise<EnvironmentConfig> =>
  Effect.runPromise(
    loadEnvironmentConfigEffect(options.cwd).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );
/** Validate and atomically save image/build settings without executing Docker or changing project workflow policy. */
export const saveEnvironmentConfig = (options: {
  /** Explicit host project. */ cwd: string;
  /** Complete version-one document. */ config: unknown;
}): Promise<EnvironmentConfig> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const config = yield* validateEnvironmentConfigEffect(options.config);
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* managedDirectory(options.cwd);
      const root = yield* fs.realPath(resolve(options.cwd));
      const dockerfile = yield* fs.realPath(resolve(root, config.dockerfile));
      const path = relative(root, dockerfile).replace(/\\/g, "/");
      if (
        path.startsWith("../") ||
        path === ".." ||
        isAbsolute(path) ||
        (yield* fs.stat(dockerfile)).type !== "File"
      )
        return yield* Effect.fail(
          safeError("Dockerfile must be a file inside the selected project"),
        );
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* writePrivateRecord(
        fs,
        join(directory, "environment.json"),
        JSON.stringify(config, null, 2) + "\n",
      );
      return config;
    }).pipe(
      Effect.mapError((error) =>
        error instanceof OperatorError
          ? error
          : safeError(
              "Cannot save environment settings; check Dockerfile and project permissions",
            ),
      ),
      Effect.provide(NodeFileSystem.layer),
    ),
  );

// Keep only a possible credential prefix between chunks, separately for each
// stream. Partial lines can then be emitted immediately without exposing secrets.
const streamDockerLogs = (
  stream: Readable,
  secrets: readonly string[],
  onLog: (text: string) => void,
) => {
  const values = [...new Set(secrets)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  let pending = "";
  const emit = (text: string, final: boolean) => {
    pending += text;
    let safe = "";
    let offset = 0;
    while (offset < pending.length) {
      const rest = pending.slice(offset);
      if (
        values.some(
          (secret) => secret.startsWith(rest) && secret.length > rest.length,
        )
      ) {
        if (!final) break;
        // Cancellation can end a stream mid-credential; never flush that prefix.
        safe += "[redacted]";
        offset = pending.length;
        break;
      }
      const secret = values.find((secret) => rest.startsWith(secret));
      if (secret) {
        safe += "[redacted]";
        offset += secret.length;
      } else {
        safe += pending[offset++];
      }
    }
    pending = pending.slice(offset);
    if (safe) onLog(safe);
  };
  stream.setEncoding("utf8");
  stream.on("data", (text: string) => emit(text, false));
  stream.on("end", () => emit("", true));
};

/** Execute Docker with argument vectors and real-time output; diagnostics never include stderr in failures. */
export const dockerCommand = (
  cwd: string,
  args: readonly string[],
  options: {
    /** Abort the owned process. */ signal?: AbortSignal;
    /** Maximum duration; defaults to 30 seconds. */ timeoutMs?: number;
    /** Receive output as it arrives. */ onLog?: (text: string) => void;
    /** Credential values withheld and redacted separately on stdout/stderr. */ redact?: readonly string[];
  } = {},
): Effect.Effect<string, OperatorError> =>
  Effect.async((resume) => {
    if (options.signal?.aborted) {
      resume(Effect.fail(safeError("Docker operation cancelled")));
      return;
    }
    const child = spawn("docker", [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const read = (chunk: Buffer) => {
      const text = chunk.toString();
      output = (output + text).slice(-65536);
    };
    child.stdout.on("data", read);
    if (options.onLog)
      for (const stream of [child.stdout, child.stderr])
        streamDockerLogs(stream, options.redact ?? [], options.onLog);
    else child.stderr.resume();
    let force: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const abort = () => {
      child.kill("SIGTERM");
      force ??= setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      abort();
    }, options.timeoutMs ?? 30_000);
    let settled = false;
    options.signal?.addEventListener("abort", abort, { once: true });
    const finish = (result: Effect.Effect<string, OperatorError>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (force) clearTimeout(force);
      options.signal?.removeEventListener("abort", abort);
      resume(result);
    };
    child.once("error", () =>
      finish(
        Effect.fail(
          safeError("Cannot start Docker; check installation and daemon"),
        ),
      ),
    );
    child.once("close", (code) =>
      finish(
        code === 0 && !options.signal?.aborted && !timedOut
          ? Effect.succeed(output)
          : Effect.fail(
              safeError(
                options.signal?.aborted
                  ? "Docker operation cancelled"
                  : `Docker ${args[0]} failed; check the environment job`,
              ),
            ),
      ),
    );
    return Effect.sync(abort);
  });
/** Resolve a selected name to an immutable Docker SHA-256 image identity. */
export const resolveDockerImageEffect = (cwd: string, image: string) =>
  dockerCommand(cwd, ["image", "inspect", image, "--format", "{{.Id}}"]).pipe(
    Effect.flatMap((output) =>
      /^sha256:[a-f0-9]{64}$/.test(output.trim())
        ? Effect.succeed(output.trim())
        : Effect.fail(safeError("Docker returned an invalid image identity")),
    ),
  );
/** Observe configured and installed Docker images without pulling or building. */
export const inspectEnvironment = (cwd: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const config = yield* loadEnvironmentConfigEffect(cwd);
      const images = yield* dockerCommand(cwd, [
        "image",
        "ls",
        "--format",
        "{{.Repository}}:{{.Tag}}",
      ]).pipe(
        Effect.map((text) => [
          ...new Set(
            text
              .trim()
              .split("\n")
              .filter((name) => name && !name.includes("<none>")),
          ),
        ]),
        Effect.catchAll(() => Effect.succeed([] as string[])),
      );
      const identity = yield* resolveDockerImageEffect(cwd, config.image).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      );
      return { config, images, available: identity !== null, identity };
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

/** Build into an owned temporary tag and replace the selected tag only after successful completion. */
export const buildEnvironmentEffect = (
  cwd: string,
  config: EnvironmentConfig,
  id: string,
  signal: AbortSignal,
  onLog: (text: string) => void,
  onPromotion: () => void,
  secrets: readonly string[],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(cwd);
    const path = yield* fs.realPath(resolve(cwd, config.dockerfile));
    const inside = relative(root, path).replace(/\\/g, "/");
    if (
      inside === ".." ||
      inside.startsWith("../") ||
      isAbsolute(inside) ||
      (yield* fs.stat(path)).type !== "File"
    )
      return yield* Effect.fail(
        safeError("Dockerfile must be inside the selected project"),
      );
    if (config.image.includes("@"))
      return yield* Effect.fail(
        safeError("Build requires a mutable image tag, not a digest"),
      );
    const buildArgs: Record<string, string> = {};
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid !== undefined) buildArgs.AGENT_UID = String(uid);
    if (gid !== undefined) buildArgs.AGENT_GID = String(gid);
    Object.assign(buildArgs, config.buildArgs);
    const temporary = `sandcastle-operator-build:${id}`;
    return yield* Effect.gen(function* () {
      yield* dockerCommand(
        cwd,
        [
          "build",
          "-t",
          temporary,
          "-f",
          path,
          ...Object.entries(buildArgs).flatMap(([key, value]) => [
            "--build-arg",
            `${key}=${value}`,
          ]),
          root,
        ],
        { signal, onLog, redact: secrets, timeoutMs: 30 * 60_000 },
      );
      const identity = yield* resolveDockerImageEffect(cwd, temporary);
      if (signal.aborted)
        return yield* Effect.fail(safeError("Build cancelled"));
      // Promotion is the commit point: cancellation is no longer accepted once it starts.
      onPromotion();
      yield* dockerCommand(cwd, ["tag", identity, config.image]);
      return identity;
    }).pipe(
      Effect.ensuring(
        Effect.ignore(dockerCommand(cwd, ["image", "rm", temporary])),
      ),
    );
  });

/** Trusted project preflight declarations; HTTP cannot edit tools, UID or auth references. */
export interface EnvironmentPolicy {
  /** UID used by the project sandbox; defaults to the host UID. */
  uid: number;
  /** Executable names required inside the image, invoked directly with --version. */
  tools: readonly string[];
  /** Credential file references; only presence is observed, never content. */
  authFiles: Readonly<Record<string, string>>;
}
/** Check image prerequisites without mounting project files, caches or credentials, or running bootstrap/gates. */
export const preflightEnvironmentEffect = (
  cwd: string,
  config: EnvironmentConfig,
  id: string,
  signal: AbortSignal,
  onLog: (text: string) => void,
  policy?: EnvironmentPolicy,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let tools = ["git", "gh", "codex"];
    if (!policy && (yield* fs.exists(join(cwd, ".sandcastle/project.json")))) {
      const text = yield* fs.readFileString(
        join(cwd, ".sandcastle/project.json"),
      );
      const profile = yield* Effect.try({
        try: () =>
          z
            .object({
              schemaVersion: z.literal(1),
              projectType: z.enum(["node", "android"]),
              packageManager: z.literal("npm").optional(),
            })
            .passthrough()
            .parse(JSON.parse(text)),
        catch: () => safeError("Invalid project profile"),
      });
      tools = tools.concat(
        profile.projectType === "node"
          ? ["node", "npm"]
          : ["java", "sdkmanager"],
      );
    }
    const isolatedAuth =
      (yield* fs.exists(join(cwd, ".sandcastle/codex-home"))) ||
      (yield* fs.exists(join(cwd, ".sandcastle/project.json")));
    const selected: EnvironmentPolicy = policy ?? {
      uid: process.getuid?.() ?? 1000,
      tools,
      authFiles: isolatedAuth
        ? { Codex: ".sandcastle/codex-home/auth.json" }
        : {},
    };
    if (
      !Number.isInteger(selected.uid) ||
      selected.uid < 0 ||
      selected.tools.some((tool) => !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(tool))
    )
      return yield* Effect.fail(
        safeError("Invalid trusted preflight tool/UID policy"),
      );
    let healthy = true;
    const check = (
      name: string,
      effect: Effect.Effect<string, OperatorError>,
      success: (output: string) => string,
    ) =>
      effect.pipe(
        Effect.match({
          onSuccess: (output) => {
            onLog(`${name}: ${success(output)}\n`);
            return output;
          },
          onFailure: () => {
            healthy = false;
            onLog(`${name}: failed\n`);
            return null;
          },
        }),
      );
    const daemon = yield* check(
      "Daemon",
      dockerCommand(cwd, ["info"], { signal }),
      () => "ready",
    );
    const identity =
      daemon !== null
        ? yield* check(
            "Image",
            resolveDockerImageEffect(cwd, config.image),
            (output) => output,
          )
        : null;
    if (identity) {
      const container = `sandcastle-preflight-${id}`;
      const run = (entrypoint: string, args: string[]) =>
        dockerCommand(
          cwd,
          [
            "run",
            "--rm",
            "--name",
            container,
            "--network",
            "none",
            "--entrypoint",
            entrypoint,
            identity,
            ...args,
          ],
          { signal },
        ).pipe(
          Effect.ensuring(
            Effect.ignore(dockerCommand(cwd, ["rm", "-f", container])),
          ),
        );
      yield* check(
        "UID",
        run("id", ["-u"]).pipe(
          Effect.flatMap((output) =>
            /^\d+$/.test(output.trim()) &&
            Number(output.trim()) === selected.uid
              ? Effect.succeed(output)
              : Effect.fail(
                  safeError(
                    "Image UID mismatch; rebuild or match the project's sandbox UID",
                  ),
                ),
          ),
        ),
        () => "matches",
      );
      for (const tool of selected.tools) {
        if (signal.aborted)
          return yield* Effect.fail(safeError("Preflight cancelled"));
        yield* check(`Tool ${tool}`, run(tool, ["--version"]), () => "ready");
      }
    } else onLog("UID/tools: skipped because daemon/image is unavailable\n");
    for (const [name, path] of Object.entries(selected.authFiles)) {
      const present = yield* fs.stat(resolve(cwd, path)).pipe(
        Effect.map((info) => info.type === "File"),
        Effect.catchAll(() => Effect.succeed(false)),
      );
      onLog(
        `Auth ${name}: ${present ? "present (presence only; login remains project-owned)" : "missing"}\n`,
      );
      if (!present) healthy = false;
    }
    const env = yield* resolveEnv(cwd);
    const declarations = yield* fs
      .readFileString(join(cwd, ".sandcastle/.env"))
      .pipe(Effect.catchAll(() => Effect.succeed("")));
    const names = [
      ...new Set(
        declarations
          .split("\n")
          .map((line) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1])
          .filter(
            (name): name is string =>
              !!name && /token|secret|password|api_key/i.test(name),
          ),
      ),
    ];
    for (const name of names) {
      const present = !!env[name];
      onLog(`Auth ${name}: ${present ? "present" : "missing"}\n`);
      if (!present) healthy = false;
    }
    if (!names.length && !Object.keys(selected.authFiles).length)
      onLog(
        "Auth: not declared; configure trusted project references to check presence\n",
      );
    if (!healthy || signal.aborted)
      return yield* Effect.fail(
        safeError(
          signal.aborted
            ? "Preflight cancelled"
            : "Preflight failed; see prerequisite results",
        ),
      );
    return identity!;
  });
