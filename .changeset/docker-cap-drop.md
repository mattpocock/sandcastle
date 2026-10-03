---
"@ai-hero/sandcastle": patch
---

Add an optional `capDrop` option to `docker()`. Each listed Linux capability is passed to `docker run` as `--cap-drop`, so a sandbox can run without capabilities such as `DAC_OVERRIDE`.
