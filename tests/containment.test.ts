import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { release, tmpdir, userInfo } from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createSandbox } from "@ai-hero/sandcastle";
import {
  NATIVE_PROVIDERS,
  assertUsable,
  skipsHere,
} from "./helpers/nativeProviders.js";
import { spawnSandboxHolder } from "./helpers/sandboxHolder.js";

// The containment suite: what a native sandbox lets the agent do, and what it
// stops, proven on the real OS mechanism through the public API. Every
// provider in NATIVE_PROVIDERS runs the same probes. A provider is skipped on
// other OSes and where its tool is missing, but fails when `CI` is set.

const CANARY = "SANDCASTLE_CONTAINMENT_CANARY";
const DECLARED = "SANDCASTLE_CONTAINMENT_DECLARED";

/** A small Windows binary every Windows install has, for the WSL2 probe. */
const WINDOWS_EXE = "/mnt/c/Windows/System32/whoami.exe";

const isWsl2 = (): boolean =>
  process.platform === "linux" &&
  /microsoft/iu.test(release()) &&
  existsSync(WINDOWS_EXE);

/** Whether a host process exists (signal 0 checks without signalling). */
const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A host `sleep` with an unusual duration, which marks it in a process list. */
const HOST_SLEEP = "sleep 987.654";

const startHostSleep = (): { pid: number; stop: () => void } => {
  const proc = spawn("sleep", ["987.654"], { stdio: "ignore" });
  const { pid } = proc;
  if (pid === undefined) {
    throw new Error("Couldn't start a host sleep");
  }
  return {
    pid,
    stop: () => {
      proc.kill("SIGKILL");
    },
  };
};

const portOf = (server: Server): number => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The server isn't listening on a TCP port");
  }
  return address.port;
};

/** Every host process's command line, one per line. */
const hostProcesses = (): string =>
  execFileSync("ps", ["-eo", "args="], { encoding: "utf8" });

/** Paths under `root` whose last segment is `name`. */
const filesNamed = (root: string, name: string): string[] =>
  readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((entry) => path.basename(entry) === name)
    .map((entry) => path.join(root, entry));

describe.each(NATIVE_PROVIDERS)("containment: $name", (provider) => {
  describe.skipIf(skipsHere(provider))("on this host", () => {
    let repo = "";
    let outside = "";

    const git = (cwd: string, ...args: string[]): string =>
      execFileSync("git", args, { cwd, encoding: "utf8" });

    const open = async (): Promise<Awaited<ReturnType<typeof createSandbox>>> =>
      createSandbox({
        branch: "work",
        sandbox: provider.make(),
        cwd: repo,
      });

    beforeAll(() => {
      assertUsable(provider);
    });

    beforeEach(() => {
      repo = mkdtempSync(path.join(tmpdir(), "e2e-containment-"));
      outside = mkdtempSync(path.join(tmpdir(), "e2e-containment-outside-"));
      git(repo, "init", "-b", "main");
      writeFileSync(path.join(repo, "README.md"), "# repo\n");
      git(repo, "add", ".");
      git(repo, "commit", "-m", "init");
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    });

    it("lets a write inside the worktree through to the host", async () => {
      await using sandbox = await open();

      const result = await sandbox.exec("echo inside > written.txt");

      expect(result.exitCode).toBe(0);
      expect(
        readFileSync(path.join(sandbox.worktreePath, "written.txt"), "utf8"),
      ).toBe("inside\n");
    });

    it("stops a write to a host dir outside the worktree", async () => {
      await using sandbox = await open();
      const target = path.join(outside, "escaped.txt");

      const result = await sandbox.exec(`echo escaped > '${target}'`);

      expect(result.exitCode).not.toBe(0);
      expect(existsSync(target)).toBe(false);
    });

    it("keeps a write to the host repo, outside the worktree, off the host", async () => {
      await using sandbox = await open();
      const target = path.join(repo, "escaped.txt");

      await sandbox.exec(`echo escaped > '${target}'`);

      expect(existsSync(target)).toBe(false);
    });

    it("lets the agent commit to its branch", async () => {
      await using sandbox = await open();

      // The identity is passed inline: this probes that the git dirs are
      // writable, not how the identity reaches the sandbox.
      const result = await sandbox.exec(
        "echo change > change.txt && git add change.txt && " +
          "git -c user.name=Agent -c user.email=agent@example.com commit -m 'from the sandbox'",
      );

      expect(result.exitCode).toBe(0);
      expect(git(repo, "log", "-1", "--format=%s", "work").trim()).toBe(
        "from the sandbox",
      );
    });

    it("hides an undeclared host env var and passes a declared one", async () => {
      vi.stubEnv(CANARY, "host-secret");
      vi.stubEnv(DECLARED, "declared-value");
      mkdirSync(path.join(repo, ".sandcastle"));
      writeFileSync(path.join(repo, ".sandcastle", ".env"), `${DECLARED}=\n`);
      await using sandbox = await open();

      const result = await sandbox.exec(
        `echo "canary=\${${CANARY}:-unset}"; echo "declared=\${${DECLARED}:-unset}"`,
      );

      expect(result.stdout).toBe("canary=unset\ndeclared=declared-value\n");
    });

    it("hides a planted secret in the host HOME's .ssh", async () => {
      const home = path.join(outside, "home");
      const secret = path.join(home, ".ssh", "id_ed25519");
      mkdirSync(path.dirname(secret), { recursive: true });
      writeFileSync(secret, "PRIVATE KEY\n");
      vi.stubEnv("HOME", home);
      await using sandbox = await open();

      const result = await sandbox.exec(
        `cat '${secret}'; cat ~/.ssh/id_ed25519`,
      );

      expect(result.stdout).not.toContain("PRIVATE KEY");
    });

    it("hides a sibling repo", async () => {
      const sibling = path.join(
        path.dirname(repo),
        `${path.basename(repo)}-sibling`,
      );
      mkdirSync(sibling);
      writeFileSync(path.join(sibling, "notes.txt"), "sibling-content\n");
      try {
        await using sandbox = await open();

        const result = await sandbox.exec(`cat '${sibling}/notes.txt'`);

        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).not.toContain("sibling-content");
      } finally {
        rmSync(sibling, { recursive: true, force: true });
      }
    });

    describe("the toolchain behind a symlinked PATH executable", () => {
      const writeScript = (file: string, body: string): void => {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, `#!/bin/sh\n${body}\n`);
        chmodSync(file, 0o755);
      };

      /** Puts `bin` first on the host PATH, as a `~/.local/bin` would be. */
      const linkOnPath = (home: string, target: string, name: string): void => {
        const bin = path.join(home, ".local", "bin");
        mkdirSync(bin, { recursive: true });
        symlinkSync(target, path.join(bin, name));
        vi.stubEnv("HOME", home);
        vi.stubEnv("PATH", `${bin}:${process.env["PATH"] ?? ""}`);
      };

      it("hides the projects beside a tool under a stray package.json", async () => {
        const home = path.join(outside, "home");
        const code = path.join(home, "code");
        mkdirSync(code, { recursive: true });
        writeFileSync(path.join(code, "package.json"), "{}\n");
        const run = path.join(code, "mytool", "bin", "run");
        writeScript(run, "echo mytool ran");
        const secret = path.join(code, "other-project", ".env");
        mkdirSync(path.dirname(secret));
        writeFileSync(secret, "OTHER_PROJECT_SECRET\n");
        linkOnPath(home, run, "mytool");
        await using sandbox = await open();

        const tool = await sandbox.exec("mytool");
        const read = await sandbox.exec(`cat '${secret}'`);

        expect(tool).toMatchObject({ exitCode: 0, stdout: "mytool ran\n" });
        expect(read.stdout).not.toContain("OTHER_PROJECT_SECRET");
      });

      it("hides the rest of an npm-linked checkout", async () => {
        const home = path.join(outside, "home");
        const checkout = path.join(home, "projects", "mylib");
        mkdirSync(path.join(checkout, ".git"), { recursive: true });
        writeFileSync(path.join(checkout, "package.json"), "{}\n");
        writeFileSync(path.join(checkout, ".env"), "CHECKOUT_SECRET\n");
        const cli = path.join(checkout, "bin", "cli.js");
        writeScript(cli, "echo mylib ran");
        linkOnPath(home, cli, "mylib");
        await using sandbox = await open();

        const read = await sandbox.exec(`cat '${checkout}/.env'`);

        expect(read.stdout).not.toContain("CHECKOUT_SECRET");
      });

      it("hides a repo whose root dir holds the tool itself", async () => {
        const home = path.join(outside, "home");
        const checkout = path.join(home, "scripts");
        mkdirSync(path.join(checkout, ".git"), { recursive: true });
        writeFileSync(path.join(checkout, ".env"), "SCRIPTS_SECRET\n");
        const tool = path.join(checkout, "deploy");
        writeScript(tool, "echo deploy ran");
        linkOnPath(home, tool, "deploy");
        await using sandbox = await open();

        const read = await sandbox.exec(`cat '${checkout}/.env'`);

        expect(read.stdout).not.toContain("SCRIPTS_SECRET");
      });

      it("makes readable the whole package of a global npm install", async () => {
        // A global install under a prefix: the bin is a symlink into the
        // package, and the script reads a file elsewhere in that package.
        const home = path.join(outside, "home");
        const pkg = path.join(
          outside,
          "prefix",
          "lib",
          "node_modules",
          "@scope",
          "agent",
        );
        mkdirSync(path.join(pkg, "data"), { recursive: true });
        writeFileSync(path.join(pkg, "package.json"), "{}\n");
        writeFileSync(path.join(pkg, "data", "greeting.txt"), "from pkg\n");
        const bin = path.join(pkg, "bin", "agent");
        writeScript(
          bin,
          'cat "$(dirname "$(readlink -f "$0")")/../data/greeting.txt"',
        );
        linkOnPath(home, bin, "agent");
        await using sandbox = await open();

        const result = await sandbox.exec("agent");

        expect(result).toMatchObject({ exitCode: 0, stdout: "from pkg\n" });
      });
    });

    describe("git control files", () => {
      const commonDir = (): string => path.join(repo, ".git");
      const hookFile = (): string =>
        path.join(commonDir(), "hooks", "post-checkout");
      const configBefore = (): string =>
        readFileSync(path.join(commonDir(), "config"), "utf8");

      it("stops a write to the repo's git config", async () => {
        const before = configBefore();
        await using sandbox = await open();

        await sandbox.exec(
          `git config core.hooksPath /tmp/evil; echo '[core]' >> '${commonDir()}/config'`,
        );

        expect(configBefore()).toBe(before);
      });

      it("stops a write to the repo's git hooks", async () => {
        await using sandbox = await open();

        await sandbox.exec(
          `printf '#!/bin/sh\\necho pwned\\n' > '${hookFile()}'; chmod +x '${hookFile()}'`,
        );

        expect(existsSync(hookFile())).toBe(false);
      });

      it("stops replacing the git config by renaming a parent aside", async () => {
        const before = configBefore();
        await using sandbox = await open();
        const dir = commonDir();

        await sandbox.exec(
          `mv '${dir}' '${dir}.aside'; mkdir -p '${dir}'; ` +
            `cp -r '${dir}.aside/.' '${dir}/' 2>/dev/null; ` +
            `printf '[core]\\n\\thooksPath = /tmp/evil\\n' > '${dir}/config'`,
        );

        expect(configBefore()).toBe(before);
        expect(existsSync(`${dir}.aside`)).toBe(false);
      });

      it("stops replacing the git hooks by renaming a parent aside", async () => {
        await using sandbox = await open();
        const dir = commonDir();

        await sandbox.exec(
          `mv '${dir}/hooks' '${dir}/hooks.aside'; mkdir -p '${dir}/hooks'; ` +
            `printf '#!/bin/sh\\necho pwned\\n' > '${hookFile()}'; ` +
            `mv '${dir}' '${dir}.aside'; mkdir -p '${dir}/hooks'; ` +
            `printf '#!/bin/sh\\necho pwned\\n' > '${hookFile()}'`,
        );

        expect(existsSync(hookFile())).toBe(false);
        expect(existsSync(path.join(dir, "hooks.aside"))).toBe(false);
        expect(existsSync(`${dir}.aside`)).toBe(false);
      });

      it("stops replacing the git config by removing it or an ancestor", async () => {
        const before = configBefore();
        await using sandbox = await open();
        const dir = commonDir();

        await sandbox.exec(
          `rm -f '${dir}/config'; rm -rf '${dir}'; mkdir -p '${dir}'; ` +
            `printf '[core]\\n\\thooksPath = /tmp/evil\\n' > '${dir}/config'`,
        );

        expect(configBefore()).toBe(before);
      });

      it("stops replacing the git hooks by removing them", async () => {
        await using sandbox = await open();
        const dir = commonDir();

        await sandbox.exec(
          `rm -rf '${dir}/hooks'; mkdir -p '${dir}/hooks'; ` +
            `printf '#!/bin/sh\\necho pwned\\n' > '${hookFile()}'`,
        );

        expect(existsSync(hookFile())).toBe(false);
      });

      it("stops replacing the git info dir by renaming or removing it or a parent", async () => {
        const exclude = path.join(commonDir(), "info", "exclude");
        const before = readFileSync(exclude, "utf8");
        await using sandbox = await open();
        const dir = commonDir();
        const plant = `mkdir -p '${dir}/info'; echo evil > '${exclude}'`;

        await sandbox.exec(
          `echo evil >> '${exclude}'; ` +
            `mv '${dir}/info' '${dir}/info.aside'; ${plant}; ` +
            `rm -rf '${dir}/info'; ${plant}; ` +
            `mv '${dir}' '${dir}.aside'; ${plant}`,
        );

        expect(readFileSync(exclude, "utf8")).toBe(before);
        expect(existsSync(path.join(dir, "info.aside"))).toBe(false);
        expect(existsSync(`${dir}.aside`)).toBe(false);
      });

      it("stops replacing the worktree's git pointer file by renaming or removing it or a parent", async () => {
        await using sandbox = await open();
        const worktree = sandbox.worktreePath;
        const pointer = path.join(worktree, ".git");
        const before = readFileSync(pointer, "utf8");
        const plant = `echo 'gitdir: /tmp/evil' > '${pointer}'`;

        await sandbox.exec(
          `${plant}; ` +
            `mv '${pointer}' '${pointer}.aside'; ${plant}; ` +
            `rm -f '${pointer}'; ${plant}; ` +
            `cd /; mv '${worktree}' '${worktree}.aside'; mkdir -p '${worktree}'; ${plant}`,
        );

        expect(readFileSync(pointer, "utf8")).toBe(before);
        expect(existsSync(`${pointer}.aside`)).toBe(false);
        expect(existsSync(`${worktree}.aside`)).toBe(false);
      });

      it("stops replacing the worktree's commondir by renaming or removing it or a parent", async () => {
        await using sandbox = await open();
        const pointer = readFileSync(
          path.join(sandbox.worktreePath, ".git"),
          "utf8",
        );
        const adminDir = path.resolve(
          sandbox.worktreePath,
          pointer.trim().replace(/^gitdir: /u, ""),
        );
        const worktrees = path.dirname(adminDir);
        const commondir = path.join(adminDir, "commondir");
        const before = readFileSync(commondir, "utf8");
        const plant = `mkdir -p '${adminDir}'; echo /tmp/evil > '${commondir}'`;

        await sandbox.exec(
          `${plant}; ` +
            `mv '${commondir}' '${commondir}.aside'; ${plant}; ` +
            `rm -f '${commondir}'; ${plant}; ` +
            `mv '${adminDir}' '${adminDir}.aside'; ${plant}; ` +
            `mv '${worktrees}' '${worktrees}.aside'; ${plant}; ` +
            `rm -rf '${adminDir}'; ${plant}`,
        );

        expect(readFileSync(commondir, "utf8")).toBe(before);
        expect(existsSync(`${commondir}.aside`)).toBe(false);
        expect(existsSync(`${adminDir}.aside`)).toBe(false);
        expect(existsSync(`${worktrees}.aside`)).toBe(false);
      });
    });

    it("can't signal a host process", async () => {
      const host = startHostSleep();
      try {
        await using sandbox = await open();

        const result = await sandbox.exec(
          `kill -TERM ${host.pid}; echo "kill=$?"`,
        );

        expect(result.stdout).toBe("kill=1\n");
        expect(isRunning(host.pid)).toBe(true);
      } finally {
        host.stop();
      }
    });

    // Seatbelt has no PID namespace: listing is only mostly blocked there.
    it.skipIf(provider.platform !== "linux")(
      "can't list a host process (Linux only)",
      async () => {
        const host = startHostSleep();
        try {
          await using sandbox = await open();

          const result = await sandbox.exec("ps -eo args=");

          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("ps -eo args=");
          expect(result.stdout).not.toContain(HOST_SLEEP);
        } finally {
          host.stop();
        }
      },
    );

    // A known limit: Seatbelt has no PID namespace, so a host process is
    // hidden only because each way to list one is blocked. Observed on the
    // macOS job: the setuid `ps` can't run, `pgrep` can't reach sysmond, and
    // the `kern.proc.all` sysctl is denied. A process asking the kernel by PID
    // (proc_pidinfo) is limited to its own sandbox by `process-info*`.
    it.skipIf(provider.platform !== "darwin")(
      "can't list a host process with ps, pgrep or sysctl (macOS, known limit)",
      async () => {
        const host = startHostSleep();
        try {
          await using sandbox = await open();

          const result = await sandbox.exec(
            `ps -eo args=; echo "ps=$?"; ` +
              `pgrep -fl 'sleep 987'; echo "pgrep=$?"; ` +
              `sysctl kern.proc.all >/dev/null 2>&1; echo "sysctl=$?"`,
          );

          expect(result.stdout).not.toContain(HOST_SLEEP);
          expect(result.stdout).not.toContain("ps=0");
          expect(result.stdout).not.toContain("pgrep=0");
          expect(result.stdout).not.toContain("sysctl=0");
        } finally {
          host.stop();
        }
      },
    );

    it("keeps a file planted in the sandbox's ~/.claude off the host after close()", async () => {
      const home = path.join(outside, "home");
      mkdirSync(home);
      vi.stubEnv("HOME", home);
      // The private dirs live under the host's temp dir: give this sandbox its own.
      const hostTmp = path.join(outside, "tmp");
      mkdirSync(hostTmp);
      vi.stubEnv("TMPDIR", hostTmp);
      const name = `planted-${path.basename(outside)}.json`;
      {
        await using sandbox = await open();
        const result = await sandbox.exec(
          `mkdir -p ~/.claude && echo '{}' > ~/.claude/${name}`,
        );
        expect(result.exitCode).toBe(0);
        // Precondition: the scan below looks where the private home lives.
        expect(filesNamed(hostTmp, name)).toHaveLength(1);
      }

      expect(existsSync(path.join(home, ".claude", name))).toBe(false);
      expect(existsSync(path.join(userInfo().homedir, ".claude", name))).toBe(
        false,
      );
      expect(filesNamed(hostTmp, name)).toStrictEqual([]);
    });

    it("kills a background process started by exec on close()", async () => {
      const marker = "sleep 876.543";
      const sandbox = await open();
      const running = sandbox.exec(`${marker} & wait`);
      try {
        await vi.waitFor(
          () => {
            expect(hostProcesses()).toContain(marker);
          },
          { timeout: 3000 },
        );
      } finally {
        await sandbox.close();
      }
      await running.catch(() => undefined);

      expect(hostProcesses()).not.toContain(marker);
    });

    // Nothing in a SIGKILLed process runs, so neither close() nor the
    // shutdown handlers can help: only the provider's own defences can.
    describe("when the host Node process is SIGKILLed", () => {
      /**
       * Opens a sandbox in another process and SIGKILLs that process once
       * `started` holds. Returns the host processes still carrying the
       * sandbox's marker after up to 5 s: none, if the sandbox died.
       */
      const survivorsOfKill = async (
        started: (processes: string, marker: string) => boolean,
      ): Promise<string[]> => {
        // Unique per run, so no other process's command line matches it.
        const seconds = `765.${process.pid}${String(Date.now() % 1000)}`;
        const marker = `sleep ${seconds}`;
        const holder = await spawnSandboxHolder(provider.name, repo, seconds);
        try {
          await vi.waitFor(
            () => {
              expect(started(hostProcesses(), marker)).toBe(true);
            },
            { timeout: 5000, interval: 20 },
          );
        } finally {
          holder.kill("SIGKILL");
        }

        const survivors = (): string[] =>
          hostProcesses()
            .split("\n")
            .filter((line) => line.includes(marker));
        await vi
          .waitFor(
            () => {
              expect(survivors()).toStrictEqual([]);
            },
            { timeout: 5000, interval: 100 },
          )
          .catch(() => undefined);
        return survivors();
      };

      it("kills the sandbox's processes while its sleep is running", async () => {
        const survivors = await survivorsOfKill((processes, marker) =>
          processes.split("\n").includes(marker),
        );

        expect(survivors).toStrictEqual([]);
      }, 20_000);

      // The marker is in the sandbox tool's own command line from spawn, so
      // this kills the host while the sandbox is still being set up.
      it("kills the sandbox's processes while the exec is still starting", async () => {
        const survivors = await survivorsOfKill((processes, marker) =>
          processes.includes(marker),
        );

        expect(survivors).toStrictEqual([]);
      }, 20_000);
    });

    it.skipIf(!isWsl2())(
      "can't run a planted Windows .exe (WSL2 only)",
      async () => {
        await using sandbox = await open();
        const exe = path.join(sandbox.worktreePath, "planted.exe");
        copyFileSync(WINDOWS_EXE, exe);
        chmodSync(exe, 0o755);
        // Precondition: interop runs it on the host, so the probe means something.
        expect(execFileSync(exe, { encoding: "utf8" }).trim()).not.toBe("");

        const result = await sandbox.exec(
          `./planted.exe; echo "exe=$?"; ` +
            `ls /mnt/c /run/WSL >/dev/null 2>&1 && echo mounts=visible; ` +
            `echo "interop=\${WSL_INTEROP:-unset}"`,
        );

        expect(result.stdout).not.toMatch(/\\/u);
        expect(result.stdout).not.toContain("exe=0");
        expect(result.stdout).not.toContain("mounts=visible");
        expect(result.stdout).toContain("interop=unset");
      },
    );

    it("reaches the host's localhost (documented behaviour)", async () => {
      const server = createServer((socket) => {
        socket.end("host-localhost\n");
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const port = portOf(server);
        await using sandbox = await open();

        const result = await sandbox.exec(
          `bash -c 'exec 3<>/dev/tcp/127.0.0.1/${port} && cat <&3'`,
        );

        expect(result.stdout).toBe("host-localhost\n");
      } finally {
        server.close();
      }
    });
  });
});
