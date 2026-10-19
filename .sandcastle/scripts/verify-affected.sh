#!/usr/bin/env bash
set -euo pipefail

base_sha="${1:?usage: verify-affected.sh <batch-base-sha>}"
git cat-file -e "${base_sha}^{commit}"
changed_files="$(git diff --name-only "$base_sha"...HEAD)"
if test -z "$changed_files"; then
  echo "No changed files since $base_sha."
  exit 0
fi
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$script_dir/verify-package.sh" root
git diff --check
