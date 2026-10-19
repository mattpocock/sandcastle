#!/usr/bin/env bash
set -euo pipefail

package_name="${1:-root}"
if test "$package_name" != "root"; then
  echo "Unknown package: $package_name" >&2
  exit 1
fi
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
npm run typecheck
npm test
npm run build
node --test scripts/agent-map.browser.test.mjs
