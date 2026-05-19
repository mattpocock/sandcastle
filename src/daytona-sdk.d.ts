/** Minimal type declarations for @daytona/sdk (optional peer dependency). */
declare module "@daytona/sdk" {
  export interface DaytonaConfig {
    apiKey?: string;
    apiUrl?: string;
    target?: string;
  }

  export interface CreateSandboxFromImageParams {
    [key: string]: unknown;
  }

  export interface CreateSandboxFromSnapshotParams {
    [key: string]: unknown;
  }

  interface SessionCommandResponse {
    cmdId?: string;
  }

  interface SessionCommandInfo {
    exitCode?: number;
  }

  interface ExecuteCommandResponse {
    result: string;
    exitCode: number;
  }

  interface SandboxProcess {
    createSession(sessionId: string): Promise<void>;
    executeSessionCommand(
      sessionId: string,
      options: { command: string; async?: boolean },
    ): Promise<SessionCommandResponse>;
    getSessionCommandLogs(
      sessionId: string,
      cmdId: string,
      onStdout?: (chunk: string) => void,
      onStderr?: (chunk: string) => void,
    ): Promise<void>;
    getSessionCommand(
      sessionId: string,
      cmdId: string,
    ): Promise<SessionCommandInfo>;
    deleteSession(sessionId: string): Promise<void>;
    executeCommand(
      command: string,
      cwd?: string,
    ): Promise<ExecuteCommandResponse>;
  }

  interface SandboxFileSystem {
    uploadFile(localPath: string, remotePath: string): Promise<void>;
    downloadFile(remotePath: string, localPath: string): Promise<void>;
  }

  interface SandboxInstance {
    process: SandboxProcess;
    fs: SandboxFileSystem;
    getWorkDir(): Promise<string | undefined>;
    getUserHomeDir(): Promise<string | undefined>;
  }

  export class Daytona {
    constructor(config?: DaytonaConfig);
    create(
      params?: CreateSandboxFromImageParams | CreateSandboxFromSnapshotParams,
    ): Promise<SandboxInstance>;
    delete(sandbox: SandboxInstance): Promise<void>;
  }
}
