import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import type { BindMountSandboxHandle } from "@ai-hero/sandcastle";
import {
  claudeCode,
  createBindMountSandboxProvider,
  run,
} from "@ai-hero/sandcastle";

// The env a run() injects into its sandbox, from the host repo's
// .sandcastle/.env (with process.env filling declared-but-empty keys). The
// sandbox is scripted: it records the env it was created with and plays back
// a one-line Claude Code session.

const STREAM = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "sess-env" }),
  JSON.stringify({ type: "result", subtype: "success", result: "done" }),
];

/** A fresh git repo with the given files; `cleanup` registers its removal. */
const hostRepo = (
  files: Record<string, string>,
  cleanup: (remove: () => void) => void,
): string => {
  const repo = mkdtempSync(path.join(tmpdir(), "e2e-env-file-"));
  cleanup(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  };
  git("init", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "# repo\n");
  git("add", ".");
  git("commit", "-m", "init");
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), content);
  }
  return repo;
};

/**
 * Runs once in a repo holding `files`, and returns the env the sandbox got.
 * The repo is removed when the test finishes, or through `cleanup`.
 */
const sandboxEnv = async (
  files: Record<string, string>,
  cleanup: (remove: () => void) => void = (remove) => {
    onTestFinished(remove);
  },
): Promise<Record<string, string>> => {
  const repo = hostRepo(files, cleanup);
  let env: Record<string, string> | undefined;
  const sandbox = createBindMountSandboxProvider({
    name: "scripted",
    create: async (options): Promise<BindMountSandboxHandle> => {
      ({ env } = options);
      return {
        worktreePath: options.worktreePath,
        exec: async (_command, execOptions) => {
          for (const line of STREAM) {
            execOptions?.onLine?.(line);
          }
          return { stdout: STREAM.join("\n"), stderr: "", exitCode: 0 };
        },
        copyFileIn: async () => undefined,
        copyFileOut: async () => undefined,
        close: async () => undefined,
      };
    },
  });
  await run({
    agent: claudeCode("claude-opus-4-8", { captureSessions: false }),
    sandbox,
    cwd: repo,
    prompt: "Do the task.",
    branchStrategy: { type: "head" },
    logging: { type: "file", path: path.join(repo, "run.log") },
  });
  if (env === undefined) {
    throw new Error("the sandbox was never created");
  }
  return env;
};

/** The env the sandbox got when .sandcastle/.env holds `content`. */
const envFrom = async (content: string) =>
  sandboxEnv({ ".sandcastle/.env": content });

describe("run(): the sandbox env from .sandcastle/.env", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("injects every key in .sandcastle/.env, with no validation of which keys", async () => {
    await expect(
      envFrom(
        "ANTHROPIC_API_KEY=sc-key\nGH_TOKEN=sc-gh\nDATABASE_URL=pg://localhost\n",
      ),
    ).resolves.toStrictEqual({
      ANTHROPIC_API_KEY: "sc-key",
      GH_TOKEN: "sc-gh",
      DATABASE_URL: "pg://localhost",
    });
  });

  it("injects nothing when there is no .env file", async () => {
    await expect(sandboxEnv({})).resolves.toStrictEqual({});
  });

  it("ignores the repo root .env", async () => {
    await expect(
      sandboxEnv({ ".env": "ROOT_SECRET=should-not-appear\n" }),
    ).resolves.toStrictEqual({});
  });

  it("uses only .sandcastle/.env when the repo root .env also exists", async () => {
    await expect(
      sandboxEnv({
        ".env": "ROOT_ONLY=root-val\nSHARED=root\n",
        ".sandcastle/.env": "SC_ONLY=sc-val\nSHARED=sc\n",
      }),
    ).resolves.toStrictEqual({ SC_ONLY: "sc-val", SHARED: "sc" });
  });

  it("fills a key declared with no value from process.env", async () => {
    vi.stubEnv("E2E_MY_TOKEN", "from-process");

    await expect(envFrom("E2E_MY_TOKEN=\n")).resolves.toStrictEqual({
      E2E_MY_TOKEN: "from-process",
    });
  });

  it("drops a key declared with no value when process.env lacks it too", async () => {
    vi.stubEnv("E2E_UNSET", undefined);

    await expect(envFrom("E2E_UNSET=\nKEPT=yes\n")).resolves.toStrictEqual({
      KEPT: "yes",
    });
  });

  it("takes no undeclared keys from process.env", async () => {
    vi.stubEnv("E2E_UNDECLARED", "from-process");

    const env = await envFrom("DECLARED_KEY=value\n");

    expect(env).toStrictEqual({ DECLARED_KEY: "value" });
  });

  it("prefers the .sandcastle/.env value over process.env", async () => {
    vi.stubEnv("E2E_MY_VAR", "from-process");

    await expect(envFrom("E2E_MY_VAR=sc-val\n")).resolves.toStrictEqual({
      E2E_MY_VAR: "sc-val",
    });
  });

  it("skips comments, blank lines and lines without =", async () => {
    await expect(
      envFrom(
        "# A comment\n# COMMENTED=out\n\nKEY1=val1\nnot an assignment\n\n  # INDENTED=out\nKEY2=val2\n",
      ),
    ).resolves.toStrictEqual({ KEY1: "val1", KEY2: "val2" });
  });

  it("trims whitespace around keys and unquoted values", async () => {
    await expect(envFrom("  KEY  =  plain  \n")).resolves.toStrictEqual({
      KEY: "plain",
    });
  });

  it("drops a key whose quoted value is empty", async () => {
    await expect(envFrom('KEY=""\n')).resolves.toStrictEqual({});
  });
});

// Every value shape in one .env file and one run: each case reads its own key.
const VALUES = [
  { line: "KEY=plain", value: "plain" },
  { line: "KEY=a=b", value: "a=b" },
  { line: 'KEY="sk-ant-api03-real-key"', value: "sk-ant-api03-real-key" },
  { line: "KEY='my-token'", value: "my-token" },
  { line: `KEY="value'`, value: `"value'` },
  { line: 'KEY=some"thing', value: 'some"thing' },
  { line: 'KEY="  spaced  "', value: "  spaced  " },
  { line: String.raw`KEY="line1\nline2"`, value: "line1\nline2" },
  { line: String.raw`KEY='line1\nline2'`, value: String.raw`line1\nline2` },
  { line: String.raw`KEY="a\tb"`, value: "a\tb" },
  { line: String.raw`KEY="a\rb"`, value: "a\rb" },
  { line: String.raw`KEY="a\\b"`, value: String.raw`a\b` },
  { line: String.raw`KEY="a\\nb"`, value: String.raw`a\nb` },
  { line: String.raw`KEY="a\xb"`, value: String.raw`a\xb` },
  { line: 'KEY="', value: '"' },
] as const;

describe("run(): how .sandcastle/.env values are read", () => {
  let env: Record<string, string> = {};
  const removals: (() => void)[] = [];

  beforeAll(async () => {
    env = await sandboxEnv(
      {
        ".sandcastle/.env": VALUES.map(
          ({ line }, i) => `${line.replace("KEY", `KEY${String(i)}`)}\n`,
        ).join(""),
      },
      (remove) => {
        removals.push(remove);
      },
    );
  }, 30_000);

  afterAll(() => {
    for (const remove of removals) {
      remove();
    }
  });

  it.each(
    VALUES.map(({ line, value }, i) => ({
      line,
      value,
      key: `KEY${String(i)}`,
    })),
  )("reads $line as $value", ({ key, value }) => {
    expect(env[key]).toBe(value);
  });
});
