// Prepare only: never publishes packages or modifies registry accounts.
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
const exec = promisify(execFile);
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
if (
  args.some(
    (arg, index) =>
      index % 2 === 0 &&
      !["--name", "--out", "--version", "--notes"].includes(arg),
  ) ||
  args.length % 2
)
  throw new Error(
    "Use --name <fork-package> --out <directory> [--version <unique-prerelease>] [--notes <file>]",
  );
const name = args.includes("--name") ? value("--name") : null;
if (
  !name ||
  !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name) ||
  name === "@ai-hero/sandcastle"
)
  throw new Error("Provide a distinct fork package identity");
if (!args.includes("--out")) throw new Error("Provide --out");
const out = resolve(value("--out"));
const commit = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const version = args.includes("--version")
  ? value("--version")
  : `${pkg.version}-fork.${Date.now()}.${commit.slice(0, 12)}`;
if (!/^\d+\.\d+\.\d+-[a-zA-Z0-9.-]+$/.test(version) || version === pkg.version)
  throw new Error("Fork candidates require a unique prerelease version");
const staging = await mkdtemp(join(tmpdir(), "sandcastle-fork-"));
try {
  await mkdir(out, { recursive: true });
  // Reject overwriting a version prepared earlier in this release directory.
  const archiveName =
    name.replace("@", "").replace("/", "-") + "-" + version + ".tgz";
  try {
    await access(join(out, archiveName));
    throw new Error("Candidate version already exists; choose a new version");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await cp("dist", join(staging, "dist"), { recursive: true });
  await cp("LICENSE", join(staging, "LICENSE"));
  await cp("README.md", join(staging, "README.md"));
  for (const path of [
    "dist/main.js",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/templates/parallel-planner-with-review/implement-prompt.md",
  ])
    await access(join(staging, path));
  const notes = args.includes("--notes")
    ? await readFile(value("--notes"), "utf8")
    : `Fork candidate ${version} from ${commit}. Package installation only; project migration is separate.`;
  const metadata = {
    schemaVersion: 1,
    source: "https://github.com/hanhnghh/sandcastle",
    commit,
    version,
  };
  await writeFile(
    join(staging, "package.json"),
    JSON.stringify(
      {
        ...pkg,
        name,
        version,
        repository: { type: "git", url: metadata.source },
        scripts: {},
        sandcastleRuntime: metadata,
        sandcastleChangelog: notes,
        files: [
          "dist",
          "LICENSE",
          "README.md",
          "CHANGELOG.md",
          "runtime-source.json",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(join(staging, "CHANGELOG.md"), notes + "\n");
  await writeFile(
    join(staging, "runtime-source.json"),
    JSON.stringify(metadata, null, 2) + "\n",
  );
  const output = JSON.parse(
    (
      await exec(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", out],
        { cwd: staging },
      )
    ).stdout,
  )[0];
  const archive = join(out, output.filename);
  const integrity =
    "sha512-" +
    createHash("sha512")
      .update(await readFile(archive))
      .digest("base64");
  const receipt = {
    package: name,
    version,
    archive,
    integrity,
    source: metadata,
    files: output.files.map((file) => file.path),
  };
  await writeFile(archive + ".json", JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt));
} finally {
  await rm(staging, { recursive: true, force: true });
}
