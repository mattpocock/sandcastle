---
"@ai-hero/sandcastle": patch
---

`sandcastle init` no longer aborts the wizard when the container build can't reach Docker/Podman. Before kicking off the build, it now probes the daemon: if it's not running, the user is prompted to start it and retry without re-answering any of the wizard prompts; if the binary isn't installed, `init` reports that and points to the standalone `sandcastle <provider> build-image` command. A build that fails after a healthy pre-flight is also surfaced inline (with the same retry hint) instead of crashing the process. The scaffolded `.sandcastle/` directory is preserved in every failure path.
