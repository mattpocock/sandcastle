/**
 * A world: one run's isolated playground. A scratch git project with a local
 * bare remote, the Sandcastle under test packed and installed into it, and a
 * HOME and a TMPDIR of its own, all under $TMPDIR/sandcastle-verify/<run id>/.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { WorldSpan } from "./attribution.ts";
import { classifyEnv } from "./envLeaks.ts";
import type { EnvLeak } from "./envLeaks.ts";
import { redact, REPO_ROOT, secretsIn, sh } from "./lib.ts";

export const WORLDS_ROOT = join(tmpdir(), "sandcastle-verify");
const REAL_HOME = homedir();

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

const stamp = (d: Date): string =>
  d.toISOString().replaceAll(/[-:]/gu, "").replace("T", "-").slice(0, 15);

const must = (
  command: string,
  args: string[],
  cwd: string,
  timeoutMs?: number,
): string => {
  const r = sh(command, args, { cwd, timeoutMs });
  if (r.code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (exit ${r.code}):\n${redact(r.stderr || r.stdout)}`,
    );
  }
  return r.stdout.trim();
};

// --- Observing the machine ---------------------------------------------------

export const ENGINES = ["docker", "podman"] as const;
export type Engine = (typeof ENGINES)[number];

export const engineUp = (engine: Engine): boolean =>
  sh(engine, ["info"], { timeoutMs: 30_000 }).code === 0;

/** `engine:name` for every container named sandcastle-*. */
export const listContainers = (): string[] =>
  ENGINES.filter(engineUp).flatMap((engine) =>
    sh(engine, [
      "ps",
      "-a",
      "--filter",
      "name=^sandcastle-",
      "--format",
      "{{.Names}}",
    ])
      .stdout.split("\n")
      .filter(Boolean)
      .map((name) => `${engine}:${name}`),
  );

/** `engine:repo:tag@id` for every image. */
export const listImages = (): string[] =>
  ENGINES.filter(engineUp).flatMap((engine) =>
    sh(engine, ["images", "--format", "{{.Repository}}:{{.Tag}}@{{.ID}}"])
      .stdout.split("\n")
      .filter(Boolean)
      .map((img) => `${engine}:${img}`),
  );

/** Sandcastle's own temp entries (sandcastle-bundle-*, -git-*, -copyin-*) in `dir`. */
export const listTmpEntries = (dir: string = tmpdir()): string[] =>
  existsSync(dir)
    ? readdirSync(dir).filter((n) =>
        /^sandcastle-(bundle|git|copyin)-/u.test(n),
      )
    : [];

/** When `engine` built image `id`, as the engine prints it. */
export const imageCreated = (
  engine: Engine,
  id: string,
): string | undefined => {
  const r = sh(engine, ["image", "inspect", id, "--format", "{{.Created}}"]);
  return r.code === 0 ? r.stdout.trim() || undefined : undefined;
};

export const remoteRefs = (remote: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of sh(
    "git",
    ["for-each-ref", "--format=%(refname) %(objectname)"],
    {
      cwd: remote,
    },
  ).stdout.split("\n")) {
    const [ref, sha] = line.split(" ");
    if (ref && sha) {
      out[ref] = sha;
    }
  }
  return out;
};

export const checkoutStatus = (): string[] =>
  sh("git", ["status", "--porcelain"], { cwd: REPO_ROOT })
    .stdout.split("\n")
    .filter(Boolean);

// --- Creating and loading ------------------------------------------------------

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

  // The Sandcastle under test, packed as npm would publish it.
  const tgz = must(
    "npm",
    ["pack", "--silent", "--pack-destination", dir],
    REPO_ROOT,
    300_000,
  )
    .split("\n")
    .pop()!;

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
  must("git", ["init", "-q", "-b", "main"], project);
  must("git", ["config", "user.email", "verify@sandcastle.local"], project);
  must("git", ["config", "user.name", "Sandcastle Verify"], project);
  must(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
      "--save-dev",
      join(dir, tgz),
    ],
    project,
    600_000,
  );
  must("git", ["add", "-A"], project);
  must("git", ["commit", "-q", "-m", "initial commit"], project);
  must("git", ["init", "-q", "--bare", "-b", "main", remote], dir);
  must("git", ["remote", "add", "origin", remote], project);
  must("git", ["push", "-q", "-u", "origin", "main"], project);

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
    sandcastleCommit: must("git", ["rev-parse", "HEAD"], REPO_ROOT),
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
  if (!runId || !/^\d{8}-\d{6}-[0-9a-f]{4}$/u.test(runId)) {
    throw new Error(
      `a run id is required (the one \`npm run verify:world\` printed), got ${JSON.stringify(runId ?? "")}`,
    );
  }
  const file = join(WORLDS_ROOT, runId, "world.json");
  if (!existsSync(file)) {
    throw new Error(`no world ${runId} under ${WORLDS_ROOT}`);
  }
  const world = JSON.parse(readFileSync(file, "utf8")) as World;
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
      const w = JSON.parse(
        readFileSync(join(WORLDS_ROOT, id, "world.json"), "utf8"),
      ) as World;
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
    .filter((w): w is World => Boolean(w) && !w.cleanedAt);

// --- Running inside a world ------------------------------------------------------

/**
 * The environment of every process run in a world: this shell's own (keys
 * included, as a user's would be), HOME and TMPDIR moved into the world so
 * host writes land where the ledger can tell them from other worlds', and a
 * canary that must never reach a sandbox. Tool config that lives under ~
 * stays reachable.
 */
const worldEnv = (world: World): NodeJS.ProcessEnv => {
  const real = (p: string) => join(REAL_HOME, p);
  const tmp = worldTmp(world);
  return {
    ...process.env,
    HOME: world.home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? real(".docker"),
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? real(".config"),
    XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? real(".local/share"),
    npm_config_cache: process.env.npm_config_cache ?? real(".npm"),
    SANDCASTLE_VERIFY_RUN: world.runId,
    SANDCASTLE_VERIFY_CANARY_TOKEN: world.canary,
  };
};

/** Keys the world's project declares in `.sandcastle/.env` (names only). */
export const declaredKeys = (world: World): Set<string> => {
  const file = join(world.project, ".sandcastle", ".env");
  if (!existsSync(file)) {
    return new Set();
  }
  return new Set(
    readFileSync(file, "utf8")
      .split("\n")
      .map((l) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(l)?.[1])
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

const inspect = (engine: Engine, name: string) => {
  const r = sh(engine, ["inspect", name, "--format", "{{json .}}"]);
  if (r.code !== 0) {
    return undefined;
  }
  const j = JSON.parse(r.stdout) as {
    Config?: { Env?: string[]; Image?: string };
    Mounts?: { Source?: string }[];
  };
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

/**
 * Run a command inside the world: cwd is the project, env is the world's.
 * Output streams through, redacted, and is logged under logs/. While it runs,
 * every sandcastle-* container that mounts the world is inspected once and its
 * env checked for leaks, into observed.jsonl (names only, never values).
 */
export const runInWorld = async (
  world: World,
  label: string,
  command: string,
  args: readonly string[],
): Promise<number> => {
  mkdirSync(worldTmp(world), { recursive: true });
  const env = worldEnv(world);
  const seq = readdirSync(world.logs).length + 1;
  const log = join(world.logs, `${String(seq).padStart(2, "0")}-${label}.log`);
  appendFileSync(log, `$ ${[command, ...args].join(" ")}\n`);

  const seen = new Set<string>(world.baseline.containers);
  const engines = ENGINES.filter(engineUp);
  const hostSecrets = secretsIn(process.env);
  const observe = () => {
    for (const engine of engines) {
      const names = sh(engine, [
        "ps",
        "--filter",
        "name=^sandcastle-",
        "--format",
        "{{.Names}}",
      ])
        .stdout.split("\n")
        .filter(Boolean);
      for (const name of names) {
        const key = `${engine}:${name}`;
        if (seen.has(key)) {
          continue;
        }
        const info = worldContainer(world, engine, name);
        if (!info) {
          continue;
        }
        seen.add(key);
        const obs: Observation = {
          at: new Date().toISOString(),
          container: key,
          image: info.image,
          envNames: info.env.map(([k]) => k).sort(),
          leaks: classifyEnv(info.env, {
            declared: declaredKeys(world),
            hostSecrets,
            canary: world.canary,
          }),
        };
        appendFileSync(
          join(world.dir, "observed.jsonl"),
          `${JSON.stringify(obs)}\n`,
        );
        const verdict =
          obs.leaks.length === 0
            ? "env ok"
            : `ENV LEAK: ${obs.leaks.map((l) => l.name).join(", ")}`;
        process.stderr.write(
          `[verify] observed ${key} (${info.image}): ${verdict}\n`,
        );
      }
    }
  };

  const child = spawn(command, args, {
    cwd: world.project,
    env,
    stdio: ["inherit", "pipe", "pipe"],
  });
  const pipe = (from: NodeJS.ReadableStream, to: NodeJS.WriteStream) => {
    let buf = "";
    from.setEncoding("utf8");
    from.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const line of lines) {
        const clean = `${redact(line).split(world.canary).join("<CANARY>")}\n`;
        to.write(clean);
        appendFileSync(log, clean);
      }
    });
    from.on("end", () => {
      if (buf) {
        const clean = `${redact(buf)}\n`;
        to.write(clean);
        appendFileSync(log, clean);
      }
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  const timer = setInterval(observe, 1000);
  const code = await new Promise<number>((resolve) => {
    child.on("close", (c) => {
      resolve(c ?? 1);
    });
    child.on("error", (e) => {
      appendFileSync(log, `[verify] ${e.message}\n`);
      resolve(127);
    });
  });
  clearInterval(timer);
  appendFileSync(log, `[exit ${code}]\n`);
  process.stderr.write(`[verify] exit ${code}; log: ${log}\n`);
  return code;
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
    .map((l) => JSON.parse(l) as Observation);
};
