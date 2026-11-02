/** The container engines the local tests run against. */
export const ENGINES = ["docker", "podman"] as const;

/** A container engine the local tests run against. */
export type Engine = (typeof ENGINES)[number];

/** The test images tests/local/globalSetup.ts built for one engine. */
export interface EngineImages {
  /** Alpine with no USER, whose PID 1 exits on SIGTERM. */
  readonly base: string;
  /** `base` with `USER 500:500`. */
  readonly uid500: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    /** Each engine this run covers, with its images. Absent: narrowed out. */
    readonly localImages: Partial<Record<Engine, EngineImages>>;
  }
}

/**
 * The engines `SANDCASTLE_LOCAL_ENGINES` names (comma-separated), or both.
 * Throws on a name that isn't an engine, so a typo can't narrow a run to
 * nothing.
 */
export const enginesToRun = (value: string | undefined): readonly Engine[] => {
  if (value === undefined || value.trim() === "") {
    return ENGINES;
  }
  const names = value.split(",").map((name) => name.trim());
  const unknown = names.filter(
    (name) => !ENGINES.some((engine) => engine === name),
  );
  if (unknown.length > 0) {
    throw new Error(
      `SANDCASTLE_LOCAL_ENGINES names ${unknown.join(", ")}; the engines are ${ENGINES.join(", ")}.`,
    );
  }
  return ENGINES.filter((engine) => names.includes(engine));
};
