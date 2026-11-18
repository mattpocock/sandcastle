import { access } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { createSandbox } from "@ai-hero/sandcastle/v1";
import { host } from "@ai-hero/sandcastle/v1/sandboxes/host";

// Run as its own Node process by tests/v1-host.test.ts: makes a host()
// sandbox in argv[2], starts a command that runs forever (it writes its pid
// to argv[3]), prints the sandbox's folder once that pid is there, and then
// either exits at once (argv[4] "exit") or waits to be signalled ("wait").
// Either way the process ends with the work still running.

const [rootDir, pidFile, mode] = process.argv.slice(2);
if (rootDir === undefined || pidFile === undefined) {
  throw new TypeError("usage: holdHostSandbox <rootDir> <pidFile> exit|wait");
}

const sandbox = await createSandbox({
  provider: host({ create: { rootDir } }),
  env: { PID_FILE: pidFile },
});
void sandbox.exec({
  command: `node -e 'require("node:fs").writeFileSync(process.env.PID_FILE, String(process.pid)); setInterval(() => {}, 1000)'`,
  allowFailure: true,
});
const waitForPid = async (): Promise<void> => {
  const there = await access(pidFile).then(
    () => true,
    () => false,
  );
  if (!there) {
    await sleep(50);
    await waitForPid();
  }
};
await waitForPid();
process.stdout.write(`${JSON.stringify({ folder: sandbox.native.folder })}\n`);
if (mode === "exit") {
  process.exit(0);
}
await sleep(60_000);
