import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Data, Effect } from "effect";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { hostname } from "node:os";
import { z } from "zod";

/** Recovery stopped before authorizing further workflow execution. */
class WorkflowRecoveryError extends Data.TaggedError("WorkflowRecoveryError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Identity shared by all restarts of one workflow. Local host/filesystem only. */
export interface WorkflowRecoveryOptions {
  /** Checkout in the Git repository; linked worktrees share a journal and lock. */
  cwd: string;
  /** Fully qualified or short target branch name, not a commit or detached HEAD. */
  targetBranch: string;
  /** Stable identifier; reuse on restart, change only for a new completed workflow. */
  runId: string;
  /** Change when the workflow contract changes. Old checkpoints then fail closed. */
  workflowVersion: string;
}

/** A workflow-owned, independently verifiable unit of work. */
export interface RecoveryStep<T> {
  /** Stable across restarts; include batch, phase and issue identity. */
  key: string;
  /** JSON input contract, including relevant source SHA, issue/prompt/gate versions. No secrets. */
  input: unknown;
  /** Runtime decoder for persisted and newly executed results. */
  schema: { parse(value: unknown): T };
  /** Execute once only when no durable attempt exists. Return JSON evidence, not session handles. */
  execute: () => Promise<T>;
  /** Independently check the exact result against current Git/tracker/gate evidence, including on resume. */
  verify: (result: T) => Promise<boolean>;
  /** For an uncertain attempt only: prove former writers are stopped and recover its result.
   * null means unresolved. This read-only callback never authorizes blind re-execution. */
  reconcile?: () => Promise<{ quiescent: true; result: T } | null>;
}

/** All workflow side effects must go through a step; ordinary control flow may replay. */
export interface RecoveryWorkflow {
  /** Execute, verify and checkpoint, or revalidate and reuse a completed checkpoint. */
  step<T>(options: RecoveryStep<T>): Promise<T>;
}

const checkpointSchema = z.object({
  key: z.string(),
  input: z.string(),
  status: z.enum(["running", "verified"]),
  result: z.unknown().optional(),
});
const journalSchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  workflowVersion: z.string(),
  targetBranch: z.string(),
  status: z.enum(["running", "completed"]),
  steps: z.record(z.string(), checkpointSchema),
});
type Journal = z.infer<typeof journalSchema>;
const fail = (message: string) => new WorkflowRecoveryError({ message });
const attempt = <T>(action: () => T) =>
  Effect.try({
    try: action,
    catch: (cause) =>
      new WorkflowRecoveryError({ message: String(cause), cause }),
  });
const call = <T>(action: () => Promise<T>) =>
  Effect.tryPromise({
    try: action,
    catch: (cause) =>
      new WorkflowRecoveryError({ message: String(cause), cause }),
  });
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const git = (cwd: string, args: string[]) =>
  call(
    () =>
      new Promise<string>((resolve, reject) => {
        execFile(
          "git",
          args,
          { cwd, encoding: "utf8", timeout: 30_000 },
          (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
        );
      }),
  );

// Canonical JSON rejects lossy values rather than silently changing the input contract.
function json(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + Array.from(value, json).join(",") + "]";
  if (
    typeof value === "object" &&
    value &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ":" +
            json((value as Record<string, unknown>)[key]),
        )
        .join(",") +
      "}"
    );
  throw fail(
    "Recovery input/results must be plain JSON without undefined, functions, dates or non-finite numbers",
  );
}

const write = (fs: FileSystem.FileSystem, path: string, value: unknown) =>
  Effect.scoped(
    Effect.gen(function* () {
      const encoded = yield* attempt(() => json(value));
      const temporary = path + "." + randomUUID() + ".tmp";
      const file = yield* fs.open(temporary, { flag: "wx", mode: 0o600 });
      yield* file.writeAll(new TextEncoder().encode(encoded));
      yield* file.sync;
      yield* fs.rename(temporary, path);
      // Persist the rename before permitting another side effect (POSIX local filesystems).
      if (process.platform !== "win32") {
        const directory = yield* fs.open(dirname(path));
        yield* directory.sync;
      }
    }),
  );

const ownerSchema = z.object({
  runId: z.string(),
  owner: z
    .object({
      token: z.string(),
      pid: z.number().int().positive(),
      host: z.string(),
    })
    .nullable(),
});

// A short, exclusive claim serializes ownership changes. Never expire/steal it
// by timestamp. A crash inside this critical section deliberately fails closed.
function ownership<A, E>(
  fs: FileSystem.FileSystem,
  directory: string,
  runId: string,
  use: Effect.Effect<A, E>,
) {
  const path = join(directory, "owner.json");
  const claim = join(directory, "ownership-claim");
  const token = randomUUID();
  const readOwner = fs
    .exists(path)
    .pipe(
      Effect.flatMap((exists) =>
        exists
          ? fs
              .readFileString(path)
              .pipe(
                Effect.flatMap((text) =>
                  attempt(() => ownerSchema.parse(JSON.parse(text))),
                ),
              )
          : Effect.succeed(null),
      ),
    );
  const exclusive = <B, F>(body: Effect.Effect<B, F>) =>
    Effect.acquireUseRelease(
      fs.writeFileString(claim, "", { flag: "wx", mode: 0o600 }).pipe(
        Effect.mapError(
          (cause) =>
            new WorkflowRecoveryError({
              message:
                "Recovery ownership is locked; an unfinished ownership claim requires inspection",
              cause,
            }),
        ),
      ),
      () => body,
      () => fs.remove(claim).pipe(Effect.orDie),
    );
  return Effect.acquireUseRelease(
    exclusive(
      Effect.gen(function* () {
        const prior = yield* readOwner;
        if (prior?.owner) {
          const dead = yield* attempt(() => {
            if (prior.owner!.host !== hostname()) return false;
            try {
              process.kill(prior.owner!.pid, 0);
              return false;
            } catch (cause) {
              return (
                typeof cause === "object" &&
                cause !== null &&
                "code" in cause &&
                cause.code === "ESRCH"
              );
            }
          });
          if (!dead)
            return yield* Effect.fail(
              fail(
                "Target branch is owned by another runner; heartbeat age never authorizes takeover",
              ),
            );
        }
        if (prior && prior.runId !== runId) {
          const old = yield* fs
            .readFileString(join(directory, hash(prior.runId) + ".json"))
            .pipe(
              Effect.flatMap((text) =>
                attempt(() => journalSchema.parse(JSON.parse(text))),
              ),
            );
          if (old.status !== "completed")
            return yield* Effect.fail(
              fail(
                "Resume unfinished run " +
                  prior.runId +
                  " before starting a new run",
              ),
            );
        }
        yield* write(fs, path, {
          runId,
          owner: { token, pid: process.pid, host: hostname() },
        });
      }),
    ),
    () => use,
    () =>
      exclusive(
        Effect.gen(function* () {
          const current = yield* readOwner;
          if (current?.owner?.token !== token)
            return yield* Effect.fail(
              fail("Recovery ownership changed unexpectedly"),
            );
          yield* write(fs, path, { runId, owner: null });
        }),
      ).pipe(Effect.orDie),
  );
}

/** Replay workflow control flow, reusing only independently revalidated durable checkpoints. */
export function withWorkflowRecovery<T>(
  options: WorkflowRecoveryOptions,
  execute: (workflow: RecoveryWorkflow) => Promise<T>,
): Promise<T> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      if (!options.runId.trim() || !options.workflowVersion.trim())
        return yield* Effect.fail(
          fail("runId and workflowVersion are required"),
        );
      const branch = options.targetBranch.startsWith("refs/heads/")
        ? options.targetBranch
        : "refs/heads/" + options.targetBranch;
      yield* git(options.cwd, ["check-ref-format", branch]);
      yield* git(options.cwd, ["rev-parse", "--verify", branch]);
      const common = yield* git(options.cwd, ["rev-parse", "--git-common-dir"]);
      const gitDir = yield* fs.realPath(resolve(options.cwd, common));
      const directory = join(gitDir, "sandcastle", "recovery", hash(branch));
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      return yield* ownership(
        fs,
        directory,
        options.runId,
        Effect.gen(function* () {
          const path = join(directory, hash(options.runId) + ".json");
          const journal: Journal = (yield* fs.exists(path))
            ? yield* fs
                .readFileString(path)
                .pipe(
                  Effect.flatMap((text) =>
                    attempt(() => journalSchema.parse(JSON.parse(text))),
                  ),
                )
            : {
                version: 1,
                runId: options.runId,
                workflowVersion: options.workflowVersion,
                targetBranch: branch,
                status: "running",
                steps: {},
              };
          if (
            journal.runId !== options.runId ||
            journal.workflowVersion !== options.workflowVersion ||
            journal.targetBranch !== branch
          )
            return yield* Effect.fail(
              fail("Recovery identity or workflow version changed"),
            );
          yield* write(fs, path, journal);
          const writes = yield* Effect.makeSemaphore(1);
          let poisoned = false;
          const save = writes.withPermits(1)(
            Effect.suspend(() =>
              poisoned
                ? Effect.fail(
                    fail(
                      "Journal storage failed; further execution is blocked",
                    ),
                  )
                : write(fs, path, journal).pipe(
                    Effect.tapError(() =>
                      Effect.sync(() => {
                        poisoned = true;
                      }),
                    ),
                  ),
            ),
          );
          let accepting = true;
          const unresolved = new Set(
            Object.entries(journal.steps)
              .filter(([, step]) => step.status === "running")
              .map(([key]) => key),
          );
          const seen = new Set<string>();
          const pending: Promise<unknown>[] = [];
          const workflow: RecoveryWorkflow = {
            step: <R>(step: RecoveryStep<R>) => {
              const work = Effect.runPromise(
                Effect.gen(function* () {
                  if (!accepting || poisoned)
                    return yield* Effect.fail(
                      fail("Recovery workflow no longer accepts steps"),
                    );
                  if (!step.key.trim() || seen.has(step.key))
                    return yield* Effect.fail(
                      fail(
                        "Each step key must be nonempty and unique per invocation",
                      ),
                    );
                  seen.add(step.key);
                  const key = hash(step.key);
                  const input = yield* attempt(() => json(step.input));
                  const previous = journal.steps[key];
                  if (previous && previous.input !== input)
                    return yield* Effect.fail(
                      fail("Step input changed: " + step.key),
                    );
                  let result: R;
                  if (previous?.status === "running") {
                    const recovered = step.reconcile
                      ? yield* call(step.reconcile)
                      : null;
                    if (!recovered || recovered.quiescent !== true)
                      return yield* Effect.fail(
                        fail(
                          "Uncertain step; reconciliation required: " +
                            step.key,
                        ),
                      );
                    result = yield* attempt(() =>
                      step.schema.parse(recovered.result),
                    );
                  } else if (previous)
                    result = yield* attempt(() =>
                      step.schema.parse(previous.result),
                    );
                  else {
                    if (unresolved.size)
                      return yield* Effect.fail(
                        fail(
                          "Uncertain prior attempts must be reconciled before starting new work",
                        ),
                      );
                    journal.steps[key] = {
                      key: step.key,
                      input,
                      status: "running",
                    };
                    journal.status = "running";
                    yield* save;
                    result = yield* call(step.execute).pipe(
                      Effect.flatMap((value) =>
                        attempt(() => step.schema.parse(value)),
                      ),
                    );
                  }
                  if ((yield* call(() => step.verify(result))) !== true)
                    return yield* Effect.fail(
                      fail("Verification failed: " + step.key),
                    );
                  journal.steps[key] = {
                    key: step.key,
                    input,
                    status: "verified",
                    result: yield* attempt(() => JSON.parse(json(result))),
                  };
                  yield* save;
                  unresolved.delete(key);
                  return result;
                }),
              );
              pending.push(work);
              void work.catch(() => {}); // Unawaited failures are still checked before releasing ownership.
              return work;
            },
          };
          const outcome = yield* call(() => execute(workflow)).pipe(
            Effect.either,
          );
          accepting = false;
          const settled = yield* call(() => Promise.allSettled(pending));
          if (outcome._tag === "Left") return yield* Effect.fail(outcome.left);
          const rejected = settled.find(
            (result) => result.status === "rejected",
          );
          if (rejected?.status === "rejected")
            return yield* Effect.fail(
              new WorkflowRecoveryError({
                message: String(rejected.reason),
                cause: rejected.reason,
              }),
            );
          if (
            Object.values(journal.steps).some(
              (step) => step.status !== "verified",
            )
          )
            return yield* Effect.fail(fail("Unverified steps remain"));
          const visited = new Set([...seen].map(hash));
          if (Object.keys(journal.steps).some((key) => !visited.has(key)))
            return yield* Effect.fail(
              fail(
                "Recorded checkpoints were not revisited; workflow contract changed",
              ),
            );
          journal.status = "completed";
          yield* save;
          return outcome.right;
        }),
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
}
