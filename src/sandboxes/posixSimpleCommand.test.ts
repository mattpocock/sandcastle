import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  claudeCode,
  codex,
  copilot,
  cursor,
  opencode,
  pi,
  shellEscape,
} from "../AgentProvider.js";
import { parseSimpleCommand } from "./posixSimpleCommand.js";

const NASTY = [
  "plain",
  "has spaces",
  "",
  "it's",
  "''",
  'say "hi"',
  "100% %PATH% ^ & | < > ( ) ! ; * ? [ ] { } ~ #",
  "$HOME `id` $(id)",
  "back\\slash\\",
  "two\nlines",
  "claude-fable-5[1m]",
];

describe("parseSimpleCommand", () => {
  it("inverts shellEscape for any argument", () => {
    const command = ["prog", ...NASTY.map((arg) => shellEscape(arg))].join(" ");
    expect(parseSimpleCommand(command)).toStrictEqual({
      env: {},
      argv: ["prog", ...NASTY],
    });
  });

  it("reads POSIX double quotes and their backslash escapes", () => {
    expect(
      parseSimpleCommand(String.raw`git rev-list "a b\"c\\d\x" --count`)?.argv,
    ).toStrictEqual(["git", "rev-list", String.raw`a b"c\d\x`, "--count"]);
  });

  it("collects leading export statements as env", () => {
    expect(
      parseSimpleCommand(
        `export A=${shellEscape("x y")}; export B='1' C=2; claude -p -`,
      ),
    ).toStrictEqual({
      env: { A: "x y", B: "1", C: "2" },
      argv: ["claude", "-p", "-"],
    });
  });

  it.each([
    ["a pipe", "a | b"],
    ["a redirect", "find /x -name y 2>/dev/null"],
    ["a variable", "echo $HOME"],
    ["a cmd.exe variable", "echo %MY_TEST_VAR%"],
    ["a sequence", "a && b"],
    ["a non-export statement", "cd x; ls"],
    ["a prefix assignment", "FOO=1 node x"],
    ["a Windows path", String.raw`C:\tools\x.exe arg`],
    ["an unterminated quote", "node 'x"],
    ["a command substitution in double quotes", 'echo "$(id)"'],
    ["nothing", "   "],
  ])("returns undefined for %s", (_, command) => {
    expect(parseSimpleCommand(command)).toBeUndefined();
  });
});

describe("every agent provider's print command is a simple command", () => {
  const model = "claude-fable-5[1m]";
  const prompt = `Fix "the bug" in it's & | ^ %PATH% $HOME\nsecond line`;
  const session = "0b6c1f0e-1d2a-4c3b-9e8f-7a6b5c4d3e2f";
  const commands = {
    claudeCode: claudeCode(model, { effort: "high" }),
    codex: codex(model, { effort: "high", approvalsReviewer: "auto_review" }),
    pi: pi(model, { thinking: "low" }),
    cursor: cursor(model),
    opencode: opencode(model, { variant: "high", agent: "build plan" }),
    copilot: copilot(model, { effort: "high" }),
  };

  const printCommands = Object.entries(commands).flatMap(([name, agent]) =>
    [undefined, session].map((resumeSession) => ({
      name: `${name}${resumeSession === undefined ? "" : " (resume)"}`,
      command: agent.buildPrintCommand({
        prompt,
        dangerouslySkipPermissions: true,
        resumeSession,
      }).command,
    })),
  );

  it.each(printCommands)("$name parses", ({ command }) => {
    expect(parseSimpleCommand(command)?.argv).toContain(model);
  });

  // Real sh is the oracle: `set --` word-splits and unquotes the command
  // exactly as `sh -c` would before running it.
  it.skipIf(process.platform === "win32").each(printCommands)(
    "$name parses as sh does",
    ({ command }) => {
      const fromSh = execFileSync(
        "sh",
        ["-c", `set -- ${command}; printf '%s\\0' "$@"`],
        { encoding: "utf8" },
      )
        .split("\0")
        .slice(0, -1);
      expect(parseSimpleCommand(command)?.argv).toStrictEqual(fromSh);
    },
  );
});
