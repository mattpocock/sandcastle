/**
 * The ledger: what a world's runs left behind, in five sections. Any LEAK
 * line fails the verdict. Only what can be tied to this world counts: other
 * worlds and test runs share the machine. Each run writes a new
 * <world>/LEDGER-<n>.md.
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { attributeImage, ledgerFileName } from "./attribution.ts";
import { hostFiles } from "./hostFiles.ts";
import type { Section } from "./ledgerSection.ts";
import { REPO_ROOT, sh } from "./lib.ts";
import { leftoverBwrap } from "./nativeSandboxes.ts";
import {
  allWorldSpans,
  engineEntries,
  imageCreated,
  listContainers,
  listImages,
  observations,
  remoteRefs,
  worldContainer,
  worldTmp,
} from "./world.ts";
import type { World } from "./world.ts";

const git = (world: World, ...args: string[]): string =>
  sh("git", args, { cwd: world.project }).stdout.trim();

/** Branch names Sandcastle generates for temp branches: <ts>-<6hex>. */
const TEMP_BRANCH = /^sandcastle\/(?:.+\/)?\d{8}-\d{6}-[0-9a-f]{6}$/u;

const gitState = (world: World): Section => {
  const leaks: string[] = [];
  const notes: string[] = [];
  const before = world.baseline.remoteRefs;
  const after = remoteRefs(world.remote);
  for (const ref of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[ref] !== after[ref]) {
      leaks.push(
        `remote ${ref}: ${before[ref]?.slice(0, 7) ?? "absent"} -> ${after[ref]?.slice(0, 7) ?? "deleted"} (nothing in Sandcastle pushes)`,
      );
    }
  }
  if (leaks.length === 0)
    notes.push("remote unchanged since the world was created");
  notes.push(
    `HEAD: ${git(world, "rev-parse", "--abbrev-ref", "HEAD")} @ ${git(world, "rev-parse", "--short", "HEAD")}`,
  );
  for (const line of git(
    world,
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  )
    .split("\n")
    .filter(Boolean)) {
    const ahead = git(world, "rev-list", "--count", `origin/main..${line}`);
    notes.push(`branch ${line}: ${ahead} commit(s) ahead of origin/main`);
    if (TEMP_BRANCH.test(line)) leaks.push(`temp branch ${line} left behind`);
  }
  if (existsSync(join(world.project, ".git", "MERGE_HEAD")))
    leaks.push("a merge is in progress in the project");
  const dirty = git(world, "status", "--porcelain");
  notes.push(
    dirty
      ? `working tree changes:\n${dirty
          .split("\n")
          .map((l) => `      ${l}`)
          .join("\n")}`
      : "working tree clean",
  );
  return { title: "(a) Git remote and branches", leaks, notes };
};

const worktrees = (world: World): Section => {
  const leaks: string[] = [];
  const listed = git(world, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
    .filter((p) => p !== world.project);
  for (const p of listed) leaks.push(`worktree ${relative(world.project, p)}`);
  const dir = join(world.project, ".sandcastle", "worktrees");
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!listed.includes(join(dir, name)))
        leaks.push(`orphan directory .sandcastle/worktrees/${name}`);
    }
  }
  for (const base of [world.project, ...listed]) {
    const patches = join(base, ".sandcastle", "patches");
    if (existsSync(patches) && readdirSync(patches).length > 0) {
      leaks.push(
        `sync-out patches left in ${relative(world.project, patches) || "."} (a failed apply)`,
      );
    }
  }
  return {
    title: "(b) Leftover worktrees",
    leaks,
    notes: leaks.length > 0 ? [] : ["none"],
  };
};

const containersAndImages = (world: World): Section => {
  const leaks: string[] = [];
  const notes: string[] = [];
  const observed = new Set(observations(world).map((o) => o.container));
  for (const { entry: c, engine, rest: name } of engineEntries(
    listContainers(),
  )) {
    if (world.baseline.containers.includes(c)) continue;
    if (observed.has(c) || worldContainer(world, engine, name))
      leaks.push(`container ${c} still exists`);
    else notes.push(`container ${c} is not this world's (no mount inside it)`);
  }
  notes.push(`sandboxes observed (containers and bwraps): ${observed.size}`);
  const others = allWorldSpans();
  const now = new Date().toISOString();
  for (const { entry: img, engine, rest } of engineEntries(listImages())) {
    if (world.baseline.images.includes(img)) continue;
    const ref = rest.slice(0, rest.lastIndexOf("@"));
    const id = rest.slice(rest.lastIndexOf("@") + 1);
    const a = attributeImage(
      { ref, created: imageCreated(engine, id) },
      { self: world, others },
      now,
    );
    if (a.kind === "leak") leaks.push(`image ${img}: ${a.detail}`);
    else if (a.kind === "other-world")
      notes.push(`image ${img}: other world (${a.detail})`);
    else notes.push(`image ${img}: ${a.detail}`);
  }
  return {
    title: "(c) Leftover containers, images and native sandboxes",
    leaks,
    notes,
  };
};

const envLeaks = (world: World): Section => {
  const leaks: string[] = [];
  const notes: string[] = [];
  const obs = observations(world);
  for (const o of obs) {
    for (const l of o.leaks)
      leaks.push(`${o.container}: ${l.name} ${l.reason}`);
    notes.push(`${o.container} (${o.image}) env: ${o.envNames.join(", ")}`);
  }
  if (obs.length === 0)
    notes.push(
      "no sandbox observed, so this section proves nothing for this world (remote sandboxes are not observable)",
    );
  return { title: "(e) Env vars and keys in the sandbox", leaks, notes };
};

/** Run the ledger for `world`, write a new LEDGER-<n>.md, return the number of leaks. */
export const runLedger = async (
  world: World,
): Promise<{ text: string; leaks: number; file: string }> => {
  const containers = containersAndImages(world);
  const native = await leftoverBwrap(world.dir, worldTmp(world));
  const sections = [
    gitState(world),
    worktrees(world),
    {
      ...containers,
      leaks: [...containers.leaks, ...native.leaks],
      notes: [...containers.notes, ...native.notes],
    },
    hostFiles(world),
    envLeaks(world),
  ];
  const leaks = sections.reduce((n, s) => n + s.leaks.length, 0);
  const lines = [
    `# Ledger for world ${world.runId}`,
    "",
    `Sandcastle under test: ${world.sandcastleCommit.slice(0, 7)}${world.sandcastleDirty ? " + uncommitted changes" : ""} (${REPO_ROOT})`,
    `Taken: ${new Date().toISOString()}`,
    "",
  ];
  for (const s of sections) {
    lines.push(`## ${s.title}`, "");
    for (const l of s.leaks) lines.push(`- LEAK ${l}`);
    for (const n of s.notes) lines.push(`- ${n}`);
    lines.push("");
  }
  lines.push(leaks === 0 ? "LEDGER: CLEAN" : `LEDGER: LEAK (${leaks})`);
  const text = `${lines.join("\n")}\n`;
  const file = join(world.dir, ledgerFileName(readdirSync(world.dir)));
  writeFileSync(file, text);
  return { text, leaks, file };
};
