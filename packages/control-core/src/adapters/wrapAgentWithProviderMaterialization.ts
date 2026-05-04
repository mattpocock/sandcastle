import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProvider, PrintCommand } from "@ai-hero/sandcastle";
import type { ProviderAdapterOutput } from "./AgentProviderAdapter.js";

export const withProviderMaterialization = (input: {
  readonly agent: AgentProvider;
  readonly output: ProviderAdapterOutput;
  readonly runnerDir: string;
  readonly runId: string;
}): AgentProvider => {
  const { output } = input;
  if (
    output.files.length === 0 &&
    !output.promptPrelude &&
    Object.keys(output.env ?? {}).length === 0
  ) {
    return input.agent;
  }

  return {
    ...input.agent,
    env: { ...input.agent.env, ...(output.env ?? {}) },
    buildPrintCommand: (options) => {
      const prompt = output.promptPrelude
        ? `${output.promptPrelude.trim()}\n\n${options.prompt}`
        : options.prompt;
      const command = input.agent.buildPrintCommand({ ...options, prompt });
      return wrapPrintCommand(input, command);
    },
    buildInteractiveArgs: input.agent.buildInteractiveArgs
      ? (options) => {
          const prompt = output.promptPrelude
            ? `${output.promptPrelude.trim()}\n\n${options.prompt}`
            : options.prompt;
          return input.agent.buildInteractiveArgs!({ ...options, prompt });
        }
      : undefined,
  };
};

const wrapPrintCommand = (
  input: {
    readonly output: ProviderAdapterOutput;
    readonly runnerDir: string;
    readonly runId: string;
  },
  command: PrintCommand,
): PrintCommand => {
  mkdirSync(input.runnerDir, { recursive: true });
  const scriptPath = join(
    input.runnerDir,
    `provider-adapter-${input.runId}-${process.pid}.mjs`,
  );
  writeFileSync(scriptPath, buildRunnerScript(input.output, command), "utf8");
  // Pass unquoted: the engine's command construction (`cd <wt> && <cmd>`)
  // mangles quoted absolute paths on Windows cmd.exe, joining them with the
  // worktree path. .sandcastle/state/adapter-runners is repo-relative and
  // cannot contain spaces.
  return { command: `node ${scriptPath}` };
};

const buildRunnerScript = (
  output: ProviderAdapterOutput,
  command: PrintCommand,
): string => `
import { mkdir, rm, rename, writeFile, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const payload = ${JSON.stringify({ output, command })};

const assertRelative = (relativePath) => {
  if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\\\/]+/g).includes("..")) {
    throw new Error("Invalid provider materialization path: " + relativePath);
  }
};

const resolveInside = (root, relativePath) => {
  assertRelative(relativePath);
  const target = resolve(root, relativePath);
  const back = relative(resolve(root), target);
  if (back === "" || (!back.startsWith("..") && !isAbsolute(back))) return target;
  throw new Error("Invalid provider materialization path: " + relativePath);
};

const writeAtomic = async (root, file) => {
  const target = resolveInside(root, file.relativePath);
  await mkdir(dirname(target), { recursive: true });
  const temporary = target + ".sandcastle-" + process.pid + "-" + Date.now() + ".tmp";
  await writeFile(temporary, file.content, "utf8");
  await rename(temporary, target);
};

const cleanup = async (root) => {
  for (const cleanupPath of payload.output.cleanupPaths ?? []) {
    try {
      await rm(resolveInside(root, cleanupPath), { recursive: true, force: true });
    } catch (error) {
      console.warn("[sandcastle-control] provider cleanup failed", cleanupPath, error);
    }
  }
};

let exitCode = 0;
try {
  for (const file of payload.output.files) await writeAtomic(process.cwd(), file);
  exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(payload.command.command, {
      cwd: process.cwd(),
      env: process.env,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (payload.command.stdin !== undefined) {
      child.stdin.write(payload.command.stdin);
    }
    child.stdin.end();
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.on("error", reject);
    child.on("close", (code) => resolveExit(code ?? 0));
  });
} finally {
  await cleanup(process.cwd());
  await unlink(fileURLToPath(import.meta.url)).catch(() => {});
}

process.exit(exitCode);
`;
