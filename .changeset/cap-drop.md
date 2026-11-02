---
"@ai-hero/sandcastle": patch
---

Add a `capDrop` option to `docker()` and `podman()`. Each listed Linux capability (named without the `CAP_` prefix, or `"ALL"`) is passed to `docker run`/`podman run` as its own `--cap-drop` flag, so a sandbox can run without capabilities such as `NET_RAW`. The names are typed as `LinuxCapability`, so a misspelt one fails at compile time.
