/**
 * A world: one run's isolated playground. A scratch git project with a local
 * bare remote, the Sandcastle under test packed and installed into it, and a
 * HOME and a TMPDIR of its own, all under $TMPDIR/sandcastle-verify/<run id>/.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { classifyEnv } from "./envLeaks.ts";
import { redact, secretsIn, sh } from "./lib.ts";
import { ENGINES, engineUp } from "./machine.ts";
import { observeWorldBwraps } from "./nativeSandboxes.ts";
import { declaredKeys, worldContainer } from "./observations.ts";
import type { Observation } from "./observations.ts";
import { worldTmp } from "./worldStore.ts";
import type { World } from "./worldStore.ts";

export {
  checkoutStatus,
  engineEntries,
  engineUp,
  ENGINES,
  imageCreated,
  listContainers,
  listImages,
  listTmpEntries,
  remoteRefs,
} from "./machine.ts";
export type { Engine } from "./machine.ts";
export { declaredKeys, observations, worldContainer } from "./observations.ts";
export type { Observation } from "./observations.ts";
export {
  allWorldSpans,
  createWorld,
  liveWorlds,
  loadWorld,
  saveWorld,
  WORLDS_ROOT,
  worldTmp,
} from "./worldStore.ts";
export type { Baseline, World } from "./worldStore.ts";

const REAL_HOME = homedir();

// --- Running inside a world ------------------------------------------------------

/** `p` under the user's real home, not the world's. */
const inRealHome = (p: string): string => join(REAL_HOME, p);

/**
 * The environment of every process run in a world: this shell's own (keys
 * included, as a user's would be), HOME and TMPDIR moved into the world so
 * host writes land where the ledger can tell them from other worlds', and a
 * canary that must never reach a sandbox. Tool config that lives under ~
 * stays reachable.
 */
const worldEnv = (world: World): NodeJS.ProcessEnv => {
  const tmp = worldTmp(world);
  return {
    ...process.env,
    HOME: world.home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? inRealHome(".docker"),
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? inRealHome(".config"),
    XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? inRealHome(".local/share"),
    npm_config_cache: process.env.npm_config_cache ?? inRealHome(".npm"),
    SANDCASTLE_VERIFY_RUN: world.runId,
    SANDCASTLE_VERIFY_CANARY_TOKEN: world.canary,
  };
};

/** Append an observation to observed.jsonl and print its verdict. */
const recordObservation = (world: World, obs: Observation): void => {
  appendFileSync(join(world.dir, "observed.jsonl"), `${JSON.stringify(obs)}\n`);
  const verdict =
    obs.leaks.length === 0
      ? "env ok"
      : `ENV LEAK: ${obs.leaks.map((l) => l.name).join(", ")}`;
  process.stderr.write(
    `[verify] observed ${obs.container} (${obs.image}): ${verdict}\n`,
  );
};

/** Observes the world's new bwraps (see nativeSandboxes.ts), one tick at a time. */
const bwrapObserver = (
  world: World,
  hostSecrets: ReadonlyMap<string, string>,
  seen: Set<string>,
): (() => Promise<void>) => {
  let inFlight = false;
  return async () => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      const found = await observeWorldBwraps(
        world.dir,
        { declared: declaredKeys(world), hostSecrets, canary: world.canary },
        seen,
      );
      for (const o of found) {
        recordObservation(world, {
          at: new Date().toISOString(),
          container: o.key,
          image: `host toolchain, ${o.command}`,
          envNames: o.envNames,
          leaks: o.leaks,
        });
      }
    } finally {
      inFlight = false;
    }
  };
};

/**
 * Observes the world's new sandcastle-* containers on `engines`, one tick at a
 * time: each is inspected once and, if it mounts the world, its env checked.
 */
const containerObserver = (
  world: World,
  hostSecrets: ReadonlyMap<string, string>,
  seen: Set<string>,
): (() => void) => {
  const engines = ENGINES.filter((engine) => engineUp(engine));
  return () => {
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
        recordObservation(world, {
          at: new Date().toISOString(),
          container: key,
          image: info.image,
          envNames: info.env.map(([k]) => k).sort(),
          leaks: classifyEnv(info.env, {
            declared: declaredKeys(world),
            hostSecrets,
            canary: world.canary,
          }),
        });
      }
    }
  };
};

/** Stream `from` into `to` and the log, line by line, redacted. */
const pipeRedacted = (
  from: NodeJS.ReadableStream,
  to: NodeJS.WriteStream,
  { log, canary }: { readonly log: string; readonly canary: string },
): void => {
  let buf = "";
  from.setEncoding("utf8");
  from.on("data", (chunk: string) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const clean = `${redact(line).split(canary).join("<CANARY>")}\n`;
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

/** A command to run inside the world; `label` names its log file. */
export interface WorldCommand {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Run a command inside the world: cwd is the project, env is the world's.
 * Output streams through, redacted, and is logged under logs/. While it runs,
 * every sandcastle-* container that mounts the world, and every bwrap that
 * names a path in it, is inspected once and its env checked for leaks, into
 * observed.jsonl (names only, never values).
 */
export const runInWorld = async (
  world: World,
  { label, command, args }: WorldCommand,
): Promise<number> => {
  mkdirSync(worldTmp(world), { recursive: true });
  const env = worldEnv(world);
  const seq = readdirSync(world.logs).length + 1;
  const log = join(world.logs, `${String(seq).padStart(2, "0")}-${label}.log`);
  appendFileSync(log, `$ ${[command, ...args].join(" ")}\n`);

  const seen = new Set<string>(world.baseline.containers);
  const hostSecrets = secretsIn(process.env);
  const observeContainers = containerObserver(world, hostSecrets, seen);
  const observeBwraps = bwrapObserver(world, hostSecrets, seen);
  const observe = () => {
    observeContainers();
    // Native sandboxes: no container, so read the sandboxed process's env.
    void observeBwraps();
  };

  const child = spawn(command, args, {
    cwd: world.project,
    env,
    stdio: ["inherit", "pipe", "pipe"],
  });
  pipeRedacted(child.stdout, process.stdout, { log, canary: world.canary });
  pipeRedacted(child.stderr, process.stderr, { log, canary: world.canary });
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
