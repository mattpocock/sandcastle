import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { claudeCode, createSandbox, Output } from "@ai-hero/sandcastle/v1";
import { fakeAgent } from "@ai-hero/sandcastle/v1/testing";
import { hostProcessProvider } from "./helpers/hostProcessProvider.js";

// v1 sessions on the machine the tests run on, through a test-only provider
// whose commands run with Sandcastle's own host command runner. It's here
// for Windows: there, nothing in the sandbox has an `sh` (the provider leaves
// every directory holding one off PATH), so the session supervisor's start,
// its control channel (a named pipe), its agents and their kill must all run
// without one. The same tests run on Linux and macOS, through `sh -c`.

const isWindows = process.platform === "win32";

const ANSWER = Output.object({
  tag: "answer",
  schema: z.object({ answer: z.number() }),
});

const init = (sessionId: string): string =>
  JSON.stringify({ type: "system", subtype: "init", session_id: sessionId });

const result = (text: string): string =>
  JSON.stringify({ type: "result", is_error: false, result: text });

/**
 * A stand-in for the Claude Code CLI: for each stream-json message on its
 * stdin it says it read it, then answers with the message and its argv in
 * the result, and exits once stdin closes. Installed the way npm installs
 * `claude`: a `.cmd` shim on Windows, a bin script elsewhere.
 */
const STUB_CLAUDE = `
const readline = require("node:readline");
const say = (line) => process.stdout.write(JSON.stringify(line) + "\\n");
say({ type: "system", subtype: "init", session_id: "s-stub" });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.message.content === "Hang.") {
    // A child of its own that outlives nothing: the kill must take it too.
    require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    return;
  }
  say({ ...message, isReplay: true });
  const heard = JSON.stringify({ prompt: message.message.content, argv: process.argv.slice(2) });
  say({ type: "result", is_error: false, result: "<answer>{\\"answer\\": 7}</answer><heard>" + heard + "</heard>" });
});
`;

/** A directory holding the stub as `claude`, the way npm would install it. */
const installStubClaude = async (dir: string): Promise<void> => {
  await writeFile(path.join(dir, "claude.js"), STUB_CLAUDE);
  if (isWindows) {
    await writeFile(
      path.join(dir, "claude.cmd"),
      ["@ECHO off", "SETLOCAL", String.raw`node "%~dp0\claude.js" %*`, ""].join(
        "\r\n",
      ),
    );
    return;
  }
  await writeFile(
    path.join(dir, "claude"),
    `#!/usr/bin/env node\n${STUB_CLAUDE}`,
    { mode: 0o755 },
  );
};

const HEARD = z.object({ prompt: z.string(), argv: z.array(z.string()) });

/** What the stub says it was given, from its final message. */
const heardIn = (finalMessage: string | undefined) =>
  HEARD.parse(
    JSON.parse(
      /<heard>(?<json>.*)<\/heard>/su.exec(finalMessage ?? "")?.groups?.[
        "json"
      ] ?? "null",
    ),
  );

describe("v1 sessions on this host, with no sh on Windows", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "w-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it.runIf(isWindows)(
    "has no sh: nothing in the sandbox can find one",
    async () => {
      const sandbox = await createSandbox({
        provider: hostProcessProvider({ rootDir }),
      });

      const where = await sandbox.exec({
        command: "where sh",
        allowFailure: true,
      });
      await sandbox.close();

      expect(where.exitCode).not.toBe(0);
    },
  );

  it("starts the supervisor, runs a session with structured output, continues it, and closes, leaving nothing behind", async () => {
    const sandbox = await createSandbox({
      provider: hostProcessProvider({ rootDir }),
    });
    const first = await sandbox.session({
      agent: fakeAgent({
        lines: [init("s-win"), result('<answer>{"answer": 42}</answer>')],
      }),
      prompt: "Put the answer in <answer> tags.",
      output: ANSWER,
    });
    const second = await sandbox.session({
      agent: fakeAgent({ lines: [init("s-win"), result("Carried on.")] }),
      prompt: "And then?",
      continueSession: first,
    });
    await sandbox.close();

    expect(first).toMatchObject({
      sessionId: "s-win",
      exitReason: "completed",
      output: { answer: 42 },
    });
    expect(second).toMatchObject({
      sessionId: "s-win",
      finalMessage: "Carried on.",
    });
    // A folder can't be removed on Windows while a process still runs in it.
    await expect(readdir(rootDir)).resolves.toStrictEqual([]);
  });

  it("runs a real agent CLI installed as npm installs it (a .cmd shim on Windows), its prompt on stdin and its argv intact", async () => {
    const bin = await mkdtemp(path.join(tmpdir(), "b-"));
    await installStubClaude(bin);
    const sandbox = await createSandbox({
      provider: hostProcessProvider({ rootDir, extraPath: [bin] }),
    });
    // cmd.exe's own syntax in the model, and a prompt it could never carry.
    const model = 'm&x|y^z %PATH% "q"';
    const prompt = `Answer in <answer> tags, 100% sure.\nLine "two" & ${"long ".repeat(2000)}`;

    const done = await sandbox.session({
      agent: claudeCode(model),
      prompt,
      output: ANSWER,
    });
    await sandbox.close();
    await rm(bin, { recursive: true, force: true });

    expect(done.output).toStrictEqual({ answer: 7 });
    const heard = heardIn(done.finalMessage);
    expect(heard.prompt).toBe(prompt);
    expect(heard.argv).toContain(model);
    await expect(readdir(rootDir)).resolves.toStrictEqual([]);
  });

  it("runs sessions in two sandboxes at once, each with its own supervisor", async () => {
    const provider = hostProcessProvider({ rootDir });
    const sandboxes = await Promise.all([
      createSandbox({ provider }),
      createSandbox({ provider }),
    ]);

    const done = await Promise.all(
      sandboxes.map(async (sandbox, index) =>
        sandbox.session({
          agent: fakeAgent({
            lines: [init(`s-${index}`), result(`Sandbox ${index}.`)],
          }),
          prompt: "Which sandbox?",
        }),
      ),
    );
    await Promise.all(sandboxes.map(async (sandbox) => sandbox.close()));

    expect(done.map((session) => session.finalMessage)).toStrictEqual([
      "Sandbox 0.",
      "Sandbox 1.",
    ]);
  });

  it("an abort kills the agent's whole tree: its .cmd shim, the CLI and the CLI's own child", async () => {
    const bin = await mkdtemp(path.join(tmpdir(), "b-"));
    await installStubClaude(bin);
    const sandbox = await createSandbox({
      provider: hostProcessProvider({ rootDir, extraPath: [bin] }),
    });
    const controller = new AbortController();

    const spawned = await sandbox.spawnSession({
      agent: claudeCode("m"),
      prompt: "Hang.",
      abortSignal: controller.signal,
    });
    controller.abort();
    await expect(spawned.wait()).rejects.toMatchObject({
      exitReason: "aborted",
    });

    // Windows won't remove a directory a live process runs in: the agent's
    // tree is gone once the sandbox's working directory can go, before close.
    await rm(sandbox.workingDirectory, {
      recursive: true,
      maxRetries: 20,
      retryDelay: 100,
    });
    await sandbox.close();
    await rm(bin, { recursive: true, force: true });
    await expect(readdir(rootDir)).resolves.toStrictEqual([]);
  });
});
