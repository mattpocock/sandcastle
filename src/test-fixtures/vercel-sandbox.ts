type SandboxCreate = (options?: Record<string, unknown>) => Promise<unknown>;

let createSandbox: SandboxCreate = async () => {
  throw new Error("Vercel sandbox test fixture was not configured");
};

export const setVercelSandboxCreate = (create: SandboxCreate): void => {
  createSandbox = create;
};

export class Sandbox {
  static create(options?: Record<string, unknown>): Promise<unknown> {
    return createSandbox(options);
  }
}
