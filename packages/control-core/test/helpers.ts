import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { AgentProvider } from "@ai-hero/sandcastle";

export const makeRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-control-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: dir,
  });
  writeFileSync(join(dir, "README.md"), "# test\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  mkdirSync(join(dir, ".sandcastle", "logs"), { recursive: true });
  return dir;
};

export const fakeAgent = (options?: {
  delayMs?: number;
  completion?: boolean;
}): AgentProvider => {
  const delay = options?.delayMs ?? 0;
  const completion = options?.completion ?? true;
  return {
    name: "fake-agent",
    env: {},
    captureSessions: false,
    buildPrintCommand: () => {
      const script = `
        const emit = (obj) => console.log(JSON.stringify(obj));
        emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello ' }] } });
        emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo ok' } }] } });
        setTimeout(() => {
          emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'world' }] } });
          emit({ type: 'result', result: '${completion ? "<promise>COMPLETE</promise>" : "not complete"}' });
        }, ${delay});
      `;
      return { command: `node -e ${JSON.stringify(script)}` };
    },
    parseStreamLine: (line: string) => {
      if (!line.startsWith("{")) return [];
      const obj = JSON.parse(line);
      if (obj.type === "assistant") {
        return obj.message.content.flatMap((block: any) => {
          if (block.type === "text")
            return [{ type: "text" as const, text: block.text }];
          if (block.type === "tool_use")
            return [
              {
                type: "tool_call" as const,
                name: block.name,
                args: block.input.command,
              },
            ];
          return [];
        });
      }
      if (obj.type === "result")
        return [{ type: "result" as const, result: obj.result }];
      return [];
    },
  };
};

export const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs)
      throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
