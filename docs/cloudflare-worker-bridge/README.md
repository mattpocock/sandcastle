# Cloudflare Sandbox Worker Bridge

A thin Cloudflare Worker that wraps the [`@cloudflare/sandbox`](https://developers.cloudflare.com/sandbox/) SDK as a REST API, enabling sandcastle's `cloudflare()` provider to create and manage sandboxes remotely.

## Why a bridge?

The Cloudflare Sandbox SDK requires a Worker runtime with Durable Object bindings — it cannot be used directly from Node.js. This bridge Worker runs on Cloudflare's edge and exposes the sandbox operations as HTTP endpoints that sandcastle calls from your local machine.

## Setup

### 1. Create a new directory and install dependencies

```bash
mkdir sandcastle-bridge && cd sandcastle-bridge
npm init -y
npm install @cloudflare/sandbox wrangler
```

### 2. Copy the bridge files

Copy `worker.ts` and `wrangler.jsonc` from this directory into your project.

### 3. Set the shared secret

```bash
npx wrangler secret put BRIDGE_API_TOKEN
# Enter a strong random token — you'll pass this to sandcastle as apiToken
```

### 4. Deploy

```bash
npx wrangler deploy
```

Note the deployed URL (e.g. `https://sandcastle-sandbox-bridge.<your-subdomain>.workers.dev`).

### 5. Use with sandcastle

```typescript
import { run, claudeCode } from "@ai-hero/sandcastle";
import { cloudflare } from "@ai-hero/sandcastle/sandboxes/cloudflare";

await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: cloudflare({
    workerUrl: "https://sandcastle-sandbox-bridge.<your-subdomain>.workers.dev",
    apiToken: "your-shared-secret",
  }),
  prompt: "Fix the bug",
});
```

Or use environment variables:

```bash
export CLOUDFLARE_SANDBOX_WORKER_URL="https://sandcastle-sandbox-bridge.<your-subdomain>.workers.dev"
export CLOUDFLARE_SANDBOX_API_TOKEN="your-shared-secret"
```

```typescript
import { cloudflare } from "@ai-hero/sandcastle/sandboxes/cloudflare";

// Reads URL and token from environment variables
await run({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: cloudflare(),
  prompt: "Fix the bug",
});
```

## API endpoints

The bridge exposes these endpoints (all require `Authorization: Bearer <token>` and `x-sandbox-id` headers):

| Method | Path          | Description                                 |
| ------ | ------------- | ------------------------------------------- |
| POST   | `/exec`       | Execute a command (JSON body, optional SSE) |
| POST   | `/mkdir`      | Create a directory                          |
| POST   | `/upload`     | Upload a single file (binary body)          |
| POST   | `/upload-tar` | Upload and extract a tar.gz archive         |
| GET    | `/download`   | Download a file (`?path=...`)               |
| POST   | `/destroy`    | Destroy the sandbox and free resources      |

## Requirements

- Cloudflare Workers Paid plan (Containers requires paid)
- `@cloudflare/sandbox` npm package
- `wrangler` CLI for deployment

## Customization

Edit `wrangler.jsonc` to change:

- **`instance_type`**: `"lite"`, `"standard"`, or `"advanced"` for different vCPU/memory allocations
- **`max_instances`**: Maximum concurrent sandbox containers
- **`image`**: Custom Docker image (extend `docker.io/cloudflare/sandbox:0.9.2`)

See the [Cloudflare Sandbox configuration docs](https://developers.cloudflare.com/sandbox/configuration/) for all options.
