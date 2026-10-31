import { createRequire } from 'node:module';
import { createIsolatedSandboxProvider } from '../chunk-BIWNFKGV.js';
import { MAX_TAIL_CHARS, BoundedTail } from '../chunk-NGBM7T3E.js';
import { stat, readdir } from 'fs/promises';
import { relative, join } from 'path';

createRequire(import.meta.url);
var daytona = (options) => createIsolatedSandboxProvider({
  name: "daytona",
  env: options?.env,
  create: async () => {
    const maxOutputTailChars = options?.maxOutputTailChars ?? MAX_TAIL_CHARS;
    const { Daytona } = await import('@daytona/sdk');
    const config = {};
    if (options?.apiKey) config.apiKey = options.apiKey;
    if (options?.apiUrl) config.apiUrl = options.apiUrl;
    if (options?.target) config.target = options.target;
    const client = new Daytona(config);
    const sandbox = await client.create(options?.create);
    const worktreePath = await sandbox.getWorkDir() ?? await sandbox.getUserHomeDir() ?? "/home/daytona";
    return {
      worktreePath,
      exec: async (command, opts) => {
        const effectiveCommand = opts?.sudo ? `sudo ${command}` : command;
        if (opts?.onLine) {
          const onLine = opts.onLine;
          const sessionId = `sandcastle-${crypto.randomUUID()}`;
          await sandbox.process.createSession(sessionId);
          try {
            const execResponse = await sandbox.process.executeSessionCommand(
              sessionId,
              {
                command: `cd ${opts?.cwd ?? worktreePath} && ${effectiveCommand}`,
                async: true
              }
            );
            const cmdId = execResponse.cmdId;
            const stdoutTail = new BoundedTail(maxOutputTailChars, "\n");
            const stderrTail = new BoundedTail(maxOutputTailChars, "");
            let partial = "";
            await sandbox.process.getSessionCommandLogs(
              sessionId,
              cmdId,
              (chunk) => {
                const text = partial + chunk;
                const lines = text.split("\n");
                partial = lines.pop() ?? "";
                for (const line of lines) {
                  stdoutTail.push(line);
                  onLine(line);
                }
              },
              (chunk) => {
                stderrTail.push(chunk);
              }
            );
            if (partial) {
              stdoutTail.push(partial);
              onLine(partial);
            }
            const cmdInfo = await sandbox.process.getSessionCommand(
              sessionId,
              cmdId
            );
            return {
              stdout: stdoutTail.toString(),
              stderr: stderrTail.toString(),
              exitCode: cmdInfo.exitCode ?? 0
            };
          } finally {
            await sandbox.process.deleteSession(sessionId).catch(() => {
            });
          }
        }
        const response = await sandbox.process.executeCommand(
          effectiveCommand,
          opts?.cwd ?? worktreePath
        );
        return {
          stdout: response.result,
          stderr: "",
          exitCode: response.exitCode
        };
      },
      copyIn: async (hostPath, sandboxPath) => {
        const info = await stat(hostPath);
        if (info.isDirectory()) {
          const walk = async (dir) => {
            const entries = await readdir(dir, { withFileTypes: true });
            const files2 = [];
            for (const entry of entries) {
              const full = join(dir, entry.name);
              if (entry.isDirectory()) {
                files2.push(...await walk(full));
              } else {
                files2.push(full);
              }
            }
            return files2;
          };
          const files = await walk(hostPath);
          for (const file of files) {
            const rel = relative(hostPath, file);
            await sandbox.fs.uploadFile(file, join(sandboxPath, rel));
          }
        } else {
          await sandbox.fs.uploadFile(hostPath, sandboxPath);
        }
      },
      copyFileOut: async (sandboxPath, hostPath) => {
        await sandbox.fs.downloadFile(sandboxPath, hostPath);
      },
      close: async () => {
        await client.delete(sandbox);
      }
    };
  }
});

export { daytona };
//# sourceMappingURL=daytona.js.map
//# sourceMappingURL=daytona.js.map