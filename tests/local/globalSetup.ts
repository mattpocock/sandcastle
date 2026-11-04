/**
 * Runs once before the local tests (vitest.local.config.ts). For each engine
 * the run covers, it checks the engine answers and builds the shared test
 * images; afterwards it removes them.
 *
 * A missing engine fails the run: `npm run test:local` gates a release, and a
 * run that skipped Docker or Podman must not look like a pass. To run against
 * one engine on purpose, set SANDCASTLE_LOCAL_ENGINES (e.g. `docker`).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";
import { command } from "./helpers/command.js";
import { enginesToRun } from "./helpers/engines.js";
import type { Engine, EngineImages } from "./helpers/engines.js";

/** PID 1 exits on SIGTERM, so `docker stop` doesn't wait out its grace period. */
const BASE_DOCKERFILE = `FROM alpine:3.20
CMD ["sh", "-c", "trap 'exit 0' TERM; sleep infinity & wait"]
`;

/** Whether `error` (from `command`) says the binary isn't installed. */
const isMissingBinary = (error: unknown): boolean =>
  error instanceof Error &&
  error.cause instanceof Error &&
  "code" in error.cause &&
  error.cause.code === "ENOENT";

/** Fails with what to do when `engine` doesn't answer. */
const assertEngineAnswers = async (engine: Engine): Promise<void> => {
  try {
    await command(engine, ["info"], { timeout: 60_000 });
  } catch (error) {
    const reason = isMissingBinary(error)
      ? `\`${engine}\` is not on PATH`
      : String(error instanceof Error ? error.message : error);
    throw new Error(
      [
        `npm run test:local needs ${engine}, and ${reason}.`,
        `Install or start ${engine} and run it again. A release needs both engines;`,
        `to run against the others only, set SANDCASTLE_LOCAL_ENGINES (e.g. SANDCASTLE_LOCAL_ENGINES=${engine === "docker" ? "podman" : "docker"}).`,
      ].join("\n"),
      { cause: error },
    );
  }
};

/** Builds `dockerfile` as `tag` with `engine`, from an empty context. */
const build = async (
  engine: Engine,
  tag: string,
  dockerfile: string,
): Promise<void> => {
  const context = await mkdtemp(path.join(tmpdir(), "sandcastle-local-image-"));
  try {
    await writeFile(path.join(context, "Dockerfile"), dockerfile);
    await command(engine, ["build", "-q", "-t", tag, context], {
      timeout: 300_000,
    });
  } finally {
    await rm(context, { recursive: true, force: true });
  }
};

/** Checks `engine` and builds its images, tagged with `suffix`. */
const prepare = async (
  engine: Engine,
  suffix: string,
): Promise<EngineImages> => {
  await assertEngineAnswers(engine);
  const images = {
    base: `sandcastle-local-test:base-${suffix}`,
    uid500: `sandcastle-local-test:uid500-${suffix}`,
  };
  await build(engine, images.base, BASE_DOCKERFILE);
  await build(engine, images.uid500, `FROM ${images.base}\nUSER 500:500\n`);
  return images;
};

export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const engines = enginesToRun(process.env["SANDCASTLE_LOCAL_ENGINES"]);
  const suffix = `${String(process.pid)}-${String(Date.now())}`;
  const prepared = await Promise.allSettled(
    engines.map(async (engine) => prepare(engine, suffix)),
  );
  const built = engines.flatMap((engine, i) => {
    const result = prepared[i];
    return result?.status === "fulfilled"
      ? [[engine, result.value] as const]
      : [];
  });
  const removeImages = async (): Promise<void> => {
    await Promise.all(
      built.map(async ([engine, images]) =>
        command(engine, ["rmi", "-f", images.uid500, images.base]).catch(
          () => undefined,
        ),
      ),
    );
  };
  const failures = prepared.flatMap((result): unknown[] =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    await removeImages();
    throw new AggregateError(
      failures,
      failures
        .map((reason) =>
          reason instanceof Error ? reason.message : String(reason),
        )
        .join("\n\n"),
    );
  }
  project.provide("localImages", Object.fromEntries(built));
  return removeImages;
}
