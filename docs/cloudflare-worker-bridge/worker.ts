/**
 * Sandcastle ↔ Cloudflare Sandbox bridge Worker.
 *
 * Deploy this Worker to your Cloudflare account so that sandcastle's
 * `cloudflare()` provider can create and manage sandboxes remotely.
 *
 * Setup:
 *   1. npm install @cloudflare/sandbox
 *   2. Copy this file and wrangler.jsonc into a new directory
 *   3. Set the BRIDGE_API_TOKEN secret: npx wrangler secret put BRIDGE_API_TOKEN
 *   4. npx wrangler deploy
 *
 * See README.md in this directory for full instructions.
 */

import { getSandbox, parseSSEStream } from "@cloudflare/sandbox";

// Re-export the Sandbox Durable Object so Wrangler can bind it
export { Sandbox } from "@cloudflare/sandbox";

interface Env {
  Sandbox: DurableObjectNamespace;
  BRIDGE_API_TOKEN: string;
}

/**
 * The workspace root inside the sandbox container. All file operations are
 * restricted to paths under this prefix to prevent path traversal.
 */
const WORKSPACE_ROOT = "/home/user/workspace";

/**
 * Validate that a path is within the allowed workspace root or /tmp.
 * Returns the normalized path, or null if the path is outside the allowed roots.
 */
function validatePath(path: string): string | null {
  // Resolve path to remove .. traversals
  // In Workers we don't have node:path, so do a basic normalization
  const segments: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "..") {
      segments.pop();
    } else if (seg !== "." && seg !== "") {
      segments.push(seg);
    }
  }
  const normalized = "/" + segments.join("/");

  if (normalized.startsWith(WORKSPACE_ROOT) || normalized.startsWith("/tmp/")) {
    return normalized;
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // ── Auth ──────────────────────────────────────────────────────────
    // BRIDGE_API_TOKEN is required. If not configured, reject all requests
    // to prevent an open bridge.
    if (!env.BRIDGE_API_TOKEN) {
      return new Response(
        "Bridge misconfigured: BRIDGE_API_TOKEN secret is not set. " +
          "Run `npx wrangler secret put BRIDGE_API_TOKEN` to configure it.",
        { status: 503 },
      );
    }

    const authHeader = request.headers.get("authorization");
    if (authHeader !== `Bearer ${env.BRIDGE_API_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    // ── Sandbox ID ───────────────────────────────────────────────────
    const sandboxId = request.headers.get("x-sandbox-id");
    if (!sandboxId) {
      return new Response("Missing x-sandbox-id header", { status: 400 });
    }

    const sandbox = getSandbox(env.Sandbox, sandboxId);
    const url = new URL(request.url);

    try {
      switch (url.pathname) {
        // ── Execute command ────────────────────────────────────────────
        case "/exec": {
          const body = (await request.json()) as {
            command: string;
            cwd?: string;
            stream?: boolean;
            stdin?: string;
          };

          if (body.stream) {
            // Return an SSE stream
            const sseStream = await sandbox.execStream(body.command, {
              cwd: body.cwd,
              stdin: body.stdin,
            });

            // Proxy the SSE stream from the sandbox SDK
            const { readable, writable } = new TransformStream();
            const writer = writable.getWriter();
            const encoder = new TextEncoder();

            (async () => {
              try {
                for await (const event of parseSSEStream(sseStream)) {
                  const data = JSON.stringify(event);
                  await writer.write(encoder.encode(`data: ${data}\n\n`));
                }
              } catch (err) {
                const errorData = JSON.stringify({
                  type: "error",
                  error: err instanceof Error ? err.message : String(err),
                });
                await writer.write(encoder.encode(`data: ${errorData}\n\n`));
              } finally {
                await writer.close();
              }
            })();

            return new Response(readable, {
              headers: {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
              },
            });
          }

          // Non-streaming exec
          const result = await sandbox.exec(body.command, {
            cwd: body.cwd,
            stdin: body.stdin,
          });

          return Response.json({
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
          });
        }

        // ── Create directory ──────────────────────────────────────────
        case "/mkdir": {
          const body = (await request.json()) as {
            path: string;
            recursive?: boolean;
          };
          const safePath = validatePath(body.path);
          if (!safePath) {
            return new Response(
              `Path must be under ${WORKSPACE_ROOT} or /tmp/`,
              { status: 400 },
            );
          }
          await sandbox.mkdir(safePath, { recursive: body.recursive });
          return Response.json({ ok: true });
        }

        // ── Upload single file (base64-encoded) ──────────────────────
        case "/upload": {
          const path = request.headers.get("x-sandbox-path");
          if (!path) {
            return new Response("Missing x-sandbox-path header", {
              status: 400,
            });
          }
          const safePath = validatePath(path);
          if (!safePath) {
            return new Response(
              `Path must be under ${WORKSPACE_ROOT} or /tmp/`,
              { status: 400 },
            );
          }
          const encoding = request.headers.get("x-sandbox-encoding");
          if (encoding === "base64") {
            // Base64-encoded binary content — decode before writing
            const base64Content = await request.text();
            await sandbox.writeFile(safePath, base64Content, {
              encoding: "base64",
            });
          } else {
            // Plain text content
            const content = await request.text();
            await sandbox.writeFile(safePath, content);
          }
          return Response.json({ ok: true });
        }

        // ── Upload tar archive and extract ────────────────────────────
        case "/upload-tar": {
          const targetPath = request.headers.get("x-sandbox-path");
          if (!targetPath) {
            return new Response("Missing x-sandbox-path header", {
              status: 400,
            });
          }
          const safePath = validatePath(targetPath);
          if (!safePath) {
            return new Response(
              `Path must be under ${WORKSPACE_ROOT} or /tmp/`,
              { status: 400 },
            );
          }
          const tarBytes = new Uint8Array(await request.arrayBuffer());
          const tmpTar = `/tmp/sandcastle-upload-${Date.now()}.tar.gz`;

          // Write tar to sandbox filesystem, then extract
          const base64Tar = btoa(String.fromCharCode(...tarBytes));
          await sandbox.writeFile(tmpTar, base64Tar, {
            encoding: "base64",
          });
          await sandbox.exec(
            `mkdir -p "${safePath}" && tar -xzf "${tmpTar}" -C "${safePath}" && rm -f "${tmpTar}"`,
          );
          return Response.json({ ok: true });
        }

        // ── Download file ─────────────────────────────────────────────
        case "/download": {
          const path = url.searchParams.get("path");
          if (!path) {
            return new Response("Missing path query parameter", {
              status: 400,
            });
          }
          const safePath = validatePath(path);
          if (!safePath) {
            return new Response(
              `Path must be under ${WORKSPACE_ROOT} or /tmp/`,
              { status: 400 },
            );
          }
          const file = await sandbox.readFile(safePath);
          return new Response(file.content, {
            headers: { "content-type": "application/octet-stream" },
          });
        }

        // ── Destroy sandbox ───────────────────────────────────────────
        case "/destroy": {
          await sandbox.destroy();
          return Response.json({ ok: true });
        }

        default:
          return new Response("Not found", { status: 404 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 500 });
    }
  },
};
