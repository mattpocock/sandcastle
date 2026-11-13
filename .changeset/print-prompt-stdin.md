---
"@ai-hero/sandcastle": patch
---

`cursor()`, `opencode()` and `copilot()` deliver the print-mode prompt on stdin. A prompt on the command line failed once it passed about 120 KiB, and on Windows any multi-line prompt failed when the CLI was an npm `.cmd` shim, because cmd.exe cannot pass an argument that contains a newline.
