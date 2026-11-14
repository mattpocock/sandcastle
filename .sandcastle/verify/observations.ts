/**
 * What a world's sandboxes were seen with: the keys its project declares,
 * the containers that mount it, and the observations in observed.jsonl.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { EnvLeak } from "./envLeaks.ts";
import { sh } from "./lib.ts";
import type { Engine } from "./machine.ts";
import type { World } from "./worldStore.ts";

/** Keys the world's project declares in `.sandcastle/.env` (names only). */
export const declaredKeys = (world: World): Set<string> => {
  const file = join(world.project, ".sandcastle", ".env");
  if (!existsSync(file)) {
    return new Set();
  }
  return new Set(
    readFileSync(file, "utf8")
      .split("\n")
      .map(
        (l) =>
          /^\s*(?<key>[A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(l)?.groups?.["key"],
      )
      .filter((k): k is string => Boolean(k)),
  );
};

export interface Observation {
  readonly at: string;
  readonly container: string;
  readonly image: string;
  readonly envNames: string[];
  readonly leaks: EnvLeak[];
}

const ObservationSchema: z.ZodType<Observation> = z.object({
  at: z.string(),
  container: z.string(),
  image: z.string(),
  envNames: z.array(z.string()),
  leaks: z.array(z.object({ name: z.string(), reason: z.string() })),
});

/** The parts of `docker|podman inspect` output the ledger reads. */
const InspectSchema = z.object({
  Config: z
    .object({
      Env: z.array(z.string()).optional(),
      Image: z.string().optional(),
    })
    .optional(),
  Mounts: z.array(z.object({ Source: z.string().optional() })).optional(),
});

const inspect = (engine: Engine, name: string) => {
  const r = sh(engine, ["inspect", name, "--format", "{{json .}}"]);
  if (r.code !== 0) {
    return undefined;
  }
  const j = InspectSchema.parse(JSON.parse(r.stdout));
  return {
    image: j.Config?.Image ?? "?",
    env: (j.Config?.Env ?? []).map((e) => {
      const i = e.indexOf("=");
      return [e.slice(0, i), e.slice(i + 1)] as [string, string];
    }),
    mountsWorld: (j.Mounts ?? []).map((m) => m.Source ?? ""),
  };
};

/** A container belongs to `world` when it mounts a path inside the world. */
export const worldContainer = (world: World, engine: Engine, name: string) => {
  const info = inspect(engine, name);
  if (!info || !info.mountsWorld.some((s) => s.startsWith(world.dir))) {
    return undefined;
  }
  return info;
};

/** Read every observation made in the world so far. */
export const observations = (world: World): Observation[] => {
  const file = join(world.dir, "observed.jsonl");
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => ObservationSchema.parse(JSON.parse(l)));
};
