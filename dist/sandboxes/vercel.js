import { createRequire } from 'node:module';
import { createIsolatedSandboxProvider } from '../chunk-BIWNFKGV.js';
import { MAX_TAIL_CHARS, BoundedTail } from '../chunk-NGBM7T3E.js';
import { execSync } from 'child_process';
import { mkdir, writeFile, stat, readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { Writable } from 'stream';

createRequire(import.meta.url);
var VERCEL_REPO_PATH = "/vercel/sandbox/workspace";
var vercel = (options) => createIsolatedSandboxProvider({
  name: "vercel",
  env: options?.env,
  create: async (createOptions) => {
    const maxOutputTailChars = options?.maxOutputTailChars ?? MAX_TAIL_CHARS;
    const { Sandbox } = await import('@vercel/sandbox');
    const createParams = {};
    if (options?.source) createParams.source = options.source;
    if (options?.ports) createParams.ports = options.ports;
    if (options?.resources) createParams.resources = options.resources;
    if (options?.networkPolicy)
      createParams.networkPolicy = options.networkPolicy;
    const resolvedRuntime = options?.runtime ?? options?.template;
    if (resolvedRuntime) createParams.runtime = resolvedRuntime;
    const timeoutValue = options?.timeout ?? options?.timeoutMs;
    if (timeoutValue !== void 0) createParams.timeout = timeoutValue;
    createParams.env = createOptions.env;
    if (options?.token) createParams.token = options.token;
    if (options?.projectId) createParams.projectId = options.projectId;
    if (options?.teamId) createParams.teamId = options.teamId;
    const sandbox = await Sandbox.create(
      createParams
    );
    await sandbox.mkDir(VERCEL_REPO_PATH);
    const handle = {
      worktreePath: VERCEL_REPO_PATH,
      exec: async (command, opts) => {
        if (opts?.onLine) {
          const onLine = opts.onLine;
          const stdoutTail = new BoundedTail(maxOutputTailChars, "\n");
          const stderrTail = new BoundedTail(maxOutputTailChars, "");
          let partial = "";
          const stdoutWritable = new Writable({
            write(chunk, _encoding, callback) {
              const text = partial + chunk.toString();
              const lines = text.split("\n");
              partial = lines.pop() ?? "";
              for (const line of lines) {
                stdoutTail.push(line);
                onLine(line);
              }
              callback();
            },
            final(callback) {
              if (partial) {
                stdoutTail.push(partial);
                onLine(partial);
                partial = "";
              }
              callback();
            }
          });
          const stderrWritable = new Writable({
            write(chunk, _encoding, callback) {
              stderrTail.push(chunk.toString());
              callback();
            }
          });
          const result2 = await sandbox.runCommand({
            cmd: "sh",
            args: ["-c", command],
            cwd: opts?.cwd ?? VERCEL_REPO_PATH,
            stdout: stdoutWritable,
            stderr: stderrWritable,
            ...opts?.sudo ? { sudo: true } : {}
          });
          return {
            stdout: stdoutTail.toString(),
            stderr: stderrTail.toString(),
            exitCode: result2.exitCode
          };
        }
        const result = await sandbox.runCommand({
          cmd: "sh",
          args: ["-c", command],
          cwd: opts?.cwd ?? VERCEL_REPO_PATH,
          ...opts?.sudo ? { sudo: true } : {}
        });
        const stdout = await result.stdout();
        const stderr = await result.stderr();
        return {
          stdout,
          stderr,
          exitCode: result.exitCode
        };
      },
      copyIn: async (hostPath, sandboxPath) => {
        const info = await stat(hostPath);
        if (info.isDirectory()) {
          const tarPath = join(
            tmpdir(),
            `sandcastle-copyin-${Date.now()}.tar.gz`
          );
          execSync(`tar -czf "${tarPath}" -C "${hostPath}" .`);
          try {
            const tarContent = await readFile(tarPath);
            const sandboxTarPath = `/tmp/sandcastle-copyin-${Date.now()}.tar.gz`;
            await sandbox.writeFiles([
              { path: sandboxTarPath, content: tarContent }
            ]);
            await sandbox.runCommand({
              cmd: "sh",
              args: [
                "-c",
                `mkdir -p "${sandboxPath}" && tar -xzf "${sandboxTarPath}" -C "${sandboxPath}" && rm -f "${sandboxTarPath}"`
              ]
            });
          } finally {
            await unlink(tarPath).catch(() => {
            });
          }
        } else {
          const content = await readFile(hostPath);
          await sandbox.writeFiles([{ path: sandboxPath, content }]);
        }
      },
      copyFileOut: async (sandboxPath, hostPath) => {
        const buffer = await sandbox.readFileToBuffer({
          path: sandboxPath
        });
        if (!buffer) {
          throw new Error(`File not found in Vercel sandbox: ${sandboxPath}`);
        }
        await mkdir(dirname(hostPath), { recursive: true });
        await writeFile(hostPath, buffer);
      },
      close: async () => {
        await sandbox.stop();
      }
    };
    return handle;
  }
});

export { vercel };
//# sourceMappingURL=vercel.js.map
//# sourceMappingURL=vercel.js.map