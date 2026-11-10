---
"@ai-hero/sandcastle": patch
---

`sandcastle init` in a pnpm, yarn or bun project now says what to add to the scaffolded Dockerfile or Containerfile when it tells you to change the install hook: `RUN corepack enable` for pnpm and yarn, `RUN npm install -g bun` for bun, before the `USER` line. The image ships only npm, so the changed hook failed every run with `pnpm: not found`.
