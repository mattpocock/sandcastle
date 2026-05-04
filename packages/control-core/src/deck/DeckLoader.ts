import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  type Stats,
} from "node:fs";
import { basename, extname, join, relative } from "node:path";
import type {
  CommandCard,
  Deck,
  ModeCard,
  SkillCard,
} from "@sandcastle/protocol";

interface FrontmatterFile {
  readonly data: Record<string, unknown>;
  readonly content: string;
}

export interface DeckLoaderOptions {
  readonly warn?: (message: string, error?: unknown) => void;
}

export class DeckLoader {
  private readonly warn: (message: string, error?: unknown) => void;

  constructor(options?: DeckLoaderOptions) {
    this.warn =
      options?.warn ??
      ((message, error) =>
        console.warn("[sandcastle-control] " + message, error ?? ""));
  }

  loadDeck(repoRoot: string): Deck {
    const mode = this.loadMode(repoRoot);
    const skills = this.loadCards(repoRoot, "skills", (file, stats) =>
      this.toSkill(repoRoot, file, stats),
    );
    const commands = this.loadCards(repoRoot, "commands", (file, stats) =>
      this.toCommand(repoRoot, file, stats),
    );
    return {
      version: 1,
      mode,
      skills,
      commands,
      order: [
        mode.id,
        ...skills.map((skill) => skill.id),
        ...commands.map((command) => command.id),
      ],
    };
  }

  private loadMode(repoRoot: string): ModeCard {
    const file = join(repoRoot, ".sandcastle", "agents.md");
    if (!existsSync(file)) return emptyMode();
    try {
      const stats = statSync(file);
      const parsed = parseFrontmatter(readFileSync(file, "utf8"));
      const slug = stringValue(parsed.data.slug) ?? "default";
      return {
        id: stringValue(parsed.data.id) ?? `mode-${slug}`,
        type: "mode",
        slug,
        title: stringValue(parsed.data.title) ?? "Default Mode",
        summary: stringValue(parsed.data.summary) ?? "",
        sourcePath: sourcePath(repoRoot, file),
        enabled: booleanValue(parsed.data.enabled) ?? true,
        tags: stringArrayValue(parsed.data.tags),
        body: parsed.content.trim(),
        updatedAt: stats.mtime.toISOString(),
        constraints: stringArrayValue(parsed.data.constraints),
      };
    } catch (error) {
      this.warn(`Skipping invalid deck mode file: ${file}`, error);
      return emptyMode();
    }
  }

  private loadCards<T>(
    repoRoot: string,
    section: "skills" | "commands",
    mapper: (file: string, stats: Stats) => T | undefined,
  ): T[] {
    const dir = join(repoRoot, ".sandcastle", section);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => join(dir, entry.name))
      .sort((a, b) => a.localeCompare(b))
      .flatMap((file) => {
        try {
          const stats = statSync(file);
          const card = mapper(file, stats);
          return card ? [card] : [];
        } catch (error) {
          this.warn(`Skipping invalid deck card file: ${file}`, error);
          return [];
        }
      });
  }

  private toSkill(
    repoRoot: string,
    file: string,
    stats: Stats,
  ): SkillCard | undefined {
    const parsed = parseFrontmatter(readFileSync(file, "utf8"));
    const slug = stringValue(parsed.data.slug) ?? slugFromFile(file);
    return {
      id: stringValue(parsed.data.id) ?? `skill-${slug}`,
      type: "skill",
      slug,
      title: stringValue(parsed.data.title) ?? titleFromSlug(slug),
      summary: stringValue(parsed.data.summary) ?? "",
      sourcePath: sourcePath(repoRoot, file),
      enabled: booleanValue(parsed.data.enabled) ?? true,
      tags: stringArrayValue(parsed.data.tags),
      body: parsed.content.trim(),
      updatedAt: stats.mtime.toISOString(),
      passive: true,
      triggerHints: stringArrayValue(parsed.data.triggerHints),
    };
  }

  private toCommand(
    repoRoot: string,
    file: string,
    stats: Stats,
  ): CommandCard | undefined {
    const parsed = parseFrontmatter(readFileSync(file, "utf8"));
    const slug = stringValue(parsed.data.slug) ?? slugFromFile(file);
    const command = stringValue(parsed.data.slashCommand) ?? `/${slug}`;
    return {
      id: stringValue(parsed.data.id) ?? `command-${slug}`,
      type: "command",
      slug,
      title: stringValue(parsed.data.title) ?? titleFromSlug(slug),
      summary: stringValue(parsed.data.summary) ?? "",
      sourcePath: sourcePath(repoRoot, file),
      enabled: booleanValue(parsed.data.enabled) ?? true,
      tags: stringArrayValue(parsed.data.tags),
      body: parsed.content.trim(),
      updatedAt: stats.mtime.toISOString(),
      slashCommand: command.startsWith("/") ? command : `/${command}`,
      argsSchema: recordValue(parsed.data.argsSchema),
      verifyHints: stringArrayValue(parsed.data.verifyHints),
    };
  }
}

const emptyMode = (): ModeCard => ({
  id: "mode-default",
  type: "mode",
  slug: "default",
  title: "Default Mode",
  summary: "",
  sourcePath: ".sandcastle/agents.md",
  enabled: true,
  tags: [],
  body: "",
  updatedAt: new Date(0).toISOString(),
  constraints: [],
});

const parseFrontmatter = (raw: string): FrontmatterFile => {
  if (!raw.startsWith("---")) return { data: {}, content: raw };
  const normalized = raw.replace(/\r\n/g, "\n");
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) throw new Error("Unclosed YAML frontmatter");
  const yaml = normalized.slice(3, end).trim();
  const content = normalized.slice(end + 4).replace(/^\n/, "");
  return { data: parseYamlObject(yaml), content };
};

const parseYamlObject = (yaml: string): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line))
      throw new Error(`Unsupported YAML indentation: ${line}`);
    const match = /^([^:]+):(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid YAML frontmatter line: ${line}`);
    const key = match[1]!.trim();
    const rawValue = match[2]!.trim();
    if (rawValue === "") {
      const values: string[] = [];
      while (lines[i + 1]?.trimStart().startsWith("- ")) {
        i += 1;
        values.push(stripQuotes(lines[i]!.trimStart().slice(2).trim()));
      }
      result[key] = values;
    } else {
      result[key] = parseYamlScalar(rawValue);
    }
  }
  return result;
};

const parseYamlScalar = (value: string): unknown => {
  if (value.startsWith("[") || value.endsWith("]")) {
    if (!value.startsWith("[") || !value.endsWith("]")) {
      throw new Error(`Invalid YAML array: ${value}`);
    }
    const inner = value.slice(1, -1).trim();
    return inner
      ? inner.split(",").map((entry) => stripQuotes(entry.trim()))
      : [];
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  return stripQuotes(value);
};

const stripQuotes = (value: string): string => {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
};

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const booleanValue = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const stringArrayValue = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

const recordValue = (value: unknown): Record<string, string> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : undefined;

const slugFromFile = (file: string): string =>
  basename(file, extname(file)).toLowerCase();

const titleFromSlug = (slug: string): string =>
  slug
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");

const sourcePath = (repoRoot: string, file: string): string =>
  relative(repoRoot, file).replace(/\\/g, "/");
