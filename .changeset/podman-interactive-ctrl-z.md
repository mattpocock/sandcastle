---
"@ai-hero/sandcastle": patch
---

Enable Ctrl+Z (job control) in Podman interactive mode by wrapping the agent in a bash session with `set -m`. Suspending with Ctrl+Z drops into the shell; `fg` resumes the agent. The terminal is reset via `PROMPT_COMMAND` on resume, and the shell exits cleanly when the agent finishes normally.
