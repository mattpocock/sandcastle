import { createRequire } from 'node:module';
import { Effect_exports, resolveUserMounts, processFileMountParents, defaultImageName, registerShutdown, DockerError, formatVolumeMount } from './chunk-VOG34SRF.js';
import { createBindMountSandboxProvider } from './chunk-BIWNFKGV.js';
import { MAX_TAIL_CHARS, BoundedTail } from './chunk-NGBM7T3E.js';
import { execFile, execFileSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { createInterface } from 'readline';
import { resolve } from 'path';

createRequire(import.meta.url);
var dockerExec = (args) => Effect_exports.async((resume) => {
  execFile(
    "docker",
    args,
    { maxBuffer: 10 * 1024 * 1024 },
    (error, stdout, stderr) => {
      if (error) {
        resume(
          Effect_exports.fail(
            new DockerError({
              message: `docker ${args[0]} failed: ${stderr?.toString() || error.message}`
            })
          )
        );
      } else {
        resume(Effect_exports.succeed(stdout.toString()));
      }
    }
  );
});
var buildImage = (imageName, dockerfileDir, options) => Effect_exports.gen(function* () {
  const buildArgFlags = Object.entries(options?.buildArgs ?? {}).flatMap(
    ([k, v]) => ["--build-arg", `${k}=${v}`]
  );
  if (options?.dockerfile) {
    yield* dockerExec([
      "build",
      "-t",
      imageName,
      ...buildArgFlags,
      "-f",
      resolve(options.dockerfile),
      process.cwd()
    ]);
  } else {
    yield* dockerExec([
      "build",
      "-t",
      imageName,
      ...buildArgFlags,
      resolve(dockerfileDir)
    ]);
  }
});
var startContainer = (containerName, imageName, env, options) => Effect_exports.gen(function* () {
  const existing = yield* dockerExec([
    "ps",
    "-a",
    "--filter",
    `name=^${containerName}$`,
    "--format",
    "{{.Names}}"
  ]);
  if (existing.trim() === containerName) {
    yield* Effect_exports.fail(
      new DockerError({
        message: `Container '${containerName}' already exists. Run cleanup first.`
      })
    );
  }
  const envFlags = Object.entries(env).flatMap(([k, v]) => [
    "-e",
    `${k}=${v}`
  ]);
  const selinuxLabel = options?.selinuxLabel ?? "z";
  const volumeFlags = (options?.volumeMounts ?? []).flatMap((mount) => [
    "-v",
    formatVolumeMount(mount, selinuxLabel)
  ]);
  const workdirFlags = options?.workdir ? ["-w", options.workdir] : [];
  const userFlags = options?.user ? ["--user", options.user] : [];
  const networks = options?.network ? Array.isArray(options.network) ? options.network : [options.network] : [];
  const networkFlags = networks.flatMap((n) => ["--network", n]);
  const groupAddFlags = (options?.groups ?? []).flatMap((g) => [
    "--group-add",
    String(g)
  ]);
  const deviceFlags = (options?.devices ?? []).flatMap((d) => [
    "--device",
    d
  ]);
  const cpusFlags = options?.cpus !== void 0 ? ["--cpus", String(options.cpus)] : [];
  yield* dockerExec([
    "run",
    "-d",
    "--name",
    containerName,
    ...envFlags,
    ...volumeFlags,
    ...workdirFlags,
    ...userFlags,
    ...networkFlags,
    ...groupAddFlags,
    ...deviceFlags,
    ...cpusFlags,
    imageName
  ]);
});
var removeContainer = (containerName) => Effect_exports.gen(function* () {
  yield* Effect_exports.ignore(dockerExec(["stop", containerName]));
  yield* Effect_exports.ignore(dockerExec(["rm", containerName]));
});
var removeImage = (imageName) => Effect_exports.gen(function* () {
  yield* dockerExec(["rmi", imageName]);
});

// src/sandboxes/docker.ts
var docker = (options) => {
  const configuredImageName = options?.imageName;
  const selinuxLabel = options?.selinuxLabel ?? "z";
  const maxOutputTailChars = options?.maxOutputTailChars ?? MAX_TAIL_CHARS;
  const sandboxHomedir = "/home/agent";
  const userMounts = options?.mounts ? resolveUserMounts(options.mounts, sandboxHomedir) : [];
  const parentDirsToCreate = processFileMountParents(
    userMounts,
    sandboxHomedir
  );
  return createBindMountSandboxProvider({
    name: "docker",
    env: options?.env,
    sandboxHomedir,
    create: async (createOptions) => {
      const containerName = `sandcastle-${randomUUID()}`;
      const worktreePath = createOptions.mounts.find(
        (m) => m.hostPath === createOptions.worktreePath
      )?.sandboxPath ?? "/home/agent/workspace";
      const allMounts = [...createOptions.mounts, ...userMounts];
      const volumeMounts = allMounts.map((m) => ({
        hostPath: m.hostPath,
        sandboxPath: m.sandboxPath,
        readonly: m.readonly
      }));
      const imageName = configuredImageName ?? defaultImageName(createOptions.hostRepoPath);
      const containerUid = options?.containerUid ?? process.getuid?.() ?? 1e3;
      const containerGid = options?.containerGid ?? process.getgid?.() ?? 1e3;
      await checkImageUid(imageName, containerUid);
      await Effect_exports.runPromise(
        startContainer(
          containerName,
          imageName,
          {
            ...createOptions.env,
            HOME: "/home/agent"
          },
          {
            volumeMounts,
            workdir: worktreePath,
            user: `${containerUid}:${containerGid}`,
            network: options?.network,
            groups: options?.groups,
            devices: options?.devices,
            cpus: options?.cpus,
            selinuxLabel
          }
        )
      );
      for (const dir of parentDirsToCreate) {
        await new Promise((resolve2, reject) => {
          execFile(
            "docker",
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
                resolve2();
              }
            }
          );
        });
      }
      const removeContainerSync = () => {
        try {
          execFileSync("docker", ["rm", "-f", containerName], {
            stdio: "ignore"
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
          return new Promise((resolve2, reject) => {
            const proc = spawn("docker", args, {
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
              reject(new Error(`docker exec failed: ${error.message}`));
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
                resolve2({
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
                resolve2({
                  stdout: stdoutChunks.join(""),
                  stderr: stderrChunks.join(""),
                  exitCode: code ?? 0
                });
              });
            }
          });
        },
        interactiveExec: (args, opts) => {
          return new Promise((resolve2, reject) => {
            const dockerArgs = ["exec"];
            if ("isTTY" in opts.stdin && opts.stdin.isTTY) {
              dockerArgs.push("-it");
            } else {
              dockerArgs.push("-i");
            }
            if (opts.cwd) dockerArgs.push("-w", opts.cwd);
            dockerArgs.push(containerName, ...args);
            const proc = spawn("docker", dockerArgs, {
              stdio: [opts.stdin, opts.stdout, opts.stderr]
            });
            proc.on("error", (error) => {
              reject(new Error(`docker exec failed: ${error.message}`));
            });
            proc.on("close", (code) => {
              resolve2({ exitCode: code ?? 0 });
            });
          });
        },
        copyFileIn: (hostPath, sandboxPath) => new Promise((resolve2, reject) => {
          execFile(
            "docker",
            ["cp", hostPath, `${containerName}:${sandboxPath}`],
            (error) => {
              if (error) {
                reject(new Error(`docker cp (in) failed: ${error.message}`));
              } else {
                resolve2();
              }
            }
          );
        }),
        copyFileOut: (sandboxPath, hostPath) => new Promise((resolve2, reject) => {
          execFile(
            "docker",
            ["cp", `${containerName}:${sandboxPath}`, hostPath],
            (error) => {
              if (error) {
                reject(new Error(`docker cp (out) failed: ${error.message}`));
              } else {
                resolve2();
              }
            }
          );
        }),
        close: async () => {
          unregisterShutdown();
          await Effect_exports.runPromise(removeContainer(containerName));
        }
      };
      return handle;
    }
  });
};
var checkImageUid = (imageName, expectedUid) => new Promise((resolve2, reject) => {
  execFile(
    "docker",
    ["image", "inspect", imageName, "--format", "{{.Config.User}}"],
    (error, stdout) => {
      if (error) {
        reject(
          new Error(
            `Image '${imageName}' not found locally. Build it first with 'sandcastle docker build-image'.`
          )
        );
        return;
      }
      const imageUser = (stdout ?? "").toString().trim();
      if (!imageUser) {
        resolve2();
        return;
      }
      const uidPart = imageUser.split(":")[0];
      const imageUid = parseInt(uidPart, 10);
      if (isNaN(imageUid)) {
        resolve2();
        return;
      }
      if (imageUid !== expectedUid) {
        reject(
          new Error(
            `UID mismatch: image '${imageName}' was built with UID ${imageUid}, but the expected UID is ${expectedUid}. Rebuild the image with 'sandcastle docker build-image', or pass containerUid: ${imageUid} to docker() to match the image.`
          )
        );
      } else {
        resolve2();
      }
    }
  );
});

export { buildImage, docker, removeImage };
//# sourceMappingURL=chunk-CP3TYXZA.js.map
//# sourceMappingURL=chunk-CP3TYXZA.js.map