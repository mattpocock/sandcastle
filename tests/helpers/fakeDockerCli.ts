// A fake `docker` CLI, run as a script (`node fakeDockerCli.ts <args>`, Node
// strips the types) by the `docker` wrapper tests/helpers/fakeDocker.ts puts
// first on PATH. A container is a host directory under
// `$FAKE_DOCKER_ROOT/containers/<id>`, and its commands are real `sh`
// processes on the host, each in its own process group, as `docker exec`'s
// are. Paths in the container are host paths, so `$HOME` is
// `<container>/home` (or `<container>/root` with `--user root`).
//
// It knows `run -d`, `exec` (with `-i`, `-d`, `--user`, `-w`, `--env-file`),
// `inspect --type container`, and `rm -f`; anything else succeeds silently.
// `run` starts the entrypoint in a keeper process that removes the container
// when the entrypoint exits, as `--rm` does. Every call's argv goes to
// `calls.jsonl`, and `faults.json` asks for failures (see FakeDockerFaults).
// POSIX only.

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

interface Meta {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly labels: Record<string, string>;
}

const root = process.env["FAKE_DOCKER_ROOT"] ?? "";
const containers = path.join(root, "containers");

const fail = (message: string, code = 1): never => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};

const readJson = async (file: string): Promise<unknown> =>
  readFile(file, "utf8").then(
    (text): unknown => JSON.parse(text),
    () => undefined,
  );

const faults = async (): Promise<Record<string, unknown>> => {
  const value = await readJson(path.join(root, "faults.json"));
  return typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};
};

const isMeta = (value: unknown): value is Meta =>
  typeof value === "object" && value !== null && "id" in value;

/** The container a name or id names, or `undefined`. */
const find = async (ref: string): Promise<Meta | undefined> => {
  const ids = await readdir(containers).catch((): string[] => []);
  const metas = await Promise.all(
    ids.map(async (id) => readJson(path.join(containers, id, "meta.json"))),
  );
  return metas
    .filter((meta) => isMeta(meta))
    .find((meta) => meta.id === ref || meta.name === ref);
};

const dirOf = (meta: Meta): string => path.join(containers, meta.id);

// Kills the recorded groups (the keeper's from `run` on) and their descendants'
// (agents get their own), but not its caller's: the keeper removes it after.
const killTree = (recorded: readonly string[]): void => {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], {
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.trim().split(/\s+/u));
  const inside = new Set(rows.filter((row) => recorded.includes(row[2] ?? "")));
  for (const parent of inside) {
    for (const row of rows) if (row[1] === parent[0]) inside.add(row);
  }
  for (const row of [...inside].filter((r) => r[2] !== String(process.pid))) {
    try {
      process.kill(-Number(row[2]), "SIGKILL");
    } catch {
      // Already gone.
    }
  }
};

const remove = async (meta: Meta): Promise<void> => {
  const groups = await readFile(path.join(dirOf(meta), "groups"), "utf8").catch(
    () => "",
  );
  killTree(groups.split("\n").filter((line) => line !== ""));
  await rm(dirOf(meta), { recursive: true, force: true });
};

const record = async (meta: Meta, pid: number | undefined): Promise<void> => {
  if (pid !== undefined) {
    await appendFile(path.join(dirOf(meta), "groups"), `${String(pid)}\n`);
  }
};

const VALUE_FLAGS = new Set([
  "--name",
  "--label",
  "--entrypoint",
  "--network",
  "--cpus",
  "--memory",
  "--memory-swap",
  "--pids-limit",
  "--user",
  "--cap-add",
  "--cap-drop",
  "-w",
  "--env-file",
]);

/** Splits `args` into flags (each a list of values) and what follows them. */
const parse = (args: readonly string[]) => {
  const flags = new Map<string, string[]>();
  let index = 0;
  while (index < args.length && (args[index] ?? "").startsWith("-")) {
    const flag = args[index] ?? "";
    const value = VALUE_FLAGS.has(flag) ? (args[index + 1] ?? "") : "";
    flags.set(flag, [...(flags.get(flag) ?? []), value]);
    index += VALUE_FLAGS.has(flag) ? 2 : 1;
  }
  return { flags, rest: args.slice(index) };
};

const run = async (args: readonly string[]): Promise<void> => {
  const { flags, rest } = parse(args);
  const [image = "", ...command] = rest;
  const id = randomBytes(32).toString("hex");
  const labels = Object.fromEntries(
    (flags.get("--label") ?? []).map((label) => {
      const at = label.indexOf("=");
      return [label.slice(0, at), label.slice(at + 1)];
    }),
  );
  const meta = { id, name: flags.get("--name")?.[0] ?? id, image, labels };
  await mkdir(path.join(containers, id, "home"), { recursive: true });
  await mkdir(path.join(containers, id, "root"), { recursive: true });
  await writeFile(path.join(containers, id, "meta.json"), JSON.stringify(meta));
  const entrypoint = flags.get("--entrypoint")?.[0] ?? "sh";
  const keeper = spawn(
    process.execPath,
    [
      ...process.execArgv,
      import.meta.filename,
      "__keep",
      id,
      entrypoint,
      ...command,
    ],
    { detached: true, stdio: "ignore" },
  );
  await record(meta, keeper.pid);
  keeper.unref();
  const { execFails } = await faults();
  if (execFails === "run") {
    fail("docker: Error response from daemon: failed to start");
  }
  process.stdout.write(`${id}\n`);
};

/** The entrypoint's keeper: runs it, then removes the container. */
const keep = async ([id = "", ...command]: readonly string[]) => {
  const meta = await find(id);
  if (meta === undefined) {
    return;
  }
  const [file = "sh", ...args] = command;
  const child = spawn(file, args, { detached: true, stdio: "ignore" });
  const closed = once(child, "close");
  await record(meta, child.pid);
  await closed;
  await remove(meta);
};

const envFile = async (file: string | undefined) => {
  if (file === undefined) {
    return {};
  }
  const text = await readFile(file, "utf8");
  return Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
};

/** Where an exec runs, and with what env: `$HOME` is the container's, root's with `--user root`. */
const execEnv = async (meta: Meta, flags: Map<string, string[]>) => {
  const asRoot = flags.get("--user")?.[0] === "root";
  const home = path.join(dirOf(meta), asRoot ? "root" : "home");
  const env = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: home,
    ...(await envFile(flags.get("--env-file")?.[0])),
  };
  return { cwd: flags.get("-w")?.[0] ?? home, env };
};

const exec = async (args: readonly string[]): Promise<void> => {
  const { flags, rest } = parse(args);
  const [ref = "", file = "sh", ...argv] = rest;
  const meta = await find(ref);
  if (meta === undefined) {
    fail(`Error response from daemon: No such container: ${ref}`);
    return;
  }
  const { execFails } = await faults();
  if (typeof execFails === "string" && argv.join(" ").includes(execFails)) {
    fail("Error response from daemon: disk full");
  }
  const { cwd, env } = await execEnv(meta, flags);
  const detached = flags.has("-d");
  const child = spawn(file, argv, {
    cwd,
    env,
    detached: true,
    stdio: detached
      ? "ignore"
      : [flags.has("-i") ? "inherit" : "ignore", "inherit", "inherit"],
  });
  const closed: Promise<unknown[]> = once(child, "close");
  await record(meta, child.pid);
  if (detached) {
    child.unref();
    return;
  }
  const [code] = await closed;
  process.exit(typeof code === "number" ? code : 137);
};

const inspect = async (args: readonly string[]): Promise<void> => {
  const ref = args.at(-1) ?? "";
  const meta = await find(ref);
  if (meta === undefined) {
    fail(`Error: No such container: ${ref}`);
    return;
  }
  process.stdout.write(
    `${JSON.stringify([
      {
        Id: meta.id,
        Name: `/${meta.name}`,
        State: { Status: "running", Running: true },
        Config: { Image: meta.image, Labels: meta.labels },
      },
    ])}\n`,
  );
};

const removeCommand = async (args: readonly string[]): Promise<void> => {
  const ref = args.at(-1) ?? "";
  const meta = await find(ref);
  if (meta !== undefined) {
    await remove(meta);
    process.stdout.write(`${ref}\n`);
  }
};

const main = async (): Promise<void> => {
  const [verb = "", ...args] = process.argv.slice(2);
  if (verb === "__keep") {
    await keep(args);
    return;
  }
  await appendFile(
    path.join(root, "calls.jsonl"),
    `${JSON.stringify([verb, ...args])}\n`,
  );
  const { daemonDown } = await faults();
  if (daemonDown === true) {
    fail(
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    );
  }
  const verbs: Record<string, (rest: readonly string[]) => Promise<void>> = {
    run,
    exec,
    inspect,
    rm: removeCommand,
  };
  await verbs[verb]?.(args);
};

await main();
