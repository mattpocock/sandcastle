// A harmless fake `opencode` for the native-sandbox run tests. Like the real
// CLI, `opencode run` keeps the session in its own store under `$HOME`
// (OpenCode's SQLite database lives in `~/.local/share/opencode`) and prints
// the run as `--format json` events; `opencode export <id>` prints that
// session's JSON to stdout, so Sandcastle captures it by redirecting the
// export to a file inside the sandbox. It commits the prompt, then reports
// done.

export const FAKE_OPENCODE_SESSION_ID = "ses_fake_native";

export const FAKE_OPENCODE = `#!/bin/sh
store="$HOME/.local/share/opencode/sessions"
case "$1" in
  run)
    for prompt; do :; done
    mkdir -p "$store"
    printf '%s\\n' '{"info":{"id":"${FAKE_OPENCODE_SESSION_ID}","title":"fake-opencode-marker"},"messages":[]}' > "$store/${FAKE_OPENCODE_SESSION_ID}.json"
    printf '%s\\n' "$prompt" > agent.txt
    git add agent.txt
    git commit -qm "agent commit"
    printf '%s\\n' '{"type":"step_start","sessionID":"${FAKE_OPENCODE_SESSION_ID}","part":{"type":"step-start"}}'
    printf '%s\\n' '{"type":"text","sessionID":"${FAKE_OPENCODE_SESSION_ID}","part":{"type":"text","text":"Done. <promise>COMPLETE</promise>"}}'
    ;;
  export)
    if [ ! -f "$store/$2.json" ]; then
      echo "Session not found: $2" >&2
      exit 1
    fi
    cat "$store/$2.json"
    ;;
  *)
    echo "fake opencode: unsupported command $1" >&2
    exit 1
    ;;
esac
`;
