/**
 * The verify harness (see .agents/skills/verify/SKILL.md). One script, one
 * verb per job; every verb after `world` takes the run id first.
 *
 *   npm run verify:world                      build, create a world, print its run id
 *   npm run -s verify -- doctor [run]          prerequisites: engines, keys, cheap models
 *   npm run -s verify -- sandcastle <run> …    the world's installed `sandcastle` CLI
 *   npm run -s verify -- tsx <run> <file> …    a TypeScript file, e.g. .sandcastle/main.ts
 *   npm run -s verify -- sh <run> <cmd> …      any command, inside the world
 *   npm run -s verify -- ledger <run>          what the runs left behind (LEDGER-<n>.md); exit 1 on a leak
 *   npm run -s verify -- cleanup <run>|--all   remove the world's containers, images, worktrees
 *   npm run -s verify -- dir <run>             the world's directory
 *   npm run -s verify -- reap [--delete] [<provider>:<id>…]
 *                                             sandboxes alive on each remote provider; --delete removes Sandcastle's
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_KEYS,
  AGENTS,
  cheapAgentCall,
  keysFile,
  loadKeys,
  missingKeys,
  redact,
  REPO_ROOT,
  SANDBOX_NEEDS,
  SANDBOXES,
  sh,
  works,
} from "./lib.ts";
import { runLedger } from "./ledger.ts";
import { reapVerb } from "./remoteAccounts.ts";
import {
  checkoutStatus,
  createWorld,
  engineEntries,
  ENGINES,
  engineUp,
  listContainers,
  listImages,
  liveWorlds,
  loadWorld,
  observations,
  runInWorld,
  saveWorld,
  worldContainer,
  worldTmp,
} from "./world.ts";
import type { World } from "./world.ts";

loadKeys();
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const [verb, ...rest] = process.argv.slice(2);

/** Checks the world is live and was built from the current checkout. */
const doctorWorld = (
  world: World,
  ok: (good: boolean, line: string) => void,
): void => {
  ok(
    world.cleanedAt === undefined,
    `world ${world.runId} at ${world.dir}${world.cleanedAt === undefined ? "" : " was cleaned up"}`,
  );
  const head = sh("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
  }).stdout.trim();
  const same =
    head === world.sandcastleCommit &&
    !world.sandcastleDirty &&
    checkoutStatus().length === 0;
  console.log(
    `${same ? "ok  " : "warn"} world built from ${world.sandcastleCommit.slice(0, 7)}${world.sandcastleDirty ? "+dirty" : ""}; checkout is at ${head.slice(0, 7)}${same ? "" : ": make a new world to test the checkout as it is now"}`,
  );
};

/** Prints which sandboxes can be verified, and what the rest are missing. */
const doctorSandboxes = (): void => {
  console.log("\nsandboxes:");
  for (const s of SANDBOXES) {
    const need = SANDBOX_NEEDS[s];
    const missing = missingKeys(need.keys);
    const cmdOk = !need.command || works(need.command);
    const why = [
      ...(cmdOk ? [] : [`\`${need.command!.join(" ")}\` fails`]),
      ...(missing.length > 0 ? [`missing ${missing.join(", ")}`] : []),
    ];
    console.log(
      `  ${s.padEnd(8)} ${why.length > 0 ? `UNVERIFIABLE (${why.join("; ")})` : "ready"}`,
    );
  }
};

/** Prints each agent's cheapest factory call, and its missing keys. */
const doctorAgents = (): void => {
  console.log(
    "\nagents (factory call on the cheapest model; VERIFY_MODEL swaps the model and drops its options):",
  );
  for (const a of AGENTS) {
    const missing = missingKeys(AGENT_KEYS[a]);
    console.log(
      `  ${a.padEnd(10)} ${cheapAgentCall(a).padEnd(56)} ${missing.length > 0 ? `UNVERIFIABLE (missing ${missing.join(", ")})` : "ready"}`,
    );
  }
};

const doctor = (world?: World): number => {
  let fails = 0;
  const ok = (good: boolean, line: string) => {
    if (!good) fails++;
    console.log(`${good ? "ok  " : "FAIL"} ${line}`);
  };
  if (world) {
    doctorWorld(world, ok);
  }
  const file = keysFile();
  console.log(`keys file: ${file ?? "none (keys come from the shell only)"}`);
  doctorSandboxes();
  doctorAgents();
  console.log(
    "\nA missing key is Matt's to add: .sandcastle/setup-verify-keys.sh",
  );
  return fails === 0 ? 0 : 1;
};

/** Removes the containers this world started; returns what went. */
const removeContainers = (world: World): string[] => {
  const removed: string[] = [];
  const observed = new Set(observations(world).map((o) => o.container));
  for (const { entry: c, engine, rest: name } of engineEntries(
    listContainers(),
  )) {
    if (world.baseline.containers.includes(c)) continue;
    if (observed.has(c) || worldContainer(world, engine, name)) {
      if (sh(engine, ["rm", "-f", name]).code === 0)
        removed.push(`container ${c}`);
    }
  }
  return removed;
};

/** Removes the images tagged with this world's run id; returns what went. */
const removeImages = (world: World): string[] => {
  const removed: string[] = [];
  for (const engine of ENGINES.filter(engineUp)) {
    for (const img of listImages()) {
      if (!img.startsWith(`${engine}:`)) continue;
      const ref = img.slice(engine.length + 1, img.lastIndexOf("@"));
      if (
        ref.includes(world.runId) &&
        sh(engine, ["rmi", "-f", ref]).code === 0
      )
        removed.push(`image ${engine}:${ref}`);
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
  for (const p of [world.project, world.remote, world.home, worldTmp(world)])
    rmSync(p, { recursive: true, force: true });
  for (const f of sh("ls", [world.dir]).stdout.split("\n")) {
    if (f.endsWith(".tgz")) rmSync(join(world.dir, f), { force: true });
  }
};

const cleanup = (world: World): void => {
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

/** `world`: creates a world and prints its run id. */
const newWorld = (): number => {
  const world = createWorld();
  console.error(`world:    ${world.dir}`);
  console.error(`project:  ${world.project}   (cwd of every verb)`);
  console.error(`remote:   ${world.remote}   (origin)`);
  console.error(`home:     ${world.home}   (HOME of every verb)`);
  console.error(`image:    ${world.image}   (the default image name here)`);
  console.error(
    `build:    @ai-hero/sandcastle from ${world.sandcastleCommit.slice(0, 7)}${world.sandcastleDirty ? " + uncommitted changes" : ""}`,
  );
  console.error(`run id:   ${world.runId}   <- pass it to every later verb`);
  console.log(world.runId);
  return 0;
};

/** `sandcastle`, `tsx` and `sh`: runs a command inside a live world. */
const runIn = async (
  runVerb: "sandcastle" | "tsx" | "sh",
  runArgs: string[],
): Promise<number> => {
  const world = loadWorld(runArgs[0]);
  if (world.cleanedAt !== undefined)
    throw new Error(`world ${world.runId} was cleaned up; make a new one`);
  const args = runArgs.slice(1);
  if (runVerb === "sandcastle") {
    return runInWorld(world, "sandcastle", process.execPath, [
      join(
        world.project,
        "node_modules",
        "@ai-hero",
        "sandcastle",
        "dist",
        "main.js",
      ),
      ...args,
    ]);
  }
  if (args.length === 0)
    throw new Error(
      `usage: ${runVerb} <run> <${runVerb === "tsx" ? "file" : "command"}> [args…]`,
    );
  return runVerb === "tsx"
    ? runInWorld(world, "tsx", TSX, args)
    : runInWorld(world, "sh", args[0], args.slice(1));
};

const main = async (): Promise<number> => {
  switch (verb) {
    case "world": {
      return newWorld();
    }
    case "doctor": {
      return doctor(rest[0] ? loadWorld(rest[0]) : undefined);
    }
    case "sandcastle":
    case "tsx":
    case "sh": {
      return runIn(verb, rest);
    }
    case "ledger": {
      const { text, leaks, file } = await runLedger(loadWorld(rest[0]));
      console.log(text);
      console.error(`[verify] ledger written to ${file}`);
      return leaks === 0 ? 0 : 1;
    }
    case "cleanup": {
      const worlds = rest[0] === "--all" ? liveWorlds() : [loadWorld(rest[0])];
      if (worlds.length === 0) console.log("no live worlds from this checkout");
      for (const w of worlds) cleanup(w);
      return 0;
    }
    case "dir": {
      console.log(loadWorld(rest[0]).dir);
      return 0;
    }
    case "reap": {
      return reapVerb(rest);
    }
    default: {
      console.error(
        "verbs: world | doctor [run] | sandcastle <run> … | tsx <run> <file> … | sh <run> <cmd> … | ledger <run> | cleanup <run>|--all | dir <run> | reap [--delete] [<provider>:<id>…]",
      );
      return 2;
    }
  }
};

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(
      `verify: ${redact(e instanceof Error ? e.message : String(e))}`,
    );
    process.exit(2);
  },
);
