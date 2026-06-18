#!/usr/bin/env node
/**
 * Copy the template scaffolds from `src/templates` to `dist/templates`
 * after the build, replacing any existing copy.
 *
 * Uses Node.js fs APIs rather than `rm -rf` / `cp -r` so the build works
 * on Windows hosts (PowerShell has no `rm -rf`/`cp -r`) as well as on
 * macOS/Linux.
 */
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const src = join(here, "..", "src", "templates");
const dest = join(here, "..", "dist", "templates");

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });

console.log("✓ Templates copied to dist/templates");
