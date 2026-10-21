import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The user docs are three things kept in step by hand: the pages in this
// folder, toc.json, and the README's Documentation list. See CLAUDE.md.
const guide = dirname(fileURLToPath(import.meta.url));
const root = resolve(guide, "../..");

type Toc = { start: string; groups: { title: string; pages: string[] }[] };
const toc: Toc = JSON.parse(readFileSync(join(guide, "toc.json"), "utf8"));
const listed = [toc.start, ...toc.groups.flatMap((group) => group.pages)];
const pages = readdirSync(guide)
  .filter((file) => file.endsWith(".md"))
  .map((file) => file.slice(0, -".md".length));

const withoutCode = (markdown: string) =>
  markdown.replace(/^```[\s\S]*?^```/gm, "");
const read = (slug: string) =>
  withoutCode(readFileSync(join(guide, `${slug}.md`), "utf8"));

describe("docs/guide", () => {
  it("lists every page in toc.json exactly once", () => {
    expect([...listed].sort()).toEqual([...pages].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("opens every page with its one # title", () => {
    for (const slug of pages) {
      const markdown = read(slug);
      expect(markdown, slug).toMatch(/^# \S/);
      expect(markdown.match(/^# /gm), slug).toHaveLength(1);
    }
  });

  it("links every page from the README", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    for (const slug of listed) {
      expect(readme, slug).toContain(`(./docs/guide/${slug}.md)`);
    }
  });

  it("links only to files that exist", () => {
    for (const slug of pages) {
      for (const [, target] of read(slug).matchAll(
        /\]\((\.{1,2}\/[^)#\s]+)/g,
      )) {
        expect(existsSync(resolve(guide, target!)), `${slug}: ${target}`).toBe(
          true,
        );
      }
    }
  });
});
