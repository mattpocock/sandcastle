/**
 * The `cleanup` verb: removes what one world left behind (its containers,
 * images, worktrees and files) and keeps the evidence in the world's dir.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { sh } from "./lib.ts";
import {
  engineEntries,
  ENGINES,
  engineUp,
  listContainers,
  listImages,
  observations,
  saveWorld,
  worldContainer,
  worldTmp,
} from "./world.ts";
import type { World } from "./world.ts";

/** Removes the containers this world started; returns what went. */
const removeContainers = (world: World): string[] => {
  const removed: string[] = [];
  const observed = new Set(observations(world).map((o) => o.container));
  for (const { entry: c, engine, rest: name } of engineEntries(
    listContainers(),
  )) {
    if (world.baseline.containers.includes(c)) {
      continue;
    }
    if (
      (observed.has(c) || worldContainer(world, engine, name)) &&
      sh(engine, ["rm", "-f", name]).code === 0
    ) {
      removed.push(`container ${c}`);
    }
  }
  return removed;
};

/** Removes the images tagged with this world's run id; returns what went. */
const removeImages = (world: World): string[] => {
  const removed: string[] = [];
  for (const engine of ENGINES.filter((e) => engineUp(e))) {
    for (const img of listImages()) {
      if (!img.startsWith(`${engine}:`)) {
        continue;
      }
      const ref = img.slice(engine.length + 1, img.lastIndexOf("@"));
      if (
        ref.includes(world.runId) &&
        sh(engine, ["rmi", "-f", ref]).code === 0
      ) {
        removed.push(`image ${engine}:${ref}`);
      }
    }
  }
  return removed;
};

/** Removes the project's extra worktrees; returns what went. */
const removeWorktrees = (world: World): string[] => {
  const wts = sh("git", ["worktree", "list", "--porcelain"], {
    cwd: world.project,
  })
    .stdout.split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice(9))
    .filter((p) => p !== world.project);
  for (const p of wts) {
    sh("git", ["worktree", "remove", "--force", p], { cwd: world.project });
  }
  return wts.map((p) => `worktree ${p}`);
};

/** Removes the world's project, remote, home, tmp and packed build. */
const removeWorldFiles = (world: World): void => {
  for (const p of [world.project, world.remote, world.home, worldTmp(world)]) {
    rmSync(p, { recursive: true, force: true });
  }
  for (const f of sh("ls", [world.dir]).stdout.split("\n")) {
    if (f.endsWith(".tgz")) {
      rmSync(join(world.dir, f), { force: true });
    }
  }
};

/** Cleans one world up, marks it cleaned and prints what went. */
export const cleanup = (world: World): void => {
  const removed = [
    ...removeContainers(world),
    ...removeImages(world),
    ...removeWorktrees(world),
  ];
  removeWorldFiles(world);
  removed.push("project, remote, home, tmp and packed build");
  world.cleanedAt = new Date().toISOString();
  saveWorld(world);
  console.log(
    `cleanup ${world.runId}:\n${removed.map((r) => `  removed ${r}`).join("\n")}`,
  );
  console.log(
    `  kept the evidence: ${world.dir} (world.json, logs/, observed.jsonl, LEDGER-*.md)`,
  );
};
