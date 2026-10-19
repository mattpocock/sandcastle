import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeCode } from "./AgentProvider.js";
import { createSandbox } from "./createSandbox.js";
import {
  createIsolatedSandboxProvider,
  type IsolatedSandboxHandle,
} from "./SandboxProvider.js";
import { testIsolated } from "./sandboxes/test-isolated.js";
import { syncIn } from "./syncIn.js";
import { syncOut } from "./syncOut.js";

const execFileAsync = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await execFileAsync("git", args, { cwd })).stdout.trim();

describe("syncOut with previously synced uncommitted changes", () => {
  let host: string;
  let handle: IsolatedSandboxHandle;
  let sandbox: string;
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    host = await mkdtemp(join(tmpdir(), "sync-repeated-"));
    await git(host, "init", "-b", "main");
    await git(host, "config", "user.name", "Test");
    await git(host, "config", "user.email", "test@example.com");
    await writeFile(join(host, "file.txt"), "initial\n");
    await writeFile(join(host, "other.txt"), "unrelated\n");
    await git(host, "add", ".");
    await git(host, "commit", "-m", "initial");
    handle = await testIsolated().create({ env: {} });
    sandbox = handle.worktreePath;
    await Effect.runPromise(syncIn(host, handle));
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await handle?.close();
    await rm(host, { recursive: true, force: true });
  });

  const sync = () => Effect.runPromise(syncOut(host, handle));
  const hostText = () => readFile(join(host, "file.txt"), "utf8");
  const edit = (text: string) => writeFile(join(sandbox, "file.txt"), text);
  const artifacts = async () => {
    const root = join(host, ".sandcastle", "patches");
    const dirs = await readdir(root);
    return join(root, dirs.at(-1)!);
  };

  it.each([false, true])(
    "syncs consecutive edits and a no-op (staged: %s)",
    async (staged) => {
      const head = await git(sandbox, "rev-parse", "HEAD");
      for (const text of ["first\n", "second\n", "third\n", "third\n"]) {
        await edit(text);
        if (staged) await git(sandbox, "add", "file.txt");
        const index = await git(sandbox, "write-tree");
        await sync();
        expect(await hostText()).toBe(text);
        expect(await git(sandbox, "write-tree")).toBe(index);
        expect(await git(sandbox, "rev-parse", "HEAD")).toBe(head);
        expect(await git(host, "rev-parse", "HEAD")).toBe(head);
      }
      expect(errors).not.toHaveBeenCalled();
      expect(existsSync(join(host, ".sandcastle", "patches"))).toBe(false);
    },
  );

  it("syncs a revert to HEAD, then accepts another edit", async () => {
    await edit("first\n");
    await sync();
    await git(sandbox, "restore", "file.txt");
    await sync();
    expect(await hostText()).toBe("initial\n");
    await edit("after revert\n");
    await sync();
    expect(await hostText()).toBe("after revert\n");
    expect(errors).not.toHaveBeenCalled();
  });

  it("syncs staged additions, renames, and deletions across runs", async () => {
    await writeFile(join(sandbox, "new file.txt"), "new\n");
    await git(sandbox, "add", "new file.txt");
    await sync();
    await git(sandbox, "mv", "new file.txt", "renamed file.txt");
    await sync();
    expect(existsSync(join(host, "new file.txt"))).toBe(false);
    expect(await readFile(join(host, "renamed file.txt"), "utf8")).toBe(
      "new\n",
    );
    await git(sandbox, "rm", "-f", "renamed file.txt");
    await sync();
    expect(existsSync(join(host, "renamed file.txt"))).toBe(false);
    expect(errors).not.toHaveBeenCalled();
  });

  it("round-trips binary edits without changing the sandbox index", async () => {
    for (const bytes of [Buffer.from([0, 1, 255]), Buffer.from([0, 2, 254])]) {
      await writeFile(join(sandbox, "file.txt"), bytes);
      const index = await git(sandbox, "write-tree");
      await sync();
      expect(await readFile(join(host, "file.txt"))).toEqual(bytes);
      expect(await git(sandbox, "write-tree")).toBe(index);
    }
    expect(errors).not.toHaveBeenCalled();
  });

  it("applies commits made from a previous dirty run, followed by more edits", async () => {
    await edit("first\n");
    await sync();
    await git(sandbox, "add", "file.txt");
    await git(sandbox, "commit", "-m", "commit first edit");
    await edit("second\n");
    await sync();
    expect(await hostText()).toBe("second\n");
    expect(await git(host, "log", "-1", "--format=%s")).toBe(
      "commit first edit",
    );
    await edit("third\n");
    await sync();
    expect(await hostText()).toBe("third\n");
    expect(await git(host, "rev-list", "--count", "HEAD")).toBe("2");
    expect(errors).not.toHaveBeenCalled();
  });

  it("preserves unrelated host edits", async () => {
    await edit("first\n");
    await sync();
    await writeFile(join(host, "other.txt"), "host work\n");
    await edit("second\n");
    await sync();
    expect(await hostText()).toBe("second\n");
    expect(await readFile(join(host, "other.txt"), "utf8")).toBe("host work\n");
    expect(errors).not.toHaveBeenCalled();
  });

  it("preserves conflicting host edits and saved artifacts, then allows retry", async () => {
    await edit("first\n");
    await sync();
    await writeFile(join(host, "file.txt"), "host work\n");
    await edit("second\n");
    await sync();
    expect(await hostText()).toBe("host work\n");
    expect(errors).toHaveBeenCalled();
    const dir = await artifacts();
    expect(await readFile(join(dir, "changes.patch"), "utf8")).toContain(
      "+second",
    );
    await writeFile(join(host, "file.txt"), "first\n");
    errors.mockClear();
    await sync();
    expect(await hostText()).toBe("second\n");
    expect(errors).not.toHaveBeenCalled();
  });

  it("does not remember a diff that failed to apply on the first run", async () => {
    await edit("first\n");
    await writeFile(join(host, "file.txt"), "host work\n");
    await sync();
    expect(await hostText()).toBe("host work\n");
    await git(host, "restore", "file.txt");
    errors.mockClear();
    await sync();
    expect(await hostText()).toBe("first\n");
    await edit("second\n");
    await sync();
    expect(await hostText()).toBe("second\n");
    expect(errors).not.toHaveBeenCalled();
  });

  it("retries pending commits after conflicting host edits are resolved", async () => {
    await edit("first\n");
    await sync();
    await edit("committed\n");
    await git(sandbox, "add", "file.txt");
    await git(sandbox, "commit", "-m", "commit second edit");
    await writeFile(join(host, "file.txt"), "host work\n");
    await sync();
    expect(await hostText()).toBe("host work\n");
    expect(await git(host, "rev-list", "--count", "HEAD")).toBe("1");
    const dir = await artifacts();
    expect(await readFile(join(dir, "previous.diff"), "utf8")).toContain(
      "+first",
    );
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "git apply --reverse",
    );
    expect(errors.mock.calls.flat().join("\n")).toContain("/[0-9]*.patch");
    await writeFile(join(host, "file.txt"), "first\n");
    errors.mockClear();
    await sync();
    expect(await hostText()).toBe("committed\n");
    expect(await git(host, "rev-list", "--count", "HEAD")).toBe("2");
    expect(errors).not.toHaveBeenCalled();
  });

  it("does not replay commits when a later diff fails to apply", async () => {
    await edit("first\n");
    await sync();
    await git(sandbox, "add", "file.txt");
    await git(sandbox, "commit", "-m", "commit first edit");
    await writeFile(join(sandbox, "other.txt"), "sandbox work\n");
    await writeFile(join(host, "other.txt"), "host work\n");
    await sync();
    expect(await hostText()).toBe("first\n");
    expect(await git(host, "rev-list", "--count", "HEAD")).toBe("2");
    expect(await readFile(join(host, "other.txt"), "utf8")).toBe("host work\n");
    expect(errors).toHaveBeenCalled();
    await git(host, "restore", "other.txt");
    errors.mockClear();
    await sync();
    expect(await readFile(join(host, "other.txt"), "utf8")).toBe(
      "sandbox work\n",
    );
    expect(await git(host, "rev-list", "--count", "HEAD")).toBe("2");
    expect(errors).not.toHaveBeenCalled();
  });

  it("remembers an applied diff even if copying untracked files later fails", async () => {
    await edit("first\n");
    await writeFile(join(sandbox, "untracked.txt"), "untracked\n");
    await mkdir(join(host, "untracked.txt"));
    await sync();
    expect(await hostText()).toBe("first\n");
    expect(errors).toHaveBeenCalled();
    await rm(join(host, "untracked.txt"), { recursive: true });
    await edit("second\n");
    errors.mockClear();
    await sync();
    expect(await hostText()).toBe("second\n");
    expect(await readFile(join(host, "untracked.txt"), "utf8")).toBe(
      "untracked\n",
    );
    expect(errors).not.toHaveBeenCalled();
  });

  it("syncs each createSandbox.run() into the same host worktree", async () => {
    let runs = 0;
    const provider = createIsolatedSandboxProvider({
      name: "repeated-diff-test",
      create: async (options) => {
        const isolated = await testIsolated().create(options);
        return {
          ...isolated,
          exec: async (command, options) => {
            if (!command.startsWith("claude "))
              return isolated.exec(command, options);
            await writeFile(
              join(isolated.worktreePath, "file.txt"),
              `run ${++runs}\n`,
            );
            const stdout = JSON.stringify({ type: "result", result: "done" });
            options?.onLine?.(stdout);
            return { stdout, stderr: "", exitCode: 0 };
          },
        };
      },
    });
    const reusable = await createSandbox({
      cwd: host,
      branch: "agent/repeated-diff",
      sandbox: provider,
    });
    try {
      const head = await git(reusable.worktreePath, "rev-parse", "HEAD");
      for (let run = 1; run <= 3; run++) {
        await reusable.run({
          agent: claudeCode("test-model", { captureSessions: false }),
          prompt: "Edit file.txt without committing",
          maxIterations: 1,
        });
        expect(
          await readFile(join(reusable.worktreePath, "file.txt"), "utf8"),
        ).toBe(`run ${run}\n`);
        expect(await git(reusable.worktreePath, "rev-parse", "HEAD")).toBe(
          head,
        );
      }
      expect(await hostText()).toBe("initial\n");
      expect(errors.mock.calls.flat().join("\n")).not.toContain(
        "Patch application failed",
      );
    } finally {
      await reusable.close();
    }
  });
});
