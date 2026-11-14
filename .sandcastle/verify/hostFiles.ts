/**
 * The ledger's section (d): host files outside the world. The Sandcastle
 * checkout, the world's own and the shared TMPDIR, the real HOME, and what
 * the world's HOME was given.
 */
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { sharedTmpEntryIsWorlds } from "./attribution.ts";
import type { Section } from "./ledgerSection.ts";
import { sh } from "./lib.ts";
import { checkoutStatus, listTmpEntries, worldTmp } from "./world.ts";
import type { World } from "./world.ts";

/** The first 64 KB of up to 20 files at `path` (a file, or a dir two levels deep). */
const sampleContents = (path: string): string[] => {
  const out: string[] = [];
  const read = (p: string) => {
    try {
      const buf = Buffer.alloc(64 * 1024);
      const fd = openSync(p, "r");
      const n = readSync(fd, buf, 0, buf.length, 0);
      closeSync(fd);
      out.push(buf.subarray(0, n).toString("latin1"));
    } catch {
      // unreadable: says nothing either way
    }
  };
  const walk = (p: string, depth: number) => {
    if (out.length >= 20) return;
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isFile()) {
      read(p);
      return;
    }
    if (!st.isDirectory() || depth > 2) return;
    try {
      for (const n of readdirSync(p)) walk(join(p, n), depth + 1);
    } catch {
      // unreadable
    }
  };
  walk(path, 0);
  return out;
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

/** Lines of `git status` in the Sandcastle checkout that weren't there before. */
const checkoutChanges = (world: World): string[] => {
  const before = new Set(world.baseline.checkoutStatus);
  return checkoutStatus()
    .filter((line) => !before.has(line))
    .map((line) => `Sandcastle checkout changed: ${line}`);
};

/**
 * The world's verbs run with TMPDIR=<world>/tmp: whatever Sandcastle left
 * there is this world's.
 */
const worldTmpLeaks = (world: World): string[] => {
  const tmp = worldTmp(world);
  return listTmpEntries(tmp).map(
    (entry) =>
      `temp entry ${relative(world.dir, join(tmp, entry))} left behind`,
  );
};

/**
 * The shared $TMPDIR: other worlds and `npm test` write here too, so only
 * an entry that names this world counts.
 */
const sharedTmp = (world: World): { leaks: string[]; note: string } => {
  const leaks: string[] = [];
  const others: string[] = [];
  for (const entry of listTmpEntries()) {
    if (world.baseline.tmpEntries.includes(entry)) continue;
    if (
      sharedTmpEntryIsWorlds(
        entry,
        sampleContents(join(tmpdir(), entry)),
        world,
      )
    )
      leaks.push(`temp entry $TMPDIR/${entry} left behind (names this world)`);
    else others.push(entry);
  }
  const note =
    others.length > 0
      ? `${others.length} new Sandcastle temp entr${others.length === 1 ? "y" : "ies"} in the shared $TMPDIR, none naming this world (other worlds or test runs): ${others.slice(0, 5).join(", ")}${others.length > 5 ? ", …" : ""}`
      : "no new Sandcastle temp entries in the shared $TMPDIR";
  return { leaks, note };
};

/** Anything under the real HOME named after this run came from inside it. */
const realHomeLeaks = (world: World): string[] =>
  sh(
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
    .filter(Boolean)
    .map((f) => `real HOME: ${f}`);

export const hostFiles = (world: World): Section => {
  const checkout = checkoutChanges(world);
  const ownTmp = worldTmpLeaks(world);
  const shared = sharedTmp(world);
  const leaks = [
    ...checkout,
    ...ownTmp,
    ...shared.leaks,
    ...realHomeLeaks(world),
  ];
  const home = filesUnder(world.home);
  const notes = [
    shared.note,
    home.length > 0
      ? `written to the world's HOME (a user's ~ would get these):\n${home.map((f) => `      ~/${f}`).join("\n")}`
      : "nothing written to the world's HOME",
  ];
  return { title: "(d) Host files outside the world", leaks, notes };
};
