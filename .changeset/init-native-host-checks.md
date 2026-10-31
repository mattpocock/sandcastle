---
"@ai-hero/sandcastle": minor
---

`sandcastle init` with `--sandbox bwrap` or `--sandbox seatbelt` now checks the host: it warns, with the exact install command, when the sandbox tool or the chosen agent's CLI is missing, and still writes the files. With the beads issue tracker it scaffolds an identity mount of `.beads/` (at its host path, with `BEADS_DIR` set to match) and skips the bd version warning, since the host's own `bd` is used. With GitHub Issues, the next steps say to put `GH_TOKEN` in `.sandcastle/.env`.
