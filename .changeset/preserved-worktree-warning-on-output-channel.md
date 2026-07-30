---
"@ai-hero/sandcastle": patch
---

The preserved-worktree warning now goes through `Display` instead of `console.error`. In log-to-file mode it lands in the run log alongside the rest of the run, rather than on stderr where nothing was collecting it; in terminal mode it is still shown on screen. The message text is unchanged, cleanup command included.
