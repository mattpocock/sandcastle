---
"@ai-hero/sandcastle": minor
---

Ensure the Vercel and Daytona sandbox providers deliver prompts supplied over stdin, so stdin-based agents no longer receive empty prompts. The Vercel provider now supports `@vercel/sandbox` 2.x and 3.x; 1.x is excluded because early releases can lose streamed output.
