#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
lock_hash="$(sha256sum package-lock.json | cut -d ' ' -f 1)"
stamp="node_modules/.sandcastle-lock-hash"
if ! test -x node_modules/.bin/vitest || ! test -f "$stamp" || test "$(<"$stamp")" != "$lock_hash"; then
  npm ci
  printf '%s\n' "$lock_hash" > "$stamp"
fi
