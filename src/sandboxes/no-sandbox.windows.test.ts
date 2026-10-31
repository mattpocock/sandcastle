/**
 * noSandbox on real Windows (issue #940).
 *
 * Every test here runs only on win32, through the real cmd.exe and the real
 * Windows argv rules. The "agents" are harmless fakes: an argv printer
 * (`argv.js`) behind npm-style `.cmd` shims named like the agent CLIs, so the
 * command each provider builds runs exactly as it would for a user, and the
 * printer reports the argv it received. No real agent CLI ever runs.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claudeCode,
  codex,
  copilot,
  cursor,
  opencode,
  pi,
  shellEscape,
} from "../AgentProvider.js";
import type { AgentProvider } from "../AgentProvider.js";
import { noSandbox } from "./no-sandbox.js";

const isWindows = process.platform === "win32";

/** Prints what it was given: argv, stdin (when asked) and one env var. */
const ARGV_PRINTER = `
const fs = require("node:fs");
let stdin = null;
if (process.env.SANDCASTLE_READ_STDIN === "1") {
  stdin = fs.readFileSync(0, "utf8");
}
const out = JSON.stringify({
  argv: process.argv.slice(2),
  stdin,
  probe: process.env.SANDCASTLE_PROBE ?? null,
});
if (process.env.SANDCASTLE_ARGV_OUT) {
  fs.writeFileSync(process.env.SANDCASTLE_ARGV_OUT, out);
} else {
  process.stdout.write(out);
}
`;

/** The shim npm's cmd-shim writes for a JS bin, pointed at the printer. */
const NPM_CMD_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\argv.js" %*',
  "",
].join("\r\n");

const AGENT_BINS = ["claude", "codex", "pi", "agent", "opencode", "copilot"];

/** Arguments that cmd.exe or Windows argv parsing would mangle if mis-quoted. */
const NASTY_ARGS = [
  "plain",
  "has spaces in it",
  "",
  "single ' quote",
  'double " quote',
  "mixed 'single' and \"double\"",
  "100% sure, %PATH% and %%",
  "caret ^ and ^^",
  "amp & and &&",
  "pipe | and ||",
  "redirects < > >> 2>&1",
  "parens ( ) and !bang!",
  "trailing backslash\\",
  'backslash before quote \\" here',
  "C:\\Program Files\\thing\\",
  "claude-fable-5[1m]",
  "$HOME `whoami` $(id)",
  "unicode: café — 日本語",
];

const LONG_PROMPT = Array.from(
  { length: 400 },
  (_, i) => `Line ${i}: do the thing & report 100% | done.`,
).join(" ");

let dir: string;
let printer: string;

beforeAll(() => {
  if (!isWindows) return;
  dir = mkdtempSync(join(tmpdir(), "no-sandbox-windows-"));
  printer = join(dir, "argv.js");
  writeFileSync(printer, ARGV_PRINTER);
  for (const bin of [...AGENT_BINS, "argv-shim"]) {
    writeFileSync(join(dir, `${bin}.cmd`), NPM_CMD_SHIM);
  }
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

interface Printed {
  readonly argv: string[];
  readonly stdin: string | null;
  readonly probe: string | null;
}

/** A noSandbox handle whose PATH finds the fake agents first. */
const makeHandle = async (env: Record<string, string> = {}) => {
  const provider = noSandbox();
  return provider.create({
    worktreePath: dir,
    env: { PATH: `${dir};${process.env.PATH ?? ""}`, ...env },
  });
};

const execPrinted = async (
  command: string,
  opts: { stdin?: string; env?: Record<string, string> } = {},
): Promise<Printed> => {
  const handle = await makeHandle(opts.env);
  const result = await handle.exec(command, { stdin: opts.stdin });
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout) as Printed;
};

const posixArgs = (args: readonly string[]): string =>
  args.map(shellEscape).join(" ");

describe.runIf(isWindows)("noSandbox on Windows (cmd.exe, #940)", () => {
  it("passes every argument verbatim to an .exe (node)", async () => {
    const args = [...NASTY_ARGS, "two\nlines\r\nand three", LONG_PROMPT];
    const printed = await execPrinted(
      `node ${shellEscape(printer)} ${posixArgs(args)}`,
    );
    expect(printed.argv).toStrictEqual(args);
  });

  it("passes every argument verbatim through an npm .cmd shim", async () => {
    const args = [...NASTY_ARGS, LONG_PROMPT.slice(0, 1500)];
    const printed = await execPrinted(`argv-shim ${posixArgs(args)}`);
    expect(printed.argv).toStrictEqual(args);
  });

  it("refuses, with a clear error, an argument a .cmd shim can't receive", async () => {
    const handle = await makeHandle();
    await expect(
      handle.exec(`argv-shim ${shellEscape("two\nlines")}`),
    ).rejects.toThrow(/newline/);
    await expect(
      handle.exec(`argv-shim ${shellEscape("x".repeat(9000))}`),
    ).rejects.toThrow(/too long/);
  });

  it("applies a leading `export NAME=value;` to the command's env", async () => {
    const printed = await execPrinted(
      `export SANDCASTLE_PROBE=${shellEscape("a b & 100%")}; node ${shellEscape(printer)} x`,
    );
    expect(printed.probe).toBe("a b & 100%");
    expect(printed.argv).toStrictEqual(["x"]);
  });

  it("interactiveExec passes argv verbatim through a .cmd shim", async () => {
    const out = join(dir, "interactive.json");
    const args = NASTY_ARGS.filter((a) => a !== "");
    const handle = await makeHandle({ SANDCASTLE_ARGV_OUT: out });
    const result = await handle.interactiveExec(["argv-shim", ...args], {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    });
    expect(result.exitCode).toBe(0);
    const printed = JSON.parse(readFileSync(out, "utf8")) as Printed;
    expect(printed.argv).toStrictEqual(args);
  });

  describe("every agent provider's print command", () => {
    const model = "claude-fable-5[1m]";
    const prompt = `Fix "the bug" in it's & | ^ %PATH% ${LONG_PROMPT.slice(0, 600)}`;
    const session = "0b6c1f0e-1d2a-4c3b-9e8f-7a6b5c4d3e2f";

    const valueAfter = (argv: string[], flag: string): string | undefined =>
      argv[argv.indexOf(flag) + 1];

    const run = async (
      agent: AgentProvider,
      resumeSession?: string,
    ): Promise<Printed> => {
      const printCmd = agent.buildPrintCommand({
        prompt,
        dangerouslySkipPermissions: true,
        resumeSession,
      });
      return execPrinted(printCmd.command, {
        stdin: printCmd.stdin,
        env: {
          SANDCASTLE_READ_STDIN: printCmd.stdin === undefined ? "0" : "1",
        },
      });
    };

    it("claudeCode: --model and --resume arrive unquoted, prompt on stdin", async () => {
      const printed = await run(claudeCode(model), session);
      expect(valueAfter(printed.argv, "--model")).toBe(model);
      expect(valueAfter(printed.argv, "--resume")).toBe(session);
      expect(printed.stdin).toBe(prompt);
    });

    it("codex: resume id, -m and -c arrive unquoted, prompt on stdin", async () => {
      const printed = await run(codex(model, { effort: "high" }), session);
      expect(printed.argv.slice(0, 2)).toStrictEqual(["resume", session]);
      expect(valueAfter(printed.argv, "-m")).toBe(model);
      expect(valueAfter(printed.argv, "-c")).toBe(
        'model_reasoning_effort="high"',
      );
      expect(printed.stdin).toBe(prompt);
    });

    it("pi: --model and --session arrive unquoted, prompt on stdin", async () => {
      const printed = await run(pi(model), session);
      expect(valueAfter(printed.argv, "--model")).toBe(model);
      expect(valueAfter(printed.argv, "--session")).toBe(session);
      expect(printed.stdin).toBe(prompt);
    });

    it("cursor: --model and the prompt arrive verbatim", async () => {
      const printed = await run(cursor(model));
      expect(valueAfter(printed.argv, "--model")).toBe(model);
      expect(printed.argv.at(-1)).toBe(prompt);
    });

    it("opencode: --model, --variant, --agent and the prompt arrive verbatim", async () => {
      const printed = await run(
        opencode(model, { variant: "high", agent: "build plan" }),
      );
      expect(valueAfter(printed.argv, "--model")).toBe(model);
      expect(valueAfter(printed.argv, "--variant")).toBe("high");
      expect(valueAfter(printed.argv, "--agent")).toBe("build plan");
      expect(printed.argv.at(-1)).toBe(prompt);
    });

    it("copilot: the prompt and --model arrive verbatim", async () => {
      const printed = await run(copilot(model));
      expect(valueAfter(printed.argv, "-p")).toBe(prompt);
      expect(valueAfter(printed.argv, "--model")).toBe(model);
    });
  });
});
