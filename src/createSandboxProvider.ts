import type {
  BindMountSandboxProvider,
  BindMountSandboxProviderConfig,
  IsolatedSandboxProvider,
  IsolatedSandboxProviderConfig,
} from "./SandboxProvider.js";

/**
 * Create a bind-mount sandbox provider from a config object.
 * The returned provider can be passed to `run()` or `createSandbox()`.
 */
export const createBindMountSandboxProvider = (
  config: BindMountSandboxProviderConfig,
): BindMountSandboxProvider => ({
  tag: "bind-mount",
  name: config.name,
  env: config.env ?? {},
  sandboxHomedir: config.sandboxHomedir,
  create: config.create,
});

/**
 * Create an isolated sandbox provider from a config object.
 * The returned provider can be passed to `run()` or `createSandbox()`.
 */
export const createIsolatedSandboxProvider = (
  config: IsolatedSandboxProviderConfig,
): IsolatedSandboxProvider => ({
  tag: "isolated",
  name: config.name,
  env: config.env ?? {},
  create: config.create,
});
