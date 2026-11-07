---
"@ai-hero/sandcastle": patch
---

A streamed `exec` ends an agent stdout line only at `\n` (with an optional `\r` before it), as JSONL requires. Before, Node's `readline` also ended a line at U+2028 and U+2029, which JSON allows unescaped inside a string, so an agent frame whose text held one of them was cut in two and could not be parsed. This affected `noSandbox()`, `bwrap()`, `seatbelt()`, `docker()` and `podman()`, with every agent provider.
