import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  anchorOf,
  firstMentions,
  glossaryEntries,
} from "./helpers/docsGlossary.js";

// The user docs are three things kept in step by hand: the pages in
// docs/guide/, its toc.json, and the README's Documentation list. The
// glossary page defines each term, under a name GLOSSARY.md uses, and every
// other page links a term to it the first time it mentions it. See CLAUDE.md.
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

const glossary = readFileSync(path.join(root, "GLOSSARY.md"), "utf8");
const entries = glossaryEntries(read("glossary"));
const entryAnchors = entries.map((entry) => entry.anchor);
/** Each pair of neighbouring glossary entries, to check their order. */
const adjacentEntries = entries.flatMap((entry, index) => {
  const next = entries[index + 1];
  return next === undefined ? [] : [{ before: entry.term, after: next.term }];
});

/** Every markdown file under docs/, and the README. */
const docs = [
  path.join(root, "README.md"),
  ...readdirSync(path.join(root, "docs"), { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".md"))
    .map((file) => path.join(root, "docs", file)),
];
const glossaryFile = path.join(guide, "glossary.md");

/** Every link, in any of those files, to an anchor on the glossary page. */
const glossaryLinks = docs.flatMap((file) =>
  [
    ...readFileSync(file, "utf8").matchAll(
      /\]\((?<target>[^)\s#]*)#(?<anchor>[^)\s]+)\)/gu,
    ),
  ].flatMap((match) => {
    const target = match.groups?.target ?? "";
    const resolved =
      target === "" ? file : path.resolve(path.dirname(file), target);
    return resolved === glossaryFile
      ? [
          {
            file: path.relative(root, file),
            target: `${target}#${match.groups?.anchor ?? ""}`,
            anchor: match.groups?.anchor ?? "",
          },
        ]
      : [];
  }),
);

/** The pages the first-mention lint covers: all but the glossary itself. */
const mentionPages = pages.filter((page) => page !== "glossary");

const titleOf = (slug: string) =>
  /^# (?<title>.+)$/mu.exec(read(slug))?.groups?.title?.trim() ?? "";

/**
 * Each glossary entry's home: the earliest page in sidebar order that
 * mentions it, where the guide explains it. The glossary doesn't count.
 */
const mentionsByPage = listed
  .filter((slug) => slug !== "glossary")
  .map((slug) => ({
    slug,
    terms: new Set(
      firstMentions(
        readFileSync(path.join(guide, `${slug}.md`), "utf8"),
        entries,
      ).map((mention) => mention.entry.term),
    ),
  }));
const glossaryMarkdown = read("glossary");
const homes = entries.map((entry) => {
  const home = mentionsByPage.find(({ terms }) => terms.has(entry.term));
  const body =
    glossaryMarkdown
      .split(/^## /mu)
      .find((section) => section.startsWith(`${entry.term}\n`)) ?? "";
  return {
    term: entry.term,
    home: home?.slug,
    lastLine: body.trim().split("\n").at(-1) ?? "",
  };
});
const mentionedHomes = homes.filter((home) => home.home !== undefined);
const unmentioned = homes.filter((home) => home.home === undefined);

/** The README and every guide page: where readers go, so no ADRs. */
const userDocs = [
  "README.md",
  ...pages.map((slug) => path.join("docs", "guide", `${slug}.md`)),
];

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

  it.each(entries)(
    "defines $term in the glossary, a term GLOSSARY.md defines",
    (entry) => {
      expect(glossary).toContain(`\n**${entry.term}**:\n`);
    },
  );

  it.each(adjacentEntries)(
    "lists $before before $after in the glossary, alphabetically",
    ({ before, after }) => {
      expect(before.localeCompare(after, "en")).toBeLessThan(0);
    },
  );

  it.each(glossaryLinks)("$file links to $target, a glossary entry", (link) => {
    expect(entryAnchors).toContain(link.anchor);
  });

  it.each(mentionPages)(
    "links the first mention of each glossary term on %s to its entry",
    (slug) => {
      const markdown = readFileSync(path.join(guide, `${slug}.md`), "utf8");
      const unlinked = firstMentions(markdown, entries)
        .filter((mention) => mention.linkedTo !== mention.entry.anchor)
        .map(
          (mention) =>
            `"${mention.text}" -> ./glossary.md#${mention.entry.anchor}`,
        );
      expect(unlinked).toStrictEqual([]);
    },
  );

  it.each(mentionedHomes)(
    "ends the glossary entry for $term with its home page, $home",
    ({ home = "", lastLine }) => {
      expect(lastLine).toBe(
        `First explained in [${titleOf(home)}](./${home}.md).`,
      );
    },
  );

  // A term no page mentions has no home: the glossary must not claim one.
  it.each(unmentioned)(
    "gives $term, which no guide page mentions, no home page",
    ({ lastLine }) => {
      expect(lastLine).not.toMatch(/^First explained in /u);
    },
  );

  it.each(userDocs)("never sends readers of %s to an ADR", (file) => {
    const markdown = readFileSync(path.join(root, file), "utf8");
    expect(markdown).not.toMatch(/\badr\//iu);
    expect(markdown).not.toMatch(/\bADRs?\b/u);
  });
});

describe("firstMentions", () => {
  const terms = glossaryEntries(
    "## Agent\n\n## Agent provider\n\n## Sandbox\n",
  );
  const mentioned = (markdown: string) =>
    firstMentions(markdown, terms).map((mention) => ({
      term: mention.entry.term,
      text: mention.text,
      linkedTo: mention.linkedTo,
    }));

  it("matches whole words, any case, plural included", () => {
    expect(mentioned("Two Sandboxes and some agentic code.")).toStrictEqual([
      { term: "Sandbox", text: "Sandboxes", linkedTo: undefined },
    ]);
  });

  it("lets a longer term win, and a hyphen join words", () => {
    expect(mentioned("An agent provider in a no-sandbox run.")).toStrictEqual([
      { term: "Agent provider", text: "agent provider", linkedTo: undefined },
    ]);
  });

  it("skips code, headings and links to other pages", () => {
    const markdown = [
      "# Agent",
      "`agent` and [the agent](./agents.md).",
      "```ts\nconst sandbox = 1;\n```",
      "Then the [agent](./glossary.md#agent).",
    ].join("\n");
    expect(mentioned(markdown)).toStrictEqual([
      { term: "Agent", text: "agent", linkedTo: "agent" },
    ]);
  });
});
