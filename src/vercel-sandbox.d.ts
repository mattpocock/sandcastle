/** Minimal type declarations for @vercel/sandbox (optional peer dependency). */
declare module "@vercel/sandbox" {
  interface SandboxInstance {
    /** The sandbox's id, from SDK 2 on. */
    readonly name?: string;
    /** The sandbox's id in SDK 1.x; renamed `name` in SDK 2. */
    readonly sandboxId?: string;
    mkDir: (path: string) => Promise<void>;
    runCommand: (options: {
      cmd: string;
      args?: string[];
      cwd?: string;
      stdout?: NodeJS.WritableStream;
      stderr?: NodeJS.WritableStream;
    }) => Promise<{
      exitCode: number;
      stdout: () => Promise<string>;
      stderr: () => Promise<string>;
    }>;
    writeFiles: (
      files: { path: string; content: string | Buffer }[],
    ) => Promise<void>;
    readFileToBuffer: (options: { path: string }) => Promise<Buffer | null>;
    stop: () => Promise<void>;
  }

  export class Sandbox {
    static create(options?: Record<string, unknown>): Promise<SandboxInstance>;
  }
}
