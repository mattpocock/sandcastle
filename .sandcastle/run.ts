import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";

const repository = "hanhnghh/sandcastle";
process.env.GH_REPO = repository;
process.env.CODEX_HOME = `${process.cwd()}/.sandcastle/codex-home`;

function command(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
  });
}

await command("codex", ["login", "status"]).catch(() => {
  throw new Error(
    'Project subscription auth is missing. Complete CODEX_HOME="$PWD/.sandcastle/codex-home" codex login before starting Sandcastle.',
  );
});
await command("gh", ["api", `repos/${repository}`, "--jq", ".full_name"]);
await command("docker", ["image", "inspect", "sandcastle-selfhost:local"]);
if (await command("git", ["status", "--porcelain"])) {
  throw new Error(
    "Commit the intended self-host baseline before starting Sandcastle.",
  );
}

// Host gh's credential stays in memory; no API key or token-bearing .env file.
process.env.GH_TOKEN = await command("gh", [
  "auth",
  "token",
  "--hostname",
  "github.com",
]);
process.env.GITHUB_TOKEN = process.env.GH_TOKEN;
delete process.env.OPENAI_API_KEY;
delete process.env.CODEX_API_KEY;
mkdirSync(".sandcastle/locks", { recursive: true, mode: 0o700 });
const lockFile = ".sandcastle/locks/selfhost.json";
if (existsSync(lockFile)) {
  const { pid } = JSON.parse(readFileSync(lockFile, "utf8"));
  try {
    process.kill(pid, 0);
    throw new Error(
      `Self-host runner PID ${pid} is already alive. Do not start a second controller.`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    rmSync(lockFile);
  }
}
const lock = openSync(lockFile, "wx", 0o600);
writeFileSync(
  lock,
  JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
);
closeSync(lock);
try {
  await import("./main.js");
} finally {
  if (
    existsSync(lockFile) &&
    JSON.parse(readFileSync(lockFile, "utf8")).pid === process.pid
  ) {
    rmSync(lockFile);
  }
}
