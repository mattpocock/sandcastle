import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { withWorkflowRecovery } from "./WorkflowRecovery.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it("preserves every independently verified checkpoint in a parallel batch", async () => {
  const { options } = await fixture();
  const executed: number[] = [];
  const execute = () =>
    withWorkflowRecovery(options, (run) =>
      Promise.all(
        Array.from({ length: 12 }, (_, issue) =>
          run.step({
            key: "implement/" + issue,
            input: { issue },
            schema: z.number(),
            execute: async () => {
              executed.push(issue);
              await new Promise((resolve) => setTimeout(resolve, issue % 3));
              return issue;
            },
            verify: async (value) => value === issue,
          }),
        ),
      ),
    );
  const expected = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  expect(await execute()).toEqual(expected);
  expect(await execute()).toEqual(expected);
  expect(executed.sort((a, b) => a - b)).toEqual(expected);
});

it("does not execute when recovery storage is unavailable", async () => {
  const { options, cwd } = await fixture();
  await mkdir(join(cwd, ".git", "sandcastle"));
  await writeFile(
    join(cwd, ".git", "sandcastle", "recovery"),
    "not a directory",
  );
  let executed = false;
  await expect(
    withWorkflowRecovery(options, async () => {
      executed = true;
    }),
  ).rejects.toThrow();
  expect(executed).toBe(false);
});

it("rejects corrupt persisted data instead of treating it as a fresh run", async () => {
  const { options, cwd } = await fixture();
  await withWorkflowRecovery(options, async () => {});
  // Fault injection at the filesystem boundary, not a private-function mock.
  const root = join(cwd, ".git", "sandcastle", "recovery");
  const resource = join(root, (await readdir(root))[0]!);
  const journal = (await readdir(resource)).find(
    (name) => name.endsWith(".json") && name !== "owner.json",
  )!;
  await writeFile(join(resource, journal), "{truncated");
  let executed = false;
  await expect(
    withWorkflowRecovery(options, async () => {
      executed = true;
    }),
  ).rejects.toThrow();
  expect(executed).toBe(false);
});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-recovery-"));
  roots.push(cwd);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-qb", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("commit", "--allow-empty", "-qm", "baseline");
  return {
    cwd,
    git,
    options: {
      cwd,
      targetBranch: "main",
      runId: "delivery-1",
      workflowVersion: "v1",
    },
  };
}

it("reuses a verified implementation after restart and proceeds to review", async () => {
  const { options, git } = await fixture();
  const sha = git("rev-parse", "HEAD");
  const performed: string[] = [];
  const implementation = {
    key: "batch-1/implement/20",
    input: { issue: 20, contract: "v1" },
    schema: z.object({ sha: z.string() }),
    execute: async () => {
      performed.push("implement");
      return { sha };
    },
    verify: async (result: { sha: string }) =>
      result.sha === git("rev-parse", "HEAD"),
  };
  await expect(
    withWorkflowRecovery(options, async (run) => {
      await run.step(implementation);
      throw new Error("runner stopped before review");
    }),
  ).rejects.toThrow("runner stopped before review");
  await withWorkflowRecovery(options, async (run) => {
    expect(await run.step(implementation)).toEqual({ sha });
    await run.step({
      key: "batch-1/review/20",
      input: { sha },
      schema: z.literal("approved"),
      execute: async () => {
        performed.push("review");
        return "approved" as const;
      },
      verify: async () => true,
    });
  });
  expect(performed).toEqual(["implement", "review"]);
});

it("excludes a second runner even with a different run ID and linked checkout", async () => {
  const { options, cwd, git } = await fixture();
  const worktree = join(cwd, "linked");
  git("worktree", "add", "-qb", "other", worktree);
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const running = withWorkflowRecovery(options, async () => {
    started();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await ready;
  try {
    await expect(
      withWorkflowRecovery(
        { ...options, cwd: worktree, runId: "delivery-2" },
        async () => "duplicate",
      ),
    ).rejects.toThrow(/owned|locked/);
  } finally {
    release();
    await running;
  }
});

it("reconciles an acknowledged GitHub closure after a lost response without publishing twice", async () => {
  const { options, git } = await fixture();
  const sha = git("rev-parse", "HEAD");
  let issueState = "open";
  const publications: string[] = [];
  const closeIssue = {
    key: "batch-1/close/20",
    input: { repository: "owner/project", issue: 20, sha },
    schema: z.object({ sha: z.string(), state: z.literal("closed") }),
    execute: async (): Promise<{ sha: string; state: "closed" }> => {
      publications.push("close");
      issueState = "closed";
      throw new Error("GitHub response lost");
    },
    verify: async (result: { sha: string; state: "closed" }) =>
      result.sha === git("rev-parse", "HEAD") && issueState === result.state,
  };
  await expect(
    withWorkflowRecovery(options, (run) => run.step(closeIssue)),
  ).rejects.toThrow("GitHub response lost");
  await expect(
    withWorkflowRecovery(options, (run) => run.step(closeIssue)),
  ).rejects.toThrow("Uncertain step");
  const result = await withWorkflowRecovery(options, (run) =>
    run.step({
      ...closeIssue,
      reconcile: async () =>
        issueState === "closed"
          ? {
              quiescent: true as const,
              result: { sha, state: "closed" as const },
            }
          : null,
    }),
  );
  expect(result).toEqual({ sha, state: "closed" });
  expect(publications).toEqual(["close"]);
});

it("keeps ownership until all already-started parallel steps settle, even after callback failure", async () => {
  const { options } = await fixture();
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = withWorkflowRecovery(options, async (run) => {
    void run.step({
      key: "slow",
      input: {},
      schema: z.literal("ok"),
      execute: async () => {
        started();
        await done;
        return "ok" as const;
      },
      verify: async () => true,
    });
    await ready;
    throw new Error("parallel sibling failed");
  }).catch((error) => error);
  await ready;
  await new Promise((resolve) => setTimeout(resolve, 60));
  try {
    await expect(
      withWorkflowRecovery(options, async () => "duplicate"),
    ).rejects.toThrow(/owned|locked/);
  } finally {
    release();
    await first;
  }
});

it("refuses changed inputs, stale Git evidence and skipped checkpoints", async () => {
  const { options, git } = await fixture();
  const sha = git("rev-parse", "HEAD");
  const step = {
    key: "review",
    input: { sha },
    schema: z.string(),
    execute: async () => sha,
    verify: async (value: string) => value === git("rev-parse", "HEAD"),
  };
  await withWorkflowRecovery(options, (run) => run.step(step));
  await expect(
    withWorkflowRecovery(options, (run) =>
      run.step({ ...step, input: { sha, gate: "changed" } }),
    ),
  ).rejects.toThrow("input changed");
  git("commit", "--allow-empty", "-qm", "changed source");
  await expect(
    withWorkflowRecovery(options, (run) => run.step(step)),
  ).rejects.toThrow("Verification failed");
  await expect(
    withWorkflowRecovery(options, async () => "skipped review"),
  ).rejects.toThrow("not revisited");
});

it("recovers verified work after a real runner SIGKILL without stealing a live PID", async () => {
  const { options, git } = await fixture();
  const sha = git("rev-parse", "HEAD");
  const code = `import {withWorkflowRecovery} from ${JSON.stringify(new URL("./WorkflowRecovery.ts", import.meta.url).href)};
    await withWorkflowRecovery(${JSON.stringify(options)}, async run => {
      await run.step({key:'implement',input:{issue:20},schema:{parse:v=>v},execute:async()=>${JSON.stringify(sha)},verify:async()=>true});
      console.log('CHECKPOINT'); await new Promise(()=>setInterval(()=>{},1000));
    });`;
  const child = spawn(
    process.execPath,
    [
      "--import",
      createRequire(import.meta.url).resolve("tsx"),
      "--input-type=module",
      "-e",
      code,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(child, "exit");
  try {
    const ready = await Promise.race([
      once(child.stdout!, "data").then(([data]) => String(data)),
      exited.then(() => "early exit"),
    ]);
    expect(ready).toContain("CHECKPOINT");
    await expect(
      withWorkflowRecovery(options, async () => "duplicate"),
    ).rejects.toThrow(/owned|locked/);
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
  const value = await withWorkflowRecovery(options, (run) =>
    run.step({
      key: "implement",
      input: { issue: 20 },
      schema: z.string(),
      execute: async () => {
        throw new Error("must not rerun");
      },
      verify: async (value) => value === git("rev-parse", "HEAD"),
    }),
  );
  expect(value).toBe(sha);
}, 15000);

it("does not start fresh work or a replacement run while a prior attempt is unresolved", async () => {
  const { options } = await fixture();
  await expect(
    withWorkflowRecovery(options, (run) =>
      run.step({
        key: "uncertain",
        input: {},
        schema: z.string(),
        execute: async () => {
          throw new Error("connection lost");
        },
        verify: async () => true,
      }),
    ),
  ).rejects.toThrow("connection lost");
  let started = false;
  await expect(
    withWorkflowRecovery(options, (run) =>
      run.step({
        key: "new-work",
        input: {},
        schema: z.string(),
        execute: async () => {
          started = true;
          return "unsafe";
        },
        verify: async () => true,
      }),
    ),
  ).rejects.toThrow(/Uncertain|Unverified/);
  expect(started).toBe(false);
  await expect(
    withWorkflowRecovery({ ...options, runId: "replacement" }, async () => {}),
  ).rejects.toThrow("Resume unfinished run");
});
