/**
 * Creating, saving and loading worlds: `world.json` under
 * $TMPDIR/sandcastle-verify/<run id>/, and the scratch project it describes.
 */
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { WorldSpan } from "./attribution.ts";
import { redact, REPO_ROOT, sh } from "./lib.ts";
import {
  checkoutStatus,
  listContainers,
  listImages,
  listTmpEntries,
  remoteRefs,
} from "./machine.ts";

export const WORLDS_ROOT = join(tmpdir(), "sandcastle-verify");

export interface Baseline {
  readonly remoteRefs: Record<string, string>;
  readonly checkoutStatus: string[];
  readonly containers: string[];
  readonly images: string[];
  readonly tmpEntries: string[];
}

export interface World {
  readonly runId: string;
  readonly dir: string;
  /** The scratch project: run `sandcastle` and scripts here. */
  readonly project: string;
  readonly remote: string;
  /** HOME for everything run in the world. */
  readonly home: string;
  /** TMPDIR for everything run in the world (absent in worlds made before it existed). */
  readonly tmp?: string;
  readonly logs: string;
  /** The image `sandcastle init` / `build-image` builds by default here. */
  readonly image: string;
  readonly sandcastleRoot: string;
  readonly sandcastleCommit: string;
  readonly sandcastleDirty: boolean;
  readonly createdAt: string;
  readonly canary: string;
  readonly baseline: Baseline;
  cleanedAt?: string;
}

const BaselineSchema: z.ZodType<Baseline> = z.object({
  remoteRefs: z.record(z.string(), z.string()),
  checkoutStatus: z.array(z.string()),
  containers: z.array(z.string()),
  images: z.array(z.string()),
  tmpEntries: z.array(z.string()),
});

/** The shape of `world.json`, checked whenever one is read back. */
const WorldSchema: z.ZodType<World> = z.object({
  runId: z.string(),
  dir: z.string(),
  project: z.string(),
  remote: z.string(),
  home: z.string(),
  tmp: z.string().optional(),
  logs: z.string(),
  image: z.string(),
  sandcastleRoot: z.string(),
  sandcastleCommit: z.string(),
  sandcastleDirty: z.boolean(),
  createdAt: z.string(),
  canary: z.string(),
  baseline: BaselineSchema,
  cleanedAt: z.string().optional(),
});

/** Just the lifetime of a world, so a foreign world.json still yields a span. */
const WorldSpanSchema: z.ZodType<WorldSpan> = z.object({
  runId: z.string(),
  createdAt: z.string(),
  cleanedAt: z.string().optional(),
});

const stamp = (d: Date): string =>
  d.toISOString().replaceAll(/[-:]/gu, "").replace("T", "-").slice(0, 15);

const must = (
  command: string,
  args: string[],
  { cwd, timeoutMs }: { readonly cwd: string; readonly timeoutMs?: number },
): string => {
  const r = sh(command, args, { cwd, timeoutMs });
  if (r.code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (exit ${r.code}):\n${redact(r.stderr || r.stdout)}`,
    );
  }
  return r.stdout.trim();
};

/** Pack the Sandcastle under test into `dir`, as npm would publish it. */
const packSandcastle = (dir: string): string =>
  join(
    dir,
    must("npm", ["pack", "--silent", "--pack-destination", dir], {
      cwd: REPO_ROOT,
      timeoutMs: 300_000,
    })
      .split("\n")
      .pop() ?? "",
  );

/**
 * A fresh project at `project` with `tgz` installed, committed and pushed to
 * a new bare `remote`.
 */
const initProject = ({
  project,
  projectName,
  remote,
  tgz,
}: {
  readonly project: string;
  readonly projectName: string;
  readonly remote: string;
  readonly tgz: string;
}): void => {
  writeFileSync(
    join(project, "package.json"),
    `${JSON.stringify(
      { name: projectName, private: true, type: "module" },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(project, ".gitignore"), "node_modules\n");
  writeFileSync(join(project, "README.md"), `# ${projectName}\n`);
  const git = (...args: string[]) => must("git", args, { cwd: project });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "verify@sandcastle.local");
  git("config", "user.name", "Sandcastle Verify");
  must(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
      "--save-dev",
      tgz,
    ],
    { cwd: project, timeoutMs: 600_000 },
  );
  git("add", "-A");
  git("commit", "-q", "-m", "initial commit");
  must("git", ["init", "-q", "--bare", "-b", "main", remote], {
    cwd: dirname(remote),
  });
  git("remote", "add", "origin", remote);
  git("push", "-q", "-u", "origin", "main");
};

/** Create a world from this checkout's current `dist`. */
export const createWorld = (): World => {
  if (!existsSync(join(REPO_ROOT, "dist", "main.js"))) {
    throw new Error(
      "no dist/ build: run `npm run verify:world`, which builds first",
    );
  }
  const now = new Date();
  const runId = `${stamp(now)}-${randomBytes(2).toString("hex")}`;
  const dir = join(WORLDS_ROOT, runId);
  const projectName = `world-${runId}`;
  const project = join(dir, projectName);
  const remote = join(dir, "remote.git");
  const home = join(dir, "home");
  const logs = join(dir, "logs");
  const tmp = join(dir, "tmp");
  for (const d of [project, home, logs, tmp]) {
    mkdirSync(d, { recursive: true });
  }
  initProject({ project, projectName, remote, tgz: packSandcastle(dir) });

  const world: World = {
    runId,
    dir,
    project,
    remote,
    home,
    logs,
    tmp,
    image: `sandcastle:${projectName}`,
    sandcastleRoot: REPO_ROOT,
    sandcastleCommit: must("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }),
    sandcastleDirty: checkoutStatus().length > 0,
    createdAt: now.toISOString(),
    canary: `canary-${randomBytes(12).toString("hex")}`,
    baseline: {
      remoteRefs: remoteRefs(remote),
      checkoutStatus: checkoutStatus(),
      containers: listContainers(),
      images: listImages(),
      tmpEntries: listTmpEntries(),
    },
  };
  saveWorld(world);
  return world;
};

export const saveWorld = (world: World): void => {
  writeFileSync(
    join(world.dir, "world.json"),
    `${JSON.stringify(world, null, 2)}\n`,
  );
};

/** The world `runId`, which this checkout must have created. */
export const loadWorld = (runId: string | undefined): World => {
  if (runId === undefined || !/^\d{8}-\d{6}-[0-9a-f]{4}$/u.test(runId)) {
    throw new Error(
      `a run id is required (the one \`npm run verify:world\` printed), got ${JSON.stringify(runId ?? "")}`,
    );
  }
  const file = join(WORLDS_ROOT, runId, "world.json");
  if (!existsSync(file)) {
    throw new Error(`no world ${runId} under ${WORLDS_ROOT}`);
  }
  const world = WorldSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (world.sandcastleRoot !== REPO_ROOT) {
    throw new Error(
      `world ${runId} belongs to the checkout ${world.sandcastleRoot}, not this one`,
    );
  }
  return world;
};

/** The world's TMPDIR. */
export const worldTmp = (world: World): string =>
  world.tmp ?? join(world.dir, "tmp");

/**
 * Every world on this machine, from any checkout, cleaned up or not: the
 * ledger uses their lifetimes to avoid blaming one world for another's work.
 */
export const allWorldSpans = (): WorldSpan[] =>
  (existsSync(WORLDS_ROOT) ? readdirSync(WORLDS_ROOT) : []).flatMap((id) => {
    try {
      const w = WorldSpanSchema.parse(
        JSON.parse(readFileSync(join(WORLDS_ROOT, id, "world.json"), "utf8")),
      );
      return [
        { runId: w.runId, createdAt: w.createdAt, cleanedAt: w.cleanedAt },
      ];
    } catch {
      return [];
    }
  });

/** Every world this checkout created that has not been cleaned up. */
export const liveWorlds = (): World[] =>
  (existsSync(WORLDS_ROOT) ? readdirSync(WORLDS_ROOT) : [])
    .map((id) => {
      try {
        return loadWorld(id);
      } catch {
        return undefined;
      }
    })
    .filter((w): w is World => w !== undefined && w.cleanedAt === undefined);
