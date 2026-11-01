---
"@ai-hero/sandcastle": patch
---

`sudo: true` sandbox hooks now run the whole command as root. On `docker` and `podman` they run as the container's root user (`exec --user 0:0`), so they work on the image `sandcastle init` scaffolds, which has no `sudo`. On `daytona` the command is wrapped in `sudo sh -c`, so a compound command (`a && b`) is elevated as a whole, not just its first part. `sandcastle docker remove-image` and `sandcastle podman remove-image` on a missing image now say the image does not exist, instead of asking whether the engine is running.
