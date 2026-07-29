import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandbox } from "@ai-hero/sandcastle";
import { appleContainer } from "@ai-hero/sandcastle/sandboxes/apple-container";

const imageName =
  process.env.SANDCASTLE_APPLE_CONTAINER_IMAGE ?? "sandcastle:sandcastle";
const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-apple-container-"));
const inputPath = join(hostDir, "input.txt");
const copyInPath = join(hostDir, "copy-in.txt");
const copyOutPath = join(hostDir, "nested", "copy-out.txt");
const authDir = join(hostDir, "auth");
const authPath = join(authDir, "auth.json");
const binaryInPath = join(hostDir, "binary-in.bin");
const binaryOutPath = join(hostDir, "binary-out.bin");
const binaryContents = Buffer.from([0, 1, 2, 127, 128, 254, 255]);

await writeFile(inputPath, "bind mount works\n");
await writeFile(copyInPath, "copy in works\n");
await mkdir(authDir);
await writeFile(authPath, '{"mounted":true}\n');
await writeFile(binaryInPath, binaryContents);

const provider = appleContainer({
  imageName,
  cpus: 2,
  memory: "2G",
  mounts: [
    {
      hostPath: authDir,
      sandboxPath: "/home/agent/.config/sandcastle",
      readonly: true,
    },
  ],
});
const handle = await provider.create({
  worktreePath: hostDir,
  hostRepoPath: hostDir,
  mounts: [
    {
      hostPath: hostDir,
      sandboxPath: "/home/agent/workspace",
    },
  ],
  env: { SANDCASTLE_SMOKE: "true" },
});

try {
  const bindMount = await handle.exec(
    'cat input.txt && printf "$SANDCASTLE_SMOKE"',
  );
  assert.equal(bindMount.exitCode, 0);
  assert.equal(bindMount.stdout, "bind mount works\ntrue");

  const identity = await handle.exec('printf \'%s:%s\' "$(id -u)" "$(id -g)"');
  assert.equal(identity.exitCode, 0);
  assert.equal(identity.stdout, `${process.getuid?.()}:${process.getgid?.()}`);

  const mountedFile = await handle.exec(
    "cat /home/agent/.config/sandcastle/auth.json",
  );
  assert.equal(mountedFile.exitCode, 0);
  assert.equal(mountedFile.stdout, '{"mounted":true}\n');
  const readonlyMount = await handle.exec(
    "printf changed > /home/agent/.config/sandcastle/auth.json",
  );
  assert.notEqual(readonlyMount.exitCode, 0);

  const streamed: string[] = [];
  const streaming = await handle.exec("printf 'first\\nsecond\\n'", {
    onLine: (line) => streamed.push(line),
  });
  assert.equal(streaming.exitCode, 0);
  assert.deepEqual(streamed, ["first", "second"]);

  const stdin = await handle.exec("cat", { stdin: "stdin works\n" });
  assert.equal(stdin.exitCode, 0);
  assert.equal(stdin.stdout, "stdin works\n");

  await handle.copyFileIn(
    copyInPath,
    "/home/agent/workspace/nested/copied.txt",
  );
  const copied = await handle.exec("cat nested/copied.txt");
  assert.equal(copied.stdout, "copy in works\n");

  await handle.copyFileOut(
    "/home/agent/workspace/nested/copied.txt",
    copyOutPath,
  );
  assert.equal(await readFile(copyOutPath, "utf8"), "copy in works\n");

  await handle.copyFileIn(binaryInPath, "/home/agent/workspace/binary.bin");
  await handle.copyFileOut("/home/agent/workspace/binary.bin", binaryOutPath);
  assert.deepEqual(await readFile(binaryOutPath), binaryContents);
} finally {
  await handle.close();
  await rm(hostDir, { recursive: true, force: true });
}

const repoDir = await mkdtemp(join(tmpdir(), "sandcastle-apple-worktree-"));
const nestedRoot = await mkdtemp(
  join(tmpdir(), "sandcastle-apple-nested-worktree-"),
);
const nestedHostWorktree = join(nestedRoot, "host-worktree");
const git = (args: string[]): string =>
  execFileSync("git", args, {
    cwd: repoDir,
    encoding: "utf8",
  });
git(["init", "--initial-branch=main"]);
git(["config", "user.name", "Sandcastle Smoke"]);
git(["config", "user.email", "sandcastle-smoke@example.com"]);
git(["config", "commit.gpgsign", "false"]);
await writeFile(join(repoDir, "README.md"), "Apple Container worktree smoke\n");
git(["add", "README.md"]);
git(["commit", "--no-verify", "-m", "initial"]);

let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
let nestedSandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
let nestedHostWorktreeRegistered = false;
try {
  sandbox = await createSandbox({
    branch: "apple-container-smoke",
    cwd: repoDir,
    sandbox: appleContainer({
      imageName,
      cpus: 2,
      memory: "2G",
    }),
  });

  const worktreeGitFile = await readFile(
    join(sandbox.worktreePath, ".git"),
    "utf8",
  );
  const adminDir = worktreeGitFile.trim().replace(/^gitdir:\s*/, "");
  const adminBacklinkPath = join(adminDir, "gitdir");
  const expectedBacklink = join(await realpath(sandbox.worktreePath), ".git");
  assert.equal(
    (await readFile(adminBacklinkPath, "utf8")).trim(),
    expectedBacklink,
  );

  const gitProbe = await sandbox.exec(
    "git status --porcelain=v1 && git worktree prune --expire now && git status --porcelain=v1",
  );
  assert.equal(gitProbe.exitCode, 0, gitProbe.stderr);
  assert.equal(
    (await readFile(adminBacklinkPath, "utf8")).trim(),
    expectedBacklink,
  );

  await sandbox.close();
  sandbox = undefined;
  assert.match(
    git(["worktree", "list", "--porcelain"]),
    /branch refs\/heads\/main/,
  );

  git([
    "worktree",
    "add",
    "-b",
    "nested-host-worktree",
    nestedHostWorktree,
    "main",
  ]);
  nestedHostWorktreeRegistered = true;
  nestedSandbox = await createSandbox({
    branch: "apple-container-nested-smoke",
    cwd: nestedHostWorktree,
    sandbox: appleContainer({
      imageName,
      cpus: 2,
      memory: "2G",
    }),
  });

  const nestedProbe = await nestedSandbox.exec(
    "git status --porcelain=v1 && git worktree prune --expire now && git status --porcelain=v1",
  );
  assert.equal(nestedProbe.exitCode, 0, nestedProbe.stderr);
  assert.match(
    await readFile(join(nestedHostWorktree, ".git"), "utf8"),
    /^gitdir:\s+/,
  );

  await nestedSandbox.close();
  nestedSandbox = undefined;
  assert.match(
    git(["worktree", "list", "--porcelain"]),
    /branch refs\/heads\/nested-host-worktree/,
  );
  git(["worktree", "remove", "--force", nestedHostWorktree]);
  nestedHostWorktreeRegistered = false;
} finally {
  await nestedSandbox?.close();
  await sandbox?.close();
  if (nestedHostWorktreeRegistered) {
    try {
      git(["worktree", "remove", "--force", nestedHostWorktree]);
    } catch {}
  }
  await rm(nestedRoot, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
}

console.log("Apple Container smoke passed.");
