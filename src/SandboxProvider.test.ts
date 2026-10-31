import { describe, expect, it, vi } from "vitest";
import {
  createBindMountSandboxProvider,
  createIsolatedSandboxProvider,
} from "./SandboxProvider.js";
import type {
  BindMountSandboxHandle,
  IsolatedSandboxHandle,
  SandboxProvider,
} from "./SandboxProvider.js";

describe("createBindMountSandboxProvider", () => {
  const makeMockHandle = (): BindMountSandboxHandle => ({
    worktreePath: "/workspace",
    exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    copyFileIn: vi.fn(async () => {}),
    copyFileOut: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  });

  it("returns a SandboxProvider with tag 'bind-mount'", () => {
    const provider = createBindMountSandboxProvider({
      name: "test-provider",
      create: async () => makeMockHandle(),
    });

    expect(provider.tag).toBe("bind-mount");
    expect(provider.name).toBe("test-provider");
  });

  it("delegates create() to the config's create function", async () => {
    const handle = makeMockHandle();
    const createFn = vi.fn(async () => handle);
    const provider = createBindMountSandboxProvider({
      name: "test-provider",
      create: createFn,
    });

    const options = {
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/home/user/repo",
      mounts: [{ hostPath: "/a", sandboxPath: "/b" }],
      env: { FOO: "bar" },
    };

    const result = await provider.create(options);

    expect(createFn).toHaveBeenCalledWith(options);
    expect(result).toBe(handle);
  });

  it("satisfies the SandboxProvider type", () => {
    const provider: SandboxProvider = createBindMountSandboxProvider({
      name: "typed",
      create: async () => makeMockHandle(),
    });

    expect(provider.tag).toBe("bind-mount");
  });

  it("does not have a branchStrategy property", () => {
    const provider = createBindMountSandboxProvider({
      name: "test-provider",
      create: async () => makeMockHandle(),
    });

    expect("branchStrategy" in provider).toBe(false);
  });
});

describe("createIsolatedSandboxProvider", () => {
  const makeMockHandle = (): IsolatedSandboxHandle => ({
    worktreePath: "/workspace",
    exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    copyIn: vi.fn(async () => {}),
    copyFileOut: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  });

  it("returns a SandboxProvider with tag 'isolated'", () => {
    const provider = createIsolatedSandboxProvider({
      name: "test-isolated",
      create: async () => makeMockHandle(),
    });

    expect(provider.tag).toBe("isolated");
    expect(provider.name).toBe("test-isolated");
  });

  it("delegates create() to the config's create function", async () => {
    const handle = makeMockHandle();
    const createFn = vi.fn(async () => handle);
    const provider = createIsolatedSandboxProvider({
      name: "test-isolated",
      create: createFn,
    });

    const options = { env: { FOO: "bar" } };
    const result = await provider.create(options);

    expect(createFn).toHaveBeenCalledWith(options);
    expect(result).toBe(handle);
  });

  it("satisfies the SandboxProvider type", () => {
    const provider: SandboxProvider = createIsolatedSandboxProvider({
      name: "typed",
      create: async () => makeMockHandle(),
    });

    expect(provider.tag).toBe("isolated");
  });

  it("does not have a branchStrategy property", () => {
    const provider = createIsolatedSandboxProvider({
      name: "test-isolated",
      create: async () => makeMockHandle(),
    });

    expect("branchStrategy" in provider).toBe(false);
  });
});
