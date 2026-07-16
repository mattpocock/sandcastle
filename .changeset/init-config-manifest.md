---
"@ai-hero/sandcastle": minor
---

`sandcastle init` now works in repos without a root `package.json` (e.g. Java or Python projects). Init writes a manifest inside `.sandcastle/` declaring `@ai-hero/sandcastle` and `tsx` as dependencies, installs template dependencies (like Zod for the planner templates) into `.sandcastle/` instead of the repo root, and prints next steps adapted to the scaffold-local manifest.
