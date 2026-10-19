import { createRequire } from 'node:module';
import { MAX_TAIL_CHARS, BoundedTail } from './chunk-NGBM7T3E.js';
import { spawn } from 'child_process';
import { createInterface } from 'readline';

createRequire(import.meta.url);
var noSandbox = (options) => ({
  tag: "none",
  name: "no-sandbox",
  env: options?.env ?? {},
  create: async (createOptions) => {
    const worktreePath = createOptions.worktreePath;
    const processEnv = { ...process.env, ...createOptions.env };
    const maxOutputTailChars = options?.maxOutputTailChars ?? MAX_TAIL_CHARS;
    const handle = {
      worktreePath,
      exec: (command, opts) => {
        const cwd = opts?.cwd ?? worktreePath;
        const isWindows = process.platform === "win32";
        const shellCmd = isWindows ? "cmd.exe" : "sh";
        const shellArgs = isWindows ? ["/d", "/s", "/c", command] : ["-c", command];
        return new Promise((resolve, reject) => {
          const proc = spawn(shellCmd, shellArgs, {
            cwd,
            env: processEnv,
            stdio: [
              opts?.stdin !== void 0 ? "pipe" : "ignore",
              "pipe",
              "pipe"
            ],
            windowsVerbatimArguments: isWindows
          });
          if (opts?.stdin !== void 0) {
            proc.stdin.write(opts.stdin);
            proc.stdin.end();
          }
          proc.on("error", (error) => {
            reject(new Error(`exec failed: ${error.message}`));
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
          const [cmd, ...rest] = args;
          const proc = spawn(cmd, rest, {
            cwd: opts.cwd ?? worktreePath,
            env: processEnv,
            stdio: [opts.stdin, opts.stdout, opts.stderr],
            shell: process.platform === "win32"
          });
          proc.on("error", (error) => {
            reject(new Error(`exec failed: ${error.message}`));
          });
          proc.on("close", (code) => {
            resolve({ exitCode: code ?? 0 });
          });
        });
      },
      close: async () => {
      }
    };
    return handle;
  }
});

export { noSandbox };
//# sourceMappingURL=chunk-62WN33RK.js.map
//# sourceMappingURL=chunk-62WN33RK.js.map