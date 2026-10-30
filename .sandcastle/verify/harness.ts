/**
 * Shared harness for verify checks (see .agents/skills/verify/SKILL.md).
 *
 * A check is one file in this folder that calls `verify()` once. It prints
 * one PASS/FAIL line per assertion and ends on a single RESULT line:
 *
 *   RESULT: VERIFIED       exit 0  every assertion passed
 *   RESULT: FAILED         exit 1  an assertion failed or the check threw
 *   RESULT: UNVERIFIABLE   exit 2  a prerequisite (env var, docker…) is missing
 *
 * Run a check against the local build with:
 *   npm run verify -- .sandcastle/verify/<slug>.ts
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Root of the Sandcastle checkout the check is verifying. */
export const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const CLI = join(REPO_ROOT, "dist", "main.js");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");

/** Thrown when the check cannot run here. The message names what is missing. */
export class Unverifiable extends Error {}

// --- Secret redaction -------------------------------------------------------

const SECRET_KEY = /TOKEN|KEY|SECRET|PASSWORD/i;

/** Replace the value of every secret-looking env var with `<KEY>`. */
export const redact = (text: string): string => {
  let out = text;
  for (const [key, value] of Object.entries(process.env)) {
    if (value && value.length >= 8 && SECRET_KEY.test(key)) {
      out = out.split(value).join(`<${key}>`);
    }
  }
  return out;
};

/** The last `lines` lines of `text`, redacted and indented for the report. */
export const tail = (text: string, lines = 15): string =>
  redact(text)
    .trimEnd()
    .split("\n")
    .slice(-lines)
    .map((l) => `    | ${l}`)
    .join("\n");

// --- Prerequisites ----------------------------------------------------------

/** Unverifiable unless every key is set (in the shell or .sandcastle/.env). */
export const requireEnv = (...keys: string[]): void => {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Unverifiable(`missing env var(s): ${missing.join(", ")}`);
  }
};

/** Unverifiable unless `command args…` exits 0 (e.g. `docker info`). */
export const requireCommand = (command: string, ...args: string[]): void => {
  const r = sh(command, args, { timeoutMs: 30_000 });
  if (r.code !== 0) {
    throw new Unverifiable(
      `\`${[command, ...args].join(" ")}\` failed (exit ${r.code}):\n${tail(r.output, 5)}`,
    );
  }
};

// --- Processes --------------------------------------------------------------

export interface ShResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout and stderr together, for evidence. */
  readonly output: string;
}

/** Run a command to completion. Never throws: inspect `code`. */
export const sh = (
  command: string,
  args: readonly string[],
  opts: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  } = {},
): ShResult => {
  const r = spawnSync(command, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = r.stdout ?? "";
  const stderr =
    (r.stderr ?? "") + (r.error ? `\n[harness] ${r.error.message}` : "");
  return {
    code: r.status ?? -1,
    stdout,
    stderr,
    output: `${stdout}\n${stderr}`,
  };
};

/** Run the local build's `sandcastle` CLI. */
export const sandcastleCli = (
  args: readonly string[],
  opts: { cwd: string; timeoutMs?: number },
): ShResult => sh(process.execPath, [CLI, ...args], opts);

/** Run a TypeScript file with this repo's tsx (e.g. a scaffolded main.mts). */
export const tsx = (
  file: string,
  opts: { cwd: string; timeoutMs?: number },
): ShResult => sh(TSX, [file], opts);

// --- Scratch repo -----------------------------------------------------------

export interface ScratchRepo {
  readonly dir: string;
  /** Run git in the scratch repo; throws if git fails. */
  git(...args: string[]): string;
  write(path: string, content: string): void;
  read(path: string): string;
}

/**
 * A fresh git repo with one commit, outside this checkout, with the local
 * build linked in as `@ai-hero/sandcastle`. Deleted when the check ends.
 *
 * The repo directory is named `name`, so a docker image built from it is
 * `sandcastle:<name>` and is reused across runs.
 */
export const scratchRepo = (name: string): ScratchRepo => {
  const parent = mkdtempSync(join(tmpdir(), "sandcastle-verify-"));
  cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
  const dir = join(parent, name);
  mkdirSync(join(dir, "node_modules", "@ai-hero"), { recursive: true });
  symlinkSync(REPO_ROOT, join(dir, "node_modules", "@ai-hero", "sandcastle"));

  const repo: ScratchRepo = {
    dir,
    git: (...args) => {
      const r = sh("git", args, { cwd: dir });
      if (r.code !== 0) {
        throw new Error(`git ${args.join(" ")} failed:\n${tail(r.output)}`);
      }
      return r.stdout.trim();
    },
    write: (path, content) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    },
    read: (path) => readFileSync(join(dir, path), "utf8"),
  };

  repo.write(
    "package.json",
    JSON.stringify({ name, private: true, type: "module" }, null, 2) + "\n",
  );
  repo.write(".gitignore", "node_modules\n");
  repo.write("README.md", `# ${name}\n`);
  repo.git("init", "-q", "-b", "main");
  repo.git("config", "user.email", "verify@sandcastle.local");
  repo.git("config", "user.name", "Sandcastle Verify");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "initial commit");
  return repo;
};

/** Register teardown (containers, images…) to run when the check ends. */
export const onCleanup = (fn: () => void): void => {
  cleanups.push(fn);
};
const cleanups: (() => void)[] = [];

// --- The check --------------------------------------------------------------

export interface Check {
  /** Record one assertion. `evidence` is printed (redacted) when it fails. */
  expect(ok: boolean, label: string, evidence?: string): void;
  /** Print a progress line. */
  step(message: string): void;
}

/**
 * Run one check and exit with its verdict. Call once, at the top level of a
 * check file.
 */
export const verify = async (
  meta: { claim: string; agent: string; sandbox: string },
  body: (check: Check) => Promise<void>,
): Promise<never> => {
  console.log(`CLAIM: ${meta.claim}`);
  console.log(`COMBINATION: ${meta.agent} × ${meta.sandbox}`);
  let failures = 0;
  const check: Check = {
    expect: (ok, label, evidence) => {
      console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
      if (!ok) {
        failures++;
        if (evidence) console.log(tail(evidence, 30));
      }
    },
    step: (message) => console.log(`  … ${message}`),
  };

  let code: 0 | 1 | 2;
  try {
    await body(check);
    code = failures === 0 ? 0 : 1;
    console.log(
      failures === 0
        ? "RESULT: VERIFIED"
        : `RESULT: FAILED (${failures} assertion(s))`,
    );
  } catch (e) {
    const message = redact(e instanceof Error ? e.message : String(e));
    if (e instanceof Unverifiable) {
      code = 2;
      console.log(`RESULT: UNVERIFIABLE (${message})`);
    } else {
      code = 1;
      console.log(`FAIL check threw\n${tail(message, 30)}`);
      console.log("RESULT: FAILED (check threw)");
    }
  }

  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {
      // best-effort teardown
    }
  }
  process.exit(code);
};
