/**
 * Observing the machine a world runs on: the container engines, their
 * sandcastle-* containers and images, Sandcastle's temp entries, and git state.
 */
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { REPO_ROOT, sh } from "./lib.ts";

export const ENGINES = ["docker", "podman"] as const;
export type Engine = (typeof ENGINES)[number];

/**
 * Split `<engine>:<rest>` entries, as listContainers/listImages print them,
 * keeping the whole entry too. Entries naming no known engine are dropped.
 */
export const engineEntries = (
  entries: readonly string[],
): {
  readonly entry: string;
  readonly engine: Engine;
  readonly rest: string;
}[] =>
  entries.flatMap((entry) => {
    const at = entry.indexOf(":");
    const engine = ENGINES.find((e) => e === entry.slice(0, at));
    return engine === undefined
      ? []
      : [{ entry, engine, rest: entry.slice(at + 1) }];
  });

export const engineUp = (engine: Engine): boolean =>
  sh(engine, ["info"], { timeoutMs: 30_000 }).code === 0;

/** `engine:name` for every container named sandcastle-*. */
export const listContainers = (): string[] =>
  ENGINES.filter((engine) => engineUp(engine)).flatMap((engine) =>
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
  ENGINES.filter((engine) => engineUp(engine)).flatMap((engine) =>
    sh(engine, ["images", "--format", "{{.Repository}}:{{.Tag}}@{{.ID}}"])
      .stdout.split("\n")
      .filter(Boolean)
      .map((img) => `${engine}:${img}`),
  );

/** Sandcastle's own temp entries (sandcastle-bundle-*, -git-*, -copyin-*) in `dir`. */
export const listTmpEntries = (dir: string = tmpdir()): string[] =>
  existsSync(dir)
    ? readdirSync(dir).filter((n) =>
        /^sandcastle-(?:bundle|git|copyin)-/u.test(n),
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
