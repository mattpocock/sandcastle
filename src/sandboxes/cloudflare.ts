/**
 * Cloudflare isolated sandbox provider — communicates with a user-deployed
 * Cloudflare Worker bridge that wraps the `@cloudflare/sandbox` SDK.
 *
 * The Cloudflare Sandbox SDK requires a Worker runtime with Durable Object
 * bindings, so it cannot be used directly from Node.js. Instead, this
 * provider talks to a thin HTTP bridge (see `docs/cloudflare-worker-bridge/`)
 * that the user deploys to their Cloudflare account.
 *
 * Usage:
 *   import { cloudflare } from "@ai-hero/sandcastle/sandboxes/cloudflare";
 *   await run({ agent: claudeCode("claude-opus-4-6"), sandbox: cloudflare({ workerUrl: "https://my-bridge.workers.dev" }) });
 */

import { execSync } from "node:child_process";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createIsolatedSandboxProvider,
  type ExecResult,
  type IsolatedSandboxHandle,
  type IsolatedSandboxProvider,
} from "../SandboxProvider.js";

/** Worktree path inside the Cloudflare sandbox container. */
const CF_REPO_PATH = "/home/user/workspace";

/** Shape of a parsed SSE event from the Worker bridge. */
interface BridgeSSEEvent {
  readonly type: "stdout" | "stderr" | "complete" | "error";
  readonly data?: string;
  readonly exitCode?: number;
  readonly error?: string;
}

/** Type guard for BridgeSSEEvent — validates the shape at runtime. */
function isBridgeSSEEvent(value: unknown): value is BridgeSSEEvent {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.type !== "string") return false;
  const validTypes = ["stdout", "stderr", "complete", "error"];
  if (!validTypes.includes(obj.type)) return false;
  if (obj.data !== undefined && typeof obj.data !== "string") return false;
  if (obj.exitCode !== undefined && typeof obj.exitCode !== "number")
    return false;
  if (obj.error !== undefined && typeof obj.error !== "string") return false;
  return true;
}

/** Options for the Cloudflare sandbox provider. */
export interface CloudflareOptions {
  /**
   * URL of the deployed Cloudflare Worker bridge.
   *
   * Falls back to the `CLOUDFLARE_SANDBOX_WORKER_URL` environment variable
   * if not provided.
   */
  readonly workerUrl?: string;

  /**
   * Shared secret token used to authenticate requests to the Worker bridge.
   *
   * Falls back to the `CLOUDFLARE_SANDBOX_API_TOKEN` environment variable
   * if not provided.
   */
  readonly apiToken?: string;

  /**
   * Identifier for the sandbox instance. Each unique ID maps to an isolated
   * container on Cloudflare's edge. Omit to auto-generate a unique ID per run.
   */
  readonly sandboxId?: string;

  /**
   * Timeout in milliseconds for non-streaming HTTP requests to the Worker bridge.
   * Defaults to 120_000 (2 minutes). Does not apply to streaming exec requests,
   * which run without a timeout so long-running commands can stream output
   * indefinitely.
   */
  readonly requestTimeoutMs?: number;

  /**
   * Environment variables injected by this provider.
   * Merged at launch time with env resolver and agent provider env.
   */
  readonly env?: Record<string, string>;
}

/**
 * Process a single SSE data payload — parse as JSON and dispatch to the
 * appropriate accumulator. Shared between the main parse loop and the
 * buffer flush so both paths handle events identically.
 */
function processSSEPayload(
  payload: string,
  stdoutLines: string[],
  stderrChunks: string[],
  onLine: ((line: string) => void) | undefined,
): { exitCode?: number } {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!isBridgeSSEEvent(parsed)) {
      // Unknown shape — treat as raw stdout
      stdoutLines.push(payload);
      onLine?.(payload);
      return {};
    }
    switch (parsed.type) {
      case "stdout": {
        const text = parsed.data ?? "";
        const sublines = text.split("\n");
        for (const sub of sublines) {
          stdoutLines.push(sub);
          onLine?.(sub);
        }
        return {};
      }
      case "stderr":
        stderrChunks.push(parsed.data ?? "");
        return {};
      case "complete":
        return { exitCode: parsed.exitCode ?? 0 };
      case "error":
        stderrChunks.push(parsed.error ?? "exec failed");
        return { exitCode: 1 };
    }
  } catch {
    // Not valid JSON — treat as raw stdout line
    stdoutLines.push(payload);
    onLine?.(payload);
    return {};
  }
}

/**
 * Parse a Server-Sent Events stream from the Worker bridge, calling `onLine`
 * for each stdout line and accumulating stderr.
 */
async function parseExecSSE(
  response: Response,
  onLine?: (line: string) => void,
): Promise<ExecResult> {
  const stdoutLines: string[] = [];
  const stderrChunks: string[] = [];
  let exitCode = 0;

  const body = response.body;
  if (!body) {
    const text = await response.text();
    return { stdout: text, stderr: "", exitCode: 1 };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const raw of lines) {
      const line = raw.trimEnd();
      if (line.startsWith("data: ")) {
        const payload = line.slice(6);
        const result = processSSEPayload(
          payload,
          stdoutLines,
          stderrChunks,
          onLine,
        );
        if (result.exitCode !== undefined) {
          exitCode = result.exitCode;
        }
      }
    }
  }

  // Flush remaining buffer — use the same parse logic as the main loop
  if (buffer.trim()) {
    const line = buffer.trim();
    if (line.startsWith("data: ")) {
      const payload = line.slice(6);
      const result = processSSEPayload(
        payload,
        stdoutLines,
        stderrChunks,
        onLine,
      );
      if (result.exitCode !== undefined) {
        exitCode = result.exitCode;
      }
    }
  }

  return {
    stdout: stdoutLines.join("\n"),
    stderr: stderrChunks.join(""),
    exitCode,
  };
}

/**
 * Create a Cloudflare isolated sandbox provider.
 *
 * Requires a deployed Cloudflare Worker bridge — see `docs/cloudflare-worker-bridge/`
 * for the reference implementation and deployment instructions.
 *
 * @example
 * ```ts
 * import { cloudflare } from "@ai-hero/sandcastle/sandboxes/cloudflare";
 *
 * const provider = cloudflare({
 *   workerUrl: "https://my-sandbox-bridge.myaccount.workers.dev",
 *   apiToken: "my-shared-secret",
 * });
 *
 * await run({
 *   agent: claudeCode("claude-opus-4-6"),
 *   sandbox: provider,
 *   prompt: "Fix the bug",
 * });
 * ```
 */
export const cloudflare = (
  options?: CloudflareOptions,
): IsolatedSandboxProvider =>
  createIsolatedSandboxProvider({
    name: "cloudflare",
    env: options?.env,
    create: async (): Promise<IsolatedSandboxHandle> => {
      const workerUrl =
        options?.workerUrl ?? process.env.CLOUDFLARE_SANDBOX_WORKER_URL;
      if (!workerUrl) {
        throw new Error(
          "Cloudflare sandbox provider requires a Worker bridge URL. " +
            "Set the `workerUrl` option or the CLOUDFLARE_SANDBOX_WORKER_URL environment variable. " +
            "See docs/cloudflare-worker-bridge/ for deployment instructions.",
        );
      }

      const apiToken =
        options?.apiToken ?? process.env.CLOUDFLARE_SANDBOX_API_TOKEN;

      const sandboxId =
        options?.sandboxId ?? `sandcastle-${crypto.randomUUID()}`;
      const timeoutMs = options?.requestTimeoutMs ?? 120_000;

      const baseUrl = workerUrl.replace(/\/$/, "");

      /** Build headers for every request to the Worker bridge. */
      const buildHeaders = (): Record<string, string> => {
        const h: Record<string, string> = {
          "x-sandbox-id": sandboxId,
        };
        if (apiToken) {
          h["authorization"] = `Bearer ${apiToken}`;
        }
        return h;
      };

      /**
       * Make an HTTP request to the Worker bridge.
       *
       * Non-streaming requests get an AbortController timeout.
       * Streaming requests (streaming=true) run without a timeout so
       * long-running commands can produce output indefinitely.
       */
      const request = async (
        path: string,
        init?: RequestInit & { streaming?: boolean },
      ): Promise<Response> => {
        const url = `${baseUrl}${path}`;
        const isStreaming = init?.streaming === true;

        // Only apply timeout for non-streaming requests
        const controller = isStreaming ? undefined : new AbortController();
        const timer = controller
          ? setTimeout(() => controller.abort(), timeoutMs)
          : undefined;

        try {
          const { streaming: _, ...fetchInit } = init ?? {};
          const response = await fetch(url, {
            ...fetchInit,
            headers: {
              ...buildHeaders(),
              ...((fetchInit.headers as Record<string, string> | undefined) ??
                {}),
            },
            signal: controller?.signal,
          });
          if (!response.ok && !isStreaming) {
            const body = await response.text().catch(() => "");
            throw new Error(
              `Cloudflare Worker bridge returned ${response.status} for ${path}: ${body}`,
            );
          }
          return response;
        } finally {
          if (timer) clearTimeout(timer);
        }
      };

      // Initialize the sandbox — create workspace directory
      await request("/mkdir", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: CF_REPO_PATH, recursive: true }),
      });

      const handle: IsolatedSandboxHandle = {
        worktreePath: CF_REPO_PATH,

        exec: async (
          command: string,
          opts?: {
            onLine?: (line: string) => void;
            cwd?: string;
            sudo?: boolean;
            stdin?: string;
          },
        ): Promise<ExecResult> => {
          const effectiveCommand = opts?.sudo ? `sudo ${command}` : command;

          const isStreaming = !!opts?.onLine;

          const response = await request("/exec", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              command: effectiveCommand,
              cwd: opts?.cwd ?? CF_REPO_PATH,
              stream: isStreaming,
              stdin: opts?.stdin,
            }),
            streaming: isStreaming,
          });

          // Streaming response — parse SSE
          if (isStreaming) {
            return parseExecSSE(response, opts?.onLine);
          }

          // Non-streaming — error already thrown by request() for non-2xx
          const result = (await response.json()) as {
            stdout?: string;
            stderr?: string;
            exitCode?: number;
          };
          return {
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
            exitCode: result.exitCode ?? 0,
          };
        },

        copyIn: async (
          hostPath: string,
          sandboxPath: string,
        ): Promise<void> => {
          const info = await stat(hostPath);

          if (info.isDirectory()) {
            // Tar the directory and upload
            const tarPath = join(
              tmpdir(),
              `sandcastle-cf-copyin-${Date.now()}.tar.gz`,
            );
            execSync(`tar -czf "${tarPath}" -C "${hostPath}" .`);
            try {
              const tarContent = await readFile(tarPath);

              // Ensure target directory exists
              await request("/mkdir", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ path: sandboxPath, recursive: true }),
              });

              // Upload tar and extract
              await request("/upload-tar", {
                method: "POST",
                headers: {
                  "content-type": "application/octet-stream",
                  "x-sandbox-path": sandboxPath,
                },
                body: tarContent,
              });
            } finally {
              await unlink(tarPath).catch(() => {});
            }
          } else {
            // Single file upload — base64-encode to avoid binary corruption
            const content = await readFile(hostPath);
            await request("/upload", {
              method: "POST",
              headers: {
                "content-type": "application/octet-stream",
                "x-sandbox-path": sandboxPath,
                "x-sandbox-encoding": "base64",
              },
              body: content.toString("base64"),
            });
          }
        },

        copyFileOut: async (
          sandboxPath: string,
          hostPath: string,
        ): Promise<void> => {
          const response = await request(
            `/download?path=${encodeURIComponent(sandboxPath)}`,
          );
          const buffer = Buffer.from(await response.arrayBuffer());
          await mkdir(dirname(hostPath), { recursive: true });
          await writeFile(hostPath, buffer);
        },

        close: async (): Promise<void> => {
          // Best-effort destroy — tolerate network errors (sandbox may already
          // be gone) but let auth/server errors propagate so the user knows
          // their bridge is misconfigured.
          try {
            await request("/destroy", { method: "POST" });
          } catch (error) {
            // Swallow network-level failures (sandbox already destroyed,
            // bridge unreachable) but re-throw everything else.
            if (
              error instanceof TypeError ||
              (error instanceof DOMException && error.name === "AbortError")
            ) {
              return;
            }
            throw error;
          }
        },
      };

      return handle;
    },
  });
