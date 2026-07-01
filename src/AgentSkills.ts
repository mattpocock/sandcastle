import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, posix, resolve } from "node:path";
import { SHELL_BLOCK_MARKER } from "./PromptPreprocessor.js";

export type SkillTarget =
  | "auto"
  | "generic"
  | "claude-code"
  | "codex"
  | "opencode";

export interface SkillSpec {
  /** Optional display and target directory name. Defaults to basename(source). */
  readonly name?: string;
  /** Host path to a skill directory containing SKILL.md. Absolute, ~, or cwd-relative. */
  readonly source: string;
  /** Future extension point. MVP treats "auto" as "generic". */
  readonly target?: SkillTarget;
  /** Defaults to true for bind-mount providers. */
  readonly readonly?: boolean;
}

export interface ResolvedSkill {
  readonly name: string;
  readonly hostPath: string;
  readonly sandboxPath: string;
  readonly readonly: boolean;
}

export interface ResolveSkillsOptions {
  readonly skills?: readonly SkillSpec[];
  readonly cwd: string;
  readonly sandboxSkillsDir?: string;
}

export const DEFAULT_SANDBOX_SKILLS_DIR = "/home/agent/.sandcastle/skills";

const expandTilde = (path: string): string => {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }
  return path;
};

const resolveHostPath = (source: string, cwd: string): string => {
  const expanded = expandTilde(source);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
};

const assertSafeSkillName = (name: string): void => {
  if (name === "." || name === "..") {
    throw new Error(
      `Invalid skill name "${name}". Use only letters, numbers, dot, underscore, and hyphen.`,
    );
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(
      `Invalid skill name "${name}". Use only letters, numbers, dot, underscore, and hyphen.`,
    );
  }
};

const stripPromptPreprocessorMarkers = (value: string): string =>
  value.replaceAll(SHELL_BLOCK_MARKER, "");

export const resolveSkills = ({
  skills,
  cwd,
  sandboxSkillsDir = DEFAULT_SANDBOX_SKILLS_DIR,
}: ResolveSkillsOptions): ResolvedSkill[] => {
  return (skills ?? []).map((skill) => {
    const hostPath = resolveHostPath(skill.source, cwd);
    if (!existsSync(hostPath)) {
      throw new Error(`Skill source does not exist: ${skill.source}`);
    }
    if (!statSync(hostPath).isDirectory()) {
      throw new Error(`Skill source must be a directory: ${skill.source}`);
    }

    const skillFile = join(hostPath, "SKILL.md");
    if (!existsSync(skillFile)) {
      throw new Error(`Skill source must contain SKILL.md: ${skill.source}`);
    }

    const name = skill.name ?? basename(hostPath);
    assertSafeSkillName(name);

    return {
      name,
      hostPath,
      sandboxPath: posix.join(sandboxSkillsDir, name),
      readonly: skill.readonly ?? true,
    };
  });
};

export const buildSkillsPromptPreamble = (
  skills: readonly ResolvedSkill[],
): string => {
  if (skills.length === 0) return "";

  const entries = skills
    .map((skill) => {
      const name = stripPromptPreprocessorMarkers(skill.name);
      const sandboxPath = stripPromptPreprocessorMarkers(skill.sandboxPath);
      return `- ${name}: ${sandboxPath}/SKILL.md`;
    })
    .join("\n");

  return `# Available Skills

The host provided these skills. Before using a skill, read its SKILL.md file inside the sandbox.

${entries}

Only use these skills when relevant to the task. Do not modify or commit skill files.`;
};

export const prependSkillsPrompt = (
  prompt: string,
  skills: readonly ResolvedSkill[],
): string => {
  const preamble = buildSkillsPromptPreamble(skills);
  return preamble ? `${preamble}\n\n---\n\n${prompt}` : prompt;
};

export const exposeSkillsViaHostPaths = (
  skills: readonly ResolvedSkill[],
): ResolvedSkill[] =>
  skills.map((skill) => ({
    ...skill,
    sandboxPath: skill.hostPath,
  }));
