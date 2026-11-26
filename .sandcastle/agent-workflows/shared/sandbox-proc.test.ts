import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sandbox } from "@ai-hero/sandcastle/v1";
import { openSandbox, quote } from "./sandbox";
import type { WorkflowSandboxCase } from "./test-sandboxes";
import { useWorkflowSandbox, WORKFLOW_SANDBOXES } from "./test-sandboxes";

// The agent runs with its permission bypass on text anyone can write, as the
// runner's own user. Whatever it can see in /proc, it can read the environ
// of: the job step's shell and the script's tsx both hold GH_TOKEN, and so
// does a git command pushing at the same time. Under bwrap() each command
// has its own PID namespace, so it sees no process but its own.

const TOKEN = "ghs_canary0123456789abcdef";

/**
 * Lists the processes this command can see in /proc whose environ it can
 * read and that are outside its own session (both providers start each
 * command in a session of its own; bwrap()'s watcher shell shares it), and
 * those whose environ holds the token. It gets the token in two halves, so
 * its own environ never holds it whole.
 */
const PROBE = String.raw`
const fs = require("node:fs");
const token = process.env.HALF_A + process.env.HALF_B;
const session = (pid) =>
  fs.readFileSync("/proc/" + pid + "/stat", "utf8").split(") ").at(-1).split(" ")[3];
const own = session("self");
const others = [];
const holders = [];
for (const name of fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
  let environ;
  try {
    environ = fs.readFileSync("/proc/" + name + "/environ", "latin1");
  } catch {
    continue;
  }
  if (session(name) !== own) others.push(Number(name));
  if (environ.includes(token)) holders.push(Number(name));
}
process.stdout.write(JSON.stringify({ others, holders }));
`;

/** What the probe saw, each a list of pids. */
interface Seen {
  readonly others: readonly number[];
  readonly holders: readonly number[];
}

const parseSeen = (text: string): Seen => {
  const value: unknown = JSON.parse(text);
  if (
    typeof value === "object" &&
    value !== null &&
    "others" in value &&
    "holders" in value &&
    Array.isArray(value.others) &&
    Array.isArray(value.holders)
  ) {
    return {
      others: value.others.map(Number),
      holders: value.holders.map(Number),
    };
  }
  throw new TypeError(`not what the probe prints: ${text}`);
};

const probe = async (sandbox: Sandbox): Promise<Seen> => {
  const result = await sandbox.exec({
    command: `node -e ${quote(PROBE)}`,
    env: { HALF_A: TOKEN.slice(0, 8), HALF_B: TOKEN.slice(8) },
  });
  return parseSeen(result.stdout);
};

/** A process of the job's, outside the sandbox, holding the token: the step's shell, or tsx. */
const startJobProcess = async (): Promise<ChildProcess> => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e5)"], {
    env: { PATH: process.env.PATH, GH_TOKEN: TOKEN },
    stdio: "ignore",
  });
  await once(child, "spawn");
  return child;
};

/**
 * Starts a command in the sandbox holding the token in its env, as a push
 * does, and resolves with its pid (as the sandbox numbers it) once it runs.
 */
const startTokenCommand = async (sandbox: Sandbox): Promise<number> => {
  // Killed by close().
  sandbox
    .exec({
      command: 'echo "$$" > .held && exec sleep 300',
      env: { GH_TOKEN: TOKEN },
    })
    .catch(() => undefined);
  return vi.waitFor(
    async () => {
      const held = await sandbox.readTextFile({ path: ".held" });
      if (held === null || held.trim() === "") {
        throw new Error("the token command hasn't started");
      }
      return Number(held);
    },
    { timeout: 10_000, interval: 25 },
  );
};

/** Sets up a sandbox on `name`, a job process and a sandbox command, both holding the token. */
const withHolders = (name: WorkflowSandboxCase["name"]) => {
  const state: {
    sandbox?: Sandbox;
    jobProcess?: ChildProcess;
    tokenCommand?: number;
  } = {};
  let cleanup = async (): Promise<void> => undefined;
  const saved = { ...process.env };

  beforeEach(async () => {
    cleanup = await useWorkflowSandbox(name);
    process.env.GH_REPO = "example/repo";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "claude-unused";
    state.sandbox = await openSandbox();
    state.jobProcess = await startJobProcess();
    state.tokenCommand = await startTokenCommand(state.sandbox);
  });

  afterEach(async () => {
    state.jobProcess?.kill("SIGKILL");
    await state.sandbox?.close();
    state.sandbox = undefined;
    process.env = { ...saved };
    await cleanup();
  });

  return {
    sandbox: (): Sandbox => {
      if (state.sandbox === undefined) {
        throw new TypeError("no sandbox");
      }
      return state.sandbox;
    },
    jobPid: () => state.jobProcess?.pid,
    tokenCommandPid: () => state.tokenCommand,
  };
};

const skips = (name: WorkflowSandboxCase["name"]): boolean =>
  process.platform !== "linux" ||
  WORKFLOW_SANDBOXES.some((each) => each.name === name && each.skip);

describe.skipIf(skips("bwrap"))(
  "what the workflows' sandbox on bwrap() can see in /proc",
  () => {
    const held = withHolders("bwrap");

    it("shows a command no process outside it, so no environ holding the token", async () => {
      const seen = await probe(held.sandbox());

      expect(seen).toStrictEqual({ others: [], holders: [] });
    });
  },
);

describe.skipIf(skips("host"))(
  "what the workflows' sandbox on host() can see in /proc",
  () => {
    const held = withHolders("host");

    it("shows a command the job's processes and the token in their env: the gap bwrap() closes", async () => {
      const seen = await probe(held.sandbox());

      expect(seen.holders).toContain(held.jobPid());
      expect(seen.holders).toContain(held.tokenCommandPid());
    });
  },
);
