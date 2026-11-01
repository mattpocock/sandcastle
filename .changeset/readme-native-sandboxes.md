---
"@ai-hero/sandcastle": patch
---

The README leads with the native sandboxes, `bwrap()` and `seatbelt()`, in Prerequisites, Quick start and Sandbox Providers, with Docker and Podman second. A new Containment section says what a native sandbox protects against and what it doesn't (kernel escapes, host localhost, process listing and detached processes on macOS), and new notes cover Windows through WSL2, the Ubuntu 24.04+ user-namespace fix, logging in through env, `sudo: true` hooks, `interactive()`, and agents' own sandboxes.
