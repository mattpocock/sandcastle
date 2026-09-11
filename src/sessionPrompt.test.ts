import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "vitest";
import { claudeCode } from "./AgentProvider.js";
import { createSandbox, type Sandbox } from "./createSandbox.js";
import { createBindMountSandboxProvider } from "./SandboxProvider.js";
import { claudeHostSessionPath } from "./SessionStore.js";
import { run } from "./run.js";

const execFileAsync = promisify(execFile);

for (const entryPoint of ["run", "sandbox.run"] as const) {
  describe(`${entryPoint} session prompts`, () => {
    for (const method of ["resume", "fork"] as const) {
      for (const source of ["template", "inline"] as const) {
        it(`${method} accepts an inline prompt after ${source} input`, async () => {
          await checkSessionPrompt(entryPoint, method, source, false);
        });
      }

      it(`${method} still rejects explicitly supplied inline prompt arguments`, async () => {
        await checkSessionPrompt(entryPoint, method, "template", true);
      });
    }
  });
}

async function checkSessionPrompt(
  entryPoint: "run" | "sandbox.run",
  method: "resume" | "fork",
  source: "template" | "inline",
  explicitArgs: boolean,
) {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-session-prompt-"));
  const cwd = join(root, "repo");
  let warmSandbox: Sandbox | undefined;
  try {
    await mkdir(cwd);
    await execFileAsync("git", ["init", "-b", "main"], { cwd });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "initial commit",
      ],
      { cwd },
    );
    const promptFile = join(root, "prompt.md");
    await writeFile(promptFile, "Work on {{COMPONENT}}");
    const hostProjectsDir = join(root, "sessions");
    const sessionId = "session-prompt-parent";
    const sessionPath = claudeHostSessionPath(cwd, sessionId, hostProjectsDir);
    await mkdir(dirname(sessionPath), { recursive: true });
    await writeFile(
      sessionPath,
      JSON.stringify({ type: "system", cwd }) + "\n",
    );

    const calls: { command: string; prompt: string | undefined }[] = [];
    let creates = 0;
    const sandbox = createBindMountSandboxProvider({
      name: "session-prompt-test",
      create: async ({ worktreePath }) => {
        creates++;
        return {
          worktreePath,
          exec: async (command, options) => {
            if (command.startsWith("claude ") && options?.onLine) {
              calls.push({ command, prompt: options.stdin });
              options.onLine(
                JSON.stringify({
                  type: "system",
                  subtype: "init",
                  session_id: sessionId,
                }),
              );
              options.onLine(JSON.stringify({ type: "result", result: "ok" }));
            }
            return { stdout: "", stderr: "", exitCode: 0 };
          },
          copyFileIn: async () => {},
          copyFileOut: async () => {},
          close: async () => {},
        };
      },
    });
    const options = {
      agent: claudeCode("test-model", {
        captureSessions: false,
        sessionStorage: {
          hostProjectsDir,
          sandboxProjectsDir: join(root, "sandbox-sessions"),
        },
      }),
      ...(source === "template"
        ? { promptFile, promptArgs: { COMPONENT: "LoginForm" } }
        : { prompt: "Work on LoginForm" }),
      maxIterations: 1,
      logging: { type: "file" as const, path: join(root, "run.log") },
    };
    const first =
      entryPoint === "run"
        ? await run({
            ...options,
            sandbox,
            cwd,
            branchStrategy: { type: "head" },
          })
        : await (warmSandbox = await createSandbox({
            sandbox,
            cwd,
            branch: "session-prompt",
          })).run(options);
    assert.equal(calls[0]?.prompt, "Work on LoginForm");
    assert.equal(first.iterations[0]?.sessionId, sessionId);
    const continueSession = first[method];
    assert.ok(continueSession);
    const nextPrompt = "Keep {{COMPONENT}} and !`echo literal` unchanged";

    if (explicitArgs) {
      await assert.rejects(
        continueSession(nextPrompt, { promptArgs: { COMPONENT: "Other" } }),
        /promptArgs is only supported with promptFile/,
      );
      assert.equal(calls.length, 1);
    } else {
      const second = await continueSession(nextPrompt);
      assert.equal(calls.length, 2);
      assert.equal(calls[1]?.prompt, nextPrompt);
      assert.ok(calls[1]?.command.includes(`--resume '${sessionId}'`));
      assert.equal(
        calls[1]?.command.includes("--fork-session"),
        method === "fork",
      );
      assert.equal(second.iterations.length, 1);
      assert.equal(creates, entryPoint === "run" ? 2 : 1);
    }
  } finally {
    await warmSandbox?.close();
    await rm(root, { recursive: true, force: true });
  }
}
