import { NodeFileSystem } from "@effect/platform-node";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { create } from "./WorktreeManager.js";

const execFileAsync = promisify(execFile);
const branch = "agent/review";
const git = async (cwd: string, ...args: string[]) =>
  (await execFileAsync("git", args, { cwd })).stdout.trim();
const createWorktree = (repo: string) =>
  Effect.runPromise(
    create(repo, { branch }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

describe("worktree refresh with restricted fetch refspecs", () => {
  let root: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  const setup = async () => {
    root = await mkdtemp(join(tmpdir(), "worktree-fetch-"));
    const origin = join(root, "origin.git");
    const publisher = join(root, "publisher");
    const client = join(root, "client");
    await git(root, "init", "--bare", "-b", "main", origin);
    await mkdir(publisher);
    await git(publisher, "init", "-b", "main");
    await git(publisher, "config", "user.name", "Test");
    await git(publisher, "config", "user.email", "test@example.com");
    await writeFile(join(publisher, "file.txt"), "main\n");
    await git(publisher, "add", "file.txt");
    await git(publisher, "commit", "-m", "initial");
    await git(publisher, "switch", "-c", branch);
    await writeFile(join(publisher, "file.txt"), "first\n");
    await git(publisher, "commit", "-am", "first branch commit");
    await git(publisher, "remote", "add", "origin", origin);
    await git(publisher, "push", "origin", "main", branch);

    // file:// is intentional: Git ignores --depth for plain local paths.
    await git(
      root,
      "clone",
      "--depth",
      "1",
      "--branch",
      "main",
      pathToFileURL(origin).href,
      client,
    );
    await git(client, "config", "user.name", "Test");
    await git(client, "config", "user.email", "test@example.com");
    // Make the requested local branch available without broadening the
    // clone's main-only fetch mapping or creating origin/agent/review.
    await git(
      client,
      "fetch",
      "--depth",
      "1",
      "origin",
      `refs/heads/${branch}:refs/heads/${branch}`,
    );
    expect(await git(client, "rev-parse", "--is-shallow-repository")).toBe(
      "true",
    );
    const worktree = await createWorktree(client);
    const initialHead = await git(worktree.path, "rev-parse", "HEAD");
    const publish = async () => {
      await writeFile(join(publisher, "file.txt"), "second\n");
      await git(publisher, "commit", "-am", "second branch commit");
      await git(publisher, "push", "origin", branch);
      return git(publisher, "rev-parse", "HEAD");
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    return { origin, publisher, client, worktree, initialHead, publish };
  };

  it.each(["missing", "stale", "custom", "standard"] as const)(
    "fast-forwards using the fetched tip with a %s tracking ref",
    async (mapping) => {
      const { client, worktree, initialHead, publish } = await setup();
      if (mapping === "stale")
        await git(
          client,
          "update-ref",
          `refs/remotes/origin/${branch}`,
          initialHead,
        );
      if (mapping === "custom")
        await git(
          client,
          "config",
          "remote.origin.fetch",
          "+refs/heads/*:refs/remotes/mirror/*",
        );
      if (mapping === "standard")
        await git(
          client,
          "config",
          "remote.origin.fetch",
          "+refs/heads/*:refs/remotes/origin/*",
        );
      const fetchMapping = await git(
        client,
        "config",
        "--get-all",
        "remote.origin.fetch",
      );
      const nextHead = await publish();
      const reused = await createWorktree(client);
      expect(reused).toEqual(worktree);
      expect(await git(reused.path, "rev-parse", "HEAD")).toBe(nextHead);
      expect(await readFile(join(reused.path, "file.txt"), "utf8")).toBe(
        "second\n",
      );
      expect(
        await git(client, "config", "--get-all", "remote.origin.fetch"),
      ).toBe(fetchMapping);
      expect(await git(reused.path, "status", "--porcelain")).toBe("");
      if (mapping === "stale")
        expect(
          await git(client, "rev-parse", `refs/remotes/origin/${branch}`),
        ).toBe(initialHead);
      if (mapping === "missing" || mapping === "custom")
        await expect(
          git(client, "show-ref", "--verify", `refs/remotes/origin/${branch}`),
        ).rejects.toThrow();
      if (mapping === "custom")
        expect(
          await git(client, "rev-parse", `refs/remotes/mirror/${branch}`),
        ).toBe(nextHead);
      expect(await createWorktree(client)).toEqual(worktree);
      expect(await git(worktree.path, "rev-parse", "HEAD")).toBe(nextHead);
    },
  );

  it("preserves a dirty worktree without refreshing it", async () => {
    const { client, worktree, initialHead, publish } = await setup();
    await publish();
    await writeFile(join(worktree.path, "file.txt"), "local work\n");
    expect(await createWorktree(client)).toEqual(worktree);
    expect(await git(worktree.path, "rev-parse", "HEAD")).toBe(initialHead);
    expect(await readFile(join(worktree.path, "file.txt"), "utf8")).toBe(
      "local work\n",
    );
  });

  it("fetches the branch when origin also has a tag with the same name", async () => {
    const { client, publisher, worktree, publish } = await setup();
    const nextHead = await publish();
    await git(publisher, "tag", branch, "main");
    await git(publisher, "push", "origin", `refs/tags/${branch}`);
    expect(await createWorktree(client)).toEqual(worktree);
    expect(await git(worktree.path, "rev-parse", "HEAD")).toBe(nextHead);
    expect(await readFile(join(worktree.path, "file.txt"), "utf8")).toBe(
      "second\n",
    );
  });

  it("preserves local commits that diverged from the fetched branch", async () => {
    const { client, worktree, publish } = await setup();
    await writeFile(join(worktree.path, "local.txt"), "local commit\n");
    await git(worktree.path, "add", "local.txt");
    await git(worktree.path, "commit", "-m", "local commit");
    const localHead = await git(worktree.path, "rev-parse", "HEAD");
    await publish();
    expect(await createWorktree(client)).toEqual(worktree);
    expect(await git(worktree.path, "rev-parse", "HEAD")).toBe(localHead);
    expect(await readFile(join(worktree.path, "local.txt"), "utf8")).toBe(
      "local commit\n",
    );
    expect(await git(worktree.path, "status", "--porcelain")).toBe("");
  });

  it("does not merge an earlier FETCH_HEAD when the next fetch fails", async () => {
    const { client, worktree, initialHead, origin, publish } = await setup();
    const nextHead = await publish();
    await git(worktree.path, "fetch", "origin", `refs/heads/${branch}`);
    expect(await git(worktree.path, "rev-parse", "FETCH_HEAD")).toBe(nextHead);
    await git(client, "remote", "set-url", "origin", `${origin}-unavailable`);
    expect(await createWorktree(client)).toEqual(worktree);
    expect(await git(worktree.path, "rev-parse", "HEAD")).toBe(initialHead);
    expect(await readFile(join(worktree.path, "file.txt"), "utf8")).toBe(
      "first\n",
    );
  });
});
