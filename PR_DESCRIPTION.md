## Add Devin agent provider

Adds support for the [Devin CLI](https://cli.devin.ai) as a new agent provider, following the same pattern as the existing `cursor` and `copilot` providers.

### What's changed

**`src/AgentProvider.ts`**

- New `devin(model, options?)` factory and `DevinOptions` interface
- `buildPrintCommand`: writes `credentials.toml` from `$DEVIN_SESSION_TOKEN` before each invocation (the Devin CLI authenticates via an OAuth session token, not an API key), then runs `devin -p <prompt> --model <model> --permission-mode dangerous`
- `parseStreamLine`: plain-text passthrough — Devin's `-p` mode streams plain text to stdout, no structured JSON
- `captureSessions: false`, no `sessionStorage` — resume is not supported (the `-p` stdout stream does not emit a session ID)

**`src/InitService.ts`**

- New `DEVIN_DOCKERFILE` — based on `node:22-bookworm`, installs the Devin CLI binary directly from the release tarball via the manifest JSON rather than the install script (the install script ends with an interactive `devin setup` wizard that would hang a Docker `RUN` layer)
- New `AGENT_REGISTRY` entry: `name: "devin"`, `defaultModel: "adaptive"`

**`src/index.ts`**

- Exports `devin` and `DevinOptions`

**`src/AgentProvider.test.ts`**

- 17 new tests covering `buildPrintCommand`, `parseStreamLine`, `buildInteractiveArgs`, `captureSessions`, `env`, and `sessionStorage`

---

### Why the install script is bypassed

The official install script (`curl -fsSL https://cli.devin.ai/install.sh | bash`) ends with `devin setup`, an interactive onboarding wizard that blocks a Docker build. Instead, the Dockerfile fetches the versioned tarball URL from the manifest JSON and extracts the binary directly:

```dockerfile
RUN MANIFEST=$(curl -fsSL https://static.devin.ai/cli/current/manifest.json) && \
    BUNDLE_URL=$(echo "$MANIFEST" | jq -r '.platforms["x86_64-unknown-linux"].url') && \
    curl -fsSL "$BUNDLE_URL" | tar xz -C /usr/local && \
    chmod +x /usr/local/bin/devin
```

---

### Why `DEVIN_SESSION_TOKEN` instead of an API key

The Devin CLI authenticates via an OAuth session token stored in `~/.local/share/devin/credentials.toml`, not a static API key. `buildPrintCommand` writes this file from `$DEVIN_SESSION_TOKEN` at runtime using `printf` so the token value (which contains `$` characters) is passed through the environment rather than shell-interpolated.

---

### Usage

```ts
import { run, devin } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

await run({
  agent: devin("adaptive"), // or "swe-1-6-fast", "claude-sonnet-4", etc.
  sandbox: docker(),
  promptFile: ".sandcastle/prompt.md",
});
```

**`.sandcastle/.env`**

```bash
# windsurf_api_key value from ~/.local/share/devin/credentials.toml on the host
# Use single quotes to preserve the $ characters in the token value
DEVIN_SESSION_TOKEN='devin-session-token$eyJ...'
```

---

### Known limitations

- **No resume support** — the `-p` stdout stream does not emit a session ID, so interrupted runs start fresh rather than continuing where they left off. This matches the `cursor` and `copilot` providers.
- **Session token expiry** — `DEVIN_SESSION_TOKEN` is an OAuth JWT that expires when you log out or the session times out. Re-run `devin auth login` on the host and update `.sandcastle/.env` to refresh it.
- **x86_64 Linux only** — the Dockerfile targets `x86_64-unknown-linux`. ARM (`aarch64`) support can be added by making the platform detection dynamic in the `RUN` layer.
