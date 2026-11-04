import { defineConfig } from "tsup";
import pkg from "./package.json" with { type: "json" };

// The session supervisor: one self-contained file the host copies into each
// sandbox (src/v1/supervisorBundle.ts finds it), so every dependency is
// inlined. Built after tsup.config.ts, whose `clean` would remove it.
export default defineConfig({
  entry: { supervisor: "src/v1/supervisorMain.ts" },
  format: ["esm"],
  outDir: "dist",
  target: "node18",
  platform: "node",
  splitting: false,
  sourcemap: true,
  clean: false,
  dts: false,
  noExternal: [/.*/u],
  define: { __SANDCASTLE_VERSION__: JSON.stringify(pkg.version) },
  banner: {
    js: [
      "import { createRequire as __sandcastleCreateRequire } from 'node:module';",
      "const require = __sandcastleCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});
