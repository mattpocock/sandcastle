---
"@ai-hero/sandcastle": patch
---

`sandcastle init --issue-tracker beads` now installs bd 1.3.4 in the scaffolded Dockerfile or Containerfile, up from 1.3.2, so the image matches a current host `bd`. This is a binary swap with no new database migrations. The beads image also no longer installs `dpkg-dev` and `libicu72` or symlinks ICU 74 libraries: bd is statically linked and needs neither.
