import { describe, expect, it } from "vitest";
import type {
  BindMountCreateOptions,
  BindMountSandboxHandle,
  IsolatedCreateOptions,
  IsolatedSandboxHandle,
  SandboxProvider,
} from "@ai-hero/sandcastle";
import {
  createBindMountSandboxProvider,
  createIsolatedSandboxProvider,
} from "@ai-hero/sandcastle";

// The two factories a custom sandbox provider is built with.

const ok = async () => ({ stdout: "", stderr: "", exitCode: 0 });
const noop = async () => undefined;

const bindMountHandle = (): BindMountSandboxHandle => ({
  worktreePath: "/workspace",
  exec: ok,
  copyFileIn: noop,
  copyFileOut: noop,
  close: noop,
});

const isolatedHandle = (): IsolatedSandboxHandle => ({
  worktreePath: "/workspace",
  exec: ok,
  copyIn: noop,
  copyFileOut: noop,
  close: noop,
});

describe("createBindMountSandboxProvider", () => {
  it("makes a bind-mount provider with the given name", () => {
    const provider: SandboxProvider = createBindMountSandboxProvider({
      name: "test-provider",
      create: async () => bindMountHandle(),
    });

    expect(provider.tag).toBe("bind-mount");
    expect(provider.name).toBe("test-provider");
  });

  it("creates sandboxes with the config's create function", async () => {
    const handle = bindMountHandle();
    const calls: BindMountCreateOptions[] = [];
    const provider = createBindMountSandboxProvider({
      name: "test-provider",
      create: async (options) => {
        calls.push(options);
        return handle;
      },
    });
    const options = {
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/home/user/repo",
      mounts: [{ hostPath: "/a", sandboxPath: "/b" }],
      env: { FOO: "bar" },
    };

    const result = await provider.create(options);

    expect(calls).toStrictEqual([options]);
    expect(result).toBe(handle);
  });

  it("has no branchStrategy of its own", () => {
    const provider = createBindMountSandboxProvider({
      name: "test-provider",
      create: async () => bindMountHandle(),
    });

    expect("branchStrategy" in provider).toBe(false);
  });
});

describe("createIsolatedSandboxProvider", () => {
  it("makes an isolated provider with the given name", () => {
    const provider: SandboxProvider = createIsolatedSandboxProvider({
      name: "test-isolated",
      create: async () => isolatedHandle(),
    });

    expect(provider.tag).toBe("isolated");
    expect(provider.name).toBe("test-isolated");
  });

  it("creates sandboxes with the config's create function", async () => {
    const handle = isolatedHandle();
    const calls: IsolatedCreateOptions[] = [];
    const provider = createIsolatedSandboxProvider({
      name: "test-isolated",
      create: async (options) => {
        calls.push(options);
        return handle;
      },
    });
    const options = { env: { FOO: "bar" } };

    const result = await provider.create(options);

    expect(calls).toStrictEqual([options]);
    expect(result).toBe(handle);
  });

  it("has no branchStrategy of its own", () => {
    const provider = createIsolatedSandboxProvider({
      name: "test-isolated",
      create: async () => isolatedHandle(),
    });

    expect("branchStrategy" in provider).toBe(false);
  });
});
