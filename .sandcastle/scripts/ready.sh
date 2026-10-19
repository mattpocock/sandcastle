#!/usr/bin/env bash
set -euo pipefail
codex login status
test -r /home/agent/CODING_STANDARDS.md
test -r /home/agent/FEEDBACK_LOOPS.md
test -r /home/agent/EVIDENCE_POLICY.md
bash .sandcastle/scripts/bootstrap.sh
# The package imports its own exported SDK through dist inside issue worktrees.
npm run build
if test -f .codegraph/codegraph.db; then
  codegraph sync --quiet .
else
  codegraph init .
fi
