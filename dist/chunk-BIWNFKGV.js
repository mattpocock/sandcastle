import { createRequire } from 'node:module';

createRequire(import.meta.url);

// src/SandboxProvider.ts
var createBindMountSandboxProvider = (config) => ({
  tag: "bind-mount",
  name: config.name,
  env: config.env ?? {},
  sandboxHomedir: config.sandboxHomedir,
  create: config.create
});
var createIsolatedSandboxProvider = (config) => ({
  tag: "isolated",
  name: config.name,
  env: config.env ?? {},
  create: config.create
});

export { createBindMountSandboxProvider, createIsolatedSandboxProvider };
//# sourceMappingURL=chunk-BIWNFKGV.js.map
//# sourceMappingURL=chunk-BIWNFKGV.js.map