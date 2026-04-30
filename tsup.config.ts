import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync("./package.json", "utf8")) as {
  version: string;
};

export default defineConfig({
  entry: {
    index: "src/index.ts",
    main: "src/main.ts",
    "sandboxes/docker": "src/sandboxes/docker.ts",
    "sandboxes/podman": "src/sandboxes/podman.ts",
    "sandboxes/vercel": "src/sandboxes/vercel.ts",
    "sandboxes/daytona": "src/sandboxes/daytona.ts",
    "sandboxes/coder": "src/sandboxes/coder.ts",
    "sandboxes/no-sandbox": "src/sandboxes/no-sandbox.ts",
  },
  format: ["esm"],
  outDir: "dist",
  target: "node18",
  platform: "node",
  splitting: true,
  sourcemap: true,
  clean: true,
  dts: true,
  treeshake: true,
  external: ["@vercel/sandbox", "@daytona/sdk"],
  define: {
    __SANDCASTLE_VERSION__: JSON.stringify(pkg.version),
  },
  // Some bundled CJS dependencies (notably `undici` via `@effect/platform-node`)
  // use `require()` of Node built-ins. ESM has no `require`, so we install one
  // via `createRequire` so the bundled CJS-shaped code keeps working.
  banner: {
    js: [
      "import { createRequire as __sandcastleCreateRequire } from 'node:module';",
      "const require = __sandcastleCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});
