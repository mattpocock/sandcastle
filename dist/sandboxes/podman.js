import { createRequire } from 'node:module';
import { resolveUserMounts, processFileMountParents, formatVolumeMount, defaultImageName, registerShutdown } from '../chunk-VOG34SRF.js';
export { defaultImageName } from '../chunk-VOG34SRF.js';
import { createBindMountSandboxProvider } from '../chunk-BIWNFKGV.js';
import { MAX_TAIL_CHARS, BoundedTail } from '../chunk-NGBM7T3E.js';
import { execFile, execFileSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { createInterface } from 'readline';

createRequire(import.meta.url);
var podman = (options) => {
  const configuredImageName = options?.imageName;
  const selinuxLabel = options?.selinuxLabel ?? "z";
  const userns = options?.userns ?? "keep-id";
  const containerUid = options?.containerUid ?? 1e3;
  const containerGid = options?.containerGid ?? 1e3;
  const maxOutputTailChars = options?.maxOutputTailChars ?? MAX_TAIL_CHARS;
  const sandboxHomedir = "/home/agent";
  const userMounts = options?.mounts ? resolveUserMounts(options.mounts, sandboxHomedir) : [];
  const parentDirsToCreate = processFileMountParents(
    userMounts,
    sandboxHomedir
  );
  return createBindMountSandboxProvider({
    name: "podman",
    env: options?.env,
    sandboxHomedir,
    create: async (createOptions) => {
      const containerName = `sandcastle-${randomUUID()}`;
      const worktreePath = createOptions.mounts.find(
        (m) => m.hostPath === createOptions.worktreePath
      )?.sandboxPath ?? "/home/agent/workspace";
      const allMounts = [...createOptions.mounts, ...userMounts];
      const volumeMounts = allMounts.map(
        (m) => formatVolumeMount(m, selinuxLabel)
      );
      const imageName = configuredImageName ?? defaultImageName(createOptions.hostRepoPath);
      if (process.platform === "darwin" || process.platform === "win32") {
        await checkPodmanMachine();
      }
      await checkImageExists(imageName);
      const env = { ...createOptions.env, HOME: "/home/agent" };
      const envArgs = Object.entries(env).flatMap(([key, value]) => [
        "-e",
        `${key}=${value}`
      ]);
      const volumeArgs = volumeMounts.flatMap((v) => ["-v", v]);
      const usernsArgs = userns ? [`--userns=keep-id:uid=${containerUid},gid=${containerGid}`] : [];
      const userArgs = ["--user", `${containerUid}:${containerGid}`];
      const networks = options?.network ? Array.isArray(options.network) ? options.network : [options.network] : [];
      const networkArgs = networks.flatMap((n) => ["--network", n]);
      const groupArgs = (options?.groups ?? []).flatMap((g) => [
        "--group-add",
        String(g)
      ]);
      const deviceArgs = (options?.devices ?? []).flatMap((d) => [
        "--device",
        d
      ]);
      const cpusArgs = options?.cpus !== void 0 ? ["--cpus", String(options.cpus)] : [];
      await new Promise((resolve, reject) => {
        execFile(
          "podman",
          [
            "run",
            "-d",
            "--name",
            containerName,
            ...userArgs,
            ...usernsArgs,
            ...networkArgs,
            ...groupArgs,
            ...deviceArgs,
            ...cpusArgs,
            "-w",
            worktreePath,
            ...envArgs,
            ...volumeArgs,
            "--entrypoint",
            "sleep",
            imageName,
            "infinity"
          ],
          (error) => {
            if (error) {
              reject(new Error(`podman run failed: ${error.message}`));
            } else {
              resolve();
            }
          }
        );
      });
      for (const dir of parentDirsToCreate) {
        await new Promise((resolve, reject) => {
          execFile(
            "podman",
            [
              "exec",
              "--user",
              "0:0",
              containerName,
              "sh",
              "-c",
              `mkdir -p "$1" && chown "$2" "$1"`,
              "sh",
              dir,
              `${containerUid}:${containerGid}`
            ],
            (error) => {
              if (error) {
                reject(
                  new Error(
                    `Failed to create parent directory '${dir}' in container: ${error.message}`
                  )
                );
              } else {
                resolve();
              }
            }
          );
        });
      }
      const removeContainerSync = () => {
        try {
          execFileSync("podman", ["rm", "-f", containerName], {
            stdio: "ignore",
            timeout: 5e3
          });
        } catch {
        }
      };
      const unregisterShutdown = registerShutdown(removeContainerSync);
      const handle = {
        worktreePath,
        exec: (command, opts) => {
          const effectiveCommand = opts?.sudo ? `sudo ${command}` : command;
          const args = ["exec"];
          if (opts?.stdin !== void 0) args.push("-i");
          if (opts?.cwd) args.push("-w", opts.cwd);
          args.push(containerName, "sh", "-c", effectiveCommand);
          return new Promise((resolve, reject) => {
            const proc = spawn("podman", args, {
              stdio: [
                opts?.stdin !== void 0 ? "pipe" : "ignore",
                "pipe",
                "pipe"
              ]
            });
            if (opts?.stdin !== void 0) {
              proc.stdin.write(opts.stdin);
              proc.stdin.end();
            }
            proc.on("error", (error) => {
              reject(new Error(`podman exec failed: ${error.message}`));
            });
            if (opts?.onLine) {
              const onLine = opts.onLine;
              const stdoutTail = new BoundedTail(maxOutputTailChars, "\n");
              const stderrTail = new BoundedTail(maxOutputTailChars, "");
              const rl = createInterface({ input: proc.stdout });
              rl.on("line", (line) => {
                stdoutTail.push(line);
                onLine(line);
              });
              proc.stderr.on("data", (chunk) => {
                stderrTail.push(chunk.toString());
              });
              proc.on("close", (code) => {
                resolve({
                  stdout: stdoutTail.toString(),
                  stderr: stderrTail.toString(),
                  exitCode: code ?? 0
                });
              });
            } else {
              const stdoutChunks = [];
              const stderrChunks = [];
              proc.stdout.on("data", (chunk) => {
                stdoutChunks.push(chunk.toString());
              });
              proc.stderr.on("data", (chunk) => {
                stderrChunks.push(chunk.toString());
              });
              proc.on("close", (code) => {
                resolve({
                  stdout: stdoutChunks.join(""),
                  stderr: stderrChunks.join(""),
                  exitCode: code ?? 0
                });
              });
            }
          });
        },
        interactiveExec: (args, opts) => {
          return new Promise((resolve, reject) => {
            const podmanArgs = ["exec"];
            if ("isTTY" in opts.stdin && opts.stdin.isTTY) {
              podmanArgs.push("-it");
            } else {
              podmanArgs.push("-i");
            }
            if (opts.cwd) podmanArgs.push("-w", opts.cwd);
            podmanArgs.push(containerName, ...args);
            const proc = spawn("podman", podmanArgs, {
              stdio: [opts.stdin, opts.stdout, opts.stderr]
            });
            proc.on("error", (error) => {
              reject(new Error(`podman exec failed: ${error.message}`));
            });
            proc.on("close", (code) => {
              resolve({ exitCode: code ?? 0 });
            });
          });
        },
        copyFileIn: (hostPath, sandboxPath) => new Promise((resolve, reject) => {
          execFile(
            "podman",
            ["cp", hostPath, `${containerName}:${sandboxPath}`],
            (error) => {
              if (error) {
                reject(new Error(`podman cp (in) failed: ${error.message}`));
              } else {
                resolve();
              }
            }
          );
        }),
        copyFileOut: (sandboxPath, hostPath) => new Promise((resolve, reject) => {
          execFile(
            "podman",
            ["cp", `${containerName}:${sandboxPath}`, hostPath],
            (error) => {
              if (error) {
                reject(new Error(`podman cp (out) failed: ${error.message}`));
              } else {
                resolve();
              }
            }
          );
        }),
        close: async () => {
          unregisterShutdown();
          await new Promise((resolve, reject) => {
            execFile("podman", ["rm", "-f", containerName], (error) => {
              if (error) {
                reject(new Error(`podman rm failed: ${error.message}`));
              } else {
                resolve();
              }
            });
          });
        }
      };
      return handle;
    }
  });
};
var checkImageExists = (imageName) => new Promise((resolve, reject) => {
  execFile("podman", ["image", "inspect", imageName], (error) => {
    if (error) {
      reject(
        new Error(
          `Image '${imageName}' not found locally. Build it first with 'podman build -t ${imageName} .'`
        )
      );
    } else {
      resolve();
    }
  });
});
var podmanMachineError = () => new Error(
  "Podman Machine is not running. Run 'podman machine init && podman machine start' first."
);
var checkPodmanMachine = () => new Promise((resolve, reject) => {
  execFile(
    "podman",
    ["machine", "list", "--format", "json"],
    (error, stdout) => {
      if (error) {
        reject(podmanMachineError());
        return;
      }
      try {
        const machines = JSON.parse(stdout.toString());
        if (machines.some((m) => m.Running)) {
          resolve();
        } else {
          reject(podmanMachineError());
        }
      } catch {
        reject(podmanMachineError());
      }
    }
  );
});

export { podman };
//# sourceMappingURL=podman.js.map
//# sourceMappingURL=podman.js.map