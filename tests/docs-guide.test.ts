import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// The user docs are three things kept in step by hand: the pages in
// docs/guide/, its toc.json, and the README's Documentation list. Each page
// outside the start page and the Reference group explains glossary terms, and
// opens with their definitions copied from GLOSSARY.md. See CLAUDE.md.
const root = path.resolve(import.meta.dirname, "..");
const guide = path.join(root, "docs", "guide");

const Toc = z.object({
  start: z.string(),
  groups: z.array(z.object({ title: z.string(), pages: z.array(z.string()) })),
});
const toc = Toc.parse(
  JSON.parse(readFileSync(path.join(guide, "toc.json"), "utf8")),
);
const listed = [toc.start, ...toc.groups.flatMap((group) => group.pages)];
const pages = readdirSync(guide)
  .filter((file) => file.endsWith(".md"))
  .map((file) => path.basename(file, ".md"));

const withoutCode = (markdown: string) =>
  markdown.replaceAll(/^```[\s\S]*?^```/gmu, "");
const read = (slug: string) =>
  withoutCode(readFileSync(path.join(guide, `${slug}.md`), "utf8"));

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to `-`. */
const anchorOf = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s_-]/gu, "")
    .replaceAll(" ", "-");
const anchorsOf = (slug: string) =>
  [...read(slug).matchAll(/^#{1,6} (?<heading>.+)$/gmu)].map((match) =>
    anchorOf(match.groups?.heading ?? ""),
  );

/**
 * Every `](./…)`, `](../…)` and `](#…)` link on every page: the file it
 * resolves to, and the guide page and anchor it points at, if any.
 */
const links = pages.flatMap((page) =>
  [...read(page).matchAll(/\]\((?<target>(?:\.{1,2}\/|#)[^)\s]*)\)/gu)].map(
    (match) => {
      const target = match.groups?.target ?? "";
      const [file = "", anchor] = target.split("#");
      const resolved = path.resolve(guide, file === "" ? `${page}.md` : file);
      const linkedPage = pages.find(
        (slug) => path.join(guide, `${slug}.md`) === resolved,
      );
      return { page, target, resolved, linkedPage, anchor };
    },
  ),
);
const anchorLinks = links.flatMap(({ page, target, linkedPage, anchor }) =>
  linkedPage === undefined || anchor === undefined
    ? []
    : [{ page, target, anchors: anchorsOf(linkedPage), anchor }],
);

/** The pages that explain glossary terms: all but the start page and the Reference group. */
const termPages = toc.groups
  .filter((group) => group.title !== "Reference")
  .flatMap((group) => group.pages);
const glossary = readFileSync(path.join(root, "GLOSSARY.md"), "utf8");

const definitionBlock = /^> (?<term>\*\*[^*]+\*\*:) (?<text>.+)$/u;

/** The `> **Term**: definition` blocks that open a page, right under its title. */
const openingDefinitions = (slug: string) => {
  const [, ...blocks] = read(slug).split(/\n\s*\n/u);
  const end = blocks.findIndex((block) => !definitionBlock.test(block));
  return blocks.slice(0, end === -1 ? blocks.length : end);
};

/**
 * Each opening definition on a term page, as the `**Term**:` entry it must
 * match in GLOSSARY.md: the term's line, then the definition's line.
 */
const definitions = termPages.flatMap((page) =>
  openingDefinitions(page).map((block) => {
    const groups = definitionBlock.exec(block)?.groups;
    return {
      page,
      term: groups?.term ?? "",
      entry: `\n${groups?.term ?? ""}\n${groups?.text ?? ""}\n`,
    };
  }),
);

describe("docs/guide", () => {
  it("lists every page in toc.json exactly once", () => {
    expect(new Set(listed)).toStrictEqual(new Set(pages));
    expect(listed).toHaveLength(pages.length);
  });

  it.each(pages)("opens %s with its one # title", (slug) => {
    const markdown = read(slug);
    expect(markdown).toMatch(/^# \S/u);
    expect(markdown.match(/^# /gmu)).toHaveLength(1);
  });

  it.each(listed)("links %s from the README", (slug) => {
    const readme = readFileSync(path.join(root, "README.md"), "utf8");
    expect(readme).toContain(`(./docs/guide/${slug}.md)`);
  });

  it.each(links)("$page links to $target, a file that exists", (link) => {
    expect(existsSync(link.resolved)).toBe(true);
  });

  it.each(anchorLinks)(
    "$page links to $target, a heading that exists",
    (link) => {
      expect(link.anchors).toContain(link.anchor);
    },
  );

  it.each(termPages)(
    "opens %s with a glossary definition under its title",
    (slug) => {
      expect(openingDefinitions(slug).length).toBeGreaterThan(0);
    },
  );

  it.each(definitions)(
    "$page defines $term word for word as GLOSSARY.md does",
    (definition) => {
      expect(glossary).toContain(definition.entry);
    },
  );
});
