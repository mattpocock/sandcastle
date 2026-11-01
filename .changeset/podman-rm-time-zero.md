---
"@ai-hero/sandcastle": patch
---

`podman()` now removes its container straight away on teardown (`podman rm -f --time 0`). Before, an interrupted run (SIGINT/SIGTERM) could leave the container stuck in `Stopping`, and every normal teardown waited out podman's 10-second stop timeout.
