/**
 * The ledger: what a world's runs left behind, in five sections. Any LEAK
 * line fails the verdict. Written to <world>/LEDGER.md.
 */
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { REPO_ROOT, sh } from "./lib.ts";
import {
  checkoutStatus,
  listContainers,
  listImages,
  listTmpEntries,
  observations,
  remoteRefs,
  worldContainer,
  type Engine,
  type World,
} from "./world.ts";

interface Section {
  readonly title: string;
  readonly leaks: string[];
  readonly notes: string[];
}

const git = (world: World, ...args: string[]): string =>
  sh("git", args, { cwd: world.project }).stdout.trim();

/** Branch names Sandcastle generates for temp branches: <ts>-<6hex>. */
const TEMP_BRANCH = /^sandcastle\/(.+\/)?\d{8}-\d{6}-[0-9a-f]{6}$/;

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
    notes: leaks.length ? [] : ["none"],
  };
};

const containersAndImages = (world: World): Section => {
  const leaks: string[] = [];
  const notes: string[] = [];
  const observed = new Set(observations(world).map((o) => o.container));
  for (const c of listContainers()) {
    if (world.baseline.containers.includes(c)) continue;
    const [engine, name] = c.split(":") as [Engine, string];
    if (observed.has(c) || worldContainer(world, engine, name))
      leaks.push(`container ${c} still exists`);
    else notes.push(`container ${c} is not this world's (no mount inside it)`);
  }
  notes.push(`containers this world started: ${observed.size}`);
  for (const img of listImages()) {
    if (world.baseline.images.includes(img)) continue;
    const ref = img.slice(img.indexOf(":") + 1, img.lastIndexOf("@"));
    if (ref.includes(world.runId))
      notes.push(`image ${img}: this world's, cleanup removes it`);
    else if (/^(localhost\/)?sandcastle:/.test(ref))
      leaks.push(`image ${img}: built since the world began, outside its name`);
    else
      notes.push(`image ${img}: new since the world began, not attributable`);
  }
  return { title: "(c) Leftover containers and images", leaks, notes };
};

/** Files under `dir`, relative, skipping noisy caches. */
const filesUnder = (dir: string, prefix = ""): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    const rel = join(prefix, name);
    return statSync(p).isDirectory() ? filesUnder(p, rel) : [rel];
  });
};

const hostFiles = (world: World): Section => {
  const leaks: string[] = [];
  const notes: string[] = [];
  const before = new Set(world.baseline.checkoutStatus);
  for (const line of checkoutStatus()) {
    if (!before.has(line)) leaks.push(`Sandcastle checkout changed: ${line}`);
  }
  for (const entry of listTmpEntries()) {
    if (!world.baseline.tmpEntries.includes(entry))
      leaks.push(`temp entry $TMPDIR/${entry} left behind`);
  }
  // Anything under the real HOME named after this run came from inside it.
  const found = sh(
    "find",
    [
      homedir(),
      "-maxdepth",
      "4",
      "(",
      "-name",
      "node_modules",
      "-o",
      "-name",
      ".git",
      "-o",
      "-name",
      "repos",
      "-o",
      "-name",
      ".cache",
      ")",
      "-prune",
      "-o",
      "-name",
      `*${world.runId}*`,
      "-print",
    ],
    { timeoutMs: 60_000 },
  )
    .stdout.split("\n")
    .filter(Boolean);
  for (const f of found) leaks.push(`real HOME: ${f}`);
  const home = filesUnder(world.home);
  notes.push(
    home.length
      ? `written to the world's HOME (a user's ~ would get these):\n${home.map((f) => `      ~/${f}`).join("\n")}`
      : "nothing written to the world's HOME",
  );
  return { title: "(d) Host files outside the world", leaks, notes };
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
      "no container observed, so this section proves nothing for this world (remote sandboxes are not observable)",
    );
  return { title: "(e) Env vars and keys in the sandbox", leaks, notes };
};

/** Run the ledger for `world`, write LEDGER.md, return the number of leaks. */
export const runLedger = (world: World): { text: string; leaks: number } => {
  const sections = [
    gitState(world),
    worktrees(world),
    containersAndImages(world),
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
  const text = lines.join("\n") + "\n";
  writeFileSync(join(world.dir, "LEDGER.md"), text);
  return { text, leaks };
};
