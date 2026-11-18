---
"@ai-hero/sandcastle": minor
---

v1: `seatbelt()`, a Seatbelt provider for macOS at `@ai-hero/sandcastle/v1/sandboxes/seatbelt`, a drop-in for the remote providers on the same keeper and state folder as `bwrap()`. Nothing of the caller's is mounted or readable (not its checkout, home or temp folders, not even their metadata): each sandbox starts with an empty working directory, `<stateDirectory>/home/workspace`, to clone into, and sees only the host's system folders and the folders that hold its `node`, `git`, `gh` and agent CLIs, read-only. `seatbelt({ create: { network?, toolchainPaths? } })` (`SeatbeltCreateOptions`) shares the host network by default, or allows no IP traffic with `network: "none"`. Unix sockets reach only the sandbox's own and the DNS resolver's. There's no root: `sudo: true` rejects. The keeper now kills by process group only, walking the process tree so a command's detached children go too. See `docs/v1/seatbelt.md`.
