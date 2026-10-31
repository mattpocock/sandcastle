---
"@ai-hero/sandcastle": patch
---

Fix `noSandbox()` on Windows mangling agent commands (#940). cmd.exe doesn't understand the POSIX quoting in Sandcastle's commands, so `--model 'claude-fable-5'` reached the agent CLI with the quotes attached, and prompts containing `&`, `|` or `%` were cut short or interpreted. On Windows, `noSandbox()` now splits a simple command into its arguments and starts the program directly; `.cmd` npm shims are run through cmd.exe with correct escaping. An argument a `.cmd` shim can't receive (a newline, or a command line over cmd.exe's 8191-character limit) now fails with a clear error instead of being silently cut short. Commands that use shell syntax still run through cmd.exe as before.
