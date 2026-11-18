---
"@ai-hero/sandcastle": minor
---

v1 sessions run on a Windows host, with no `sh`. The session supervisor starts as a plain `node supervisor.mjs daemon` and writes its own log, listens on a named pipe on Windows (a Unix socket elsewhere, as before), spawns each agent from its own argv (a `.cmd` or `.bat`, such as an npm-installed `claude`, through `cmd.exe`), and kills an agent with its whole process tree. The home probe and skills install are `node -p` commands. `@ai-hero/sandcastle/v1/testing` exports `startHostCommand`, which runs a command on this machine the same way, for test providers.
