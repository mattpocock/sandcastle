/**
 * The glossary page (docs/guide/glossary.md) and the first-mention lint that
 * keeps the rest of the guide linked to it. Shared by tests/docs-guide.test.ts.
 */

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to `-`. */
export const anchorOf = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s_-]/gu, "")
    .replaceAll(" ", "-");

/** One glossary entry: a `## Term` heading on the glossary page. */
export interface GlossaryEntry {
  readonly term: string;
  readonly anchor: string;
}

/** The entries on the glossary page, in page order. */
export const glossaryEntries = (markdown: string): GlossaryEntry[] =>
  [...markdown.matchAll(/^## (?<term>.+)$/gmu)].map((match) => {
    const term = (match.groups?.term ?? "").trim();
    return { term, anchor: anchorOf(term) };
  });

/** A term's first mention on a page, and the glossary anchor it links to, if any. */
export interface FirstMention {
  readonly entry: GlossaryEntry;
  readonly text: string;
  readonly index: number;
  readonly linkedTo: string | undefined;
}

/** Blanks a match, keeping its newlines so every index stays where it was. */
const blank = (text: string) => text.replaceAll(/[^\n]/gu, " ");

interface LinkRegion {
  start: number;
  end: number;
  anchor: string;
}

/** A markdown link or image, as one match. */
const linkPattern = /!?\[[^\]]*\]\([^)\s]*\)/gu;

/** A link's label and, if it points at a glossary entry, that entry's anchor. */
const glossaryLink = (link: string) => ({
  label: /^\[(?<label>[^\]]*)\]/u.exec(link)?.groups?.label,
  anchor: /\]\((?:[^)]*\/)?glossary\.md#(?<anchor>[^)]+)\)$/u.exec(link)?.groups
    ?.anchor,
});

/**
 * Blanks links: a glossary link keeps its label, recorded as a region with
 * its anchor; any other link or image is blanked whole, label included.
 */
const blankLinks = (text: string) => {
  const regions: LinkRegion[] = [];
  let kept = text;
  for (const match of text.matchAll(linkPattern)) {
    const { label, anchor } = glossaryLink(match[0]);
    const start = match.index + 1;
    if (label !== undefined && anchor !== undefined) {
      regions.push({ start, end: start + label.length, anchor });
    }
    const replacement =
      label !== undefined && anchor !== undefined
        ? ` ${label}${blank(match[0].slice(label.length + 1))}`
        : blank(match[0]);
    kept = `${kept.slice(0, match.index)}${replacement}${kept.slice(match.index + match[0].length)}`;
  }
  return { text: kept, regions };
};

/**
 * Blanks everything that is not prose: fenced code, inline code, HTML
 * comments and tags, headings, URLs, and the labels of links that don't point
 * at a glossary entry. Every index stays where it was in the page.
 */
const prose = (markdown: string) => {
  const { text, regions } = blankLinks(
    markdown
      .replaceAll(/^```[\s\S]*?^```/gmu, blank)
      .replaceAll(/<!--[\s\S]*?-->/gu, blank)
      .replaceAll(/^#{1,6} .*$/gmu, blank)
      .replaceAll(/(?<ticks>`+).+?\k<ticks>/gu, blank),
  );
  return {
    text: text.replaceAll(/<[^>\n]+>|https?:\/\/\S+/gu, blank),
    regions,
  };
};

const escape = (text: string) =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/**
 * A term as a whole-word, case-insensitive pattern: plural allowed (`-s`,
 * `-es`, `-y` to `-ies`), and a hyphen counts as part of the word, so
 * "no-sandbox" is not a mention of "sandbox".
 */
const mentionPattern = (term: string) => {
  const words = escape(term).replaceAll(" ", String.raw`\s+`);
  const plural = term.endsWith("y")
    ? `${words.slice(0, -1)}(?:y|ies)`
    : `${words}(?:e?s)?`;
  return new RegExp(
    `(?<![\\p{L}\\p{N}_-])${plural}(?![\\p{L}\\p{N}_-])`,
    "giu",
  );
};

/** Every place a term is mentioned in a page's prose. */
const matchesOf = (text: string, entry: GlossaryEntry) =>
  [...text.matchAll(mentionPattern(entry.term))].map((match) => ({
    entry,
    text: match[0],
    index: match.index,
  }));

type Match = ReturnType<typeof matchesOf>[number];

/** Whether a longer term's match covers this one, as "agent provider" covers "agent". */
const coveredBy = (match: Match, other: Match) =>
  other.entry.term.length > match.entry.term.length &&
  other.index <= match.index &&
  other.index + other.text.length >= match.index + match.text.length;

/**
 * The first mention of each glossary term on a page, in glossary order,
 * outside code, headings and other links. A mention inside a longer term's
 * mention doesn't count, so "agent provider" is not also a mention of "agent".
 */
export const firstMentions = (
  markdown: string,
  entries: readonly GlossaryEntry[],
): FirstMention[] => {
  const page = prose(markdown);
  const all = entries.flatMap((entry) => matchesOf(page.text, entry));
  return entries.flatMap((entry) => {
    const first = all.find(
      (match) =>
        match.entry === entry && !all.some((other) => coveredBy(match, other)),
    );
    if (first === undefined) {
      return [];
    }
    const region = page.regions.find(
      ({ start, end }) => first.index >= start && first.index < end,
    );
    return [{ ...first, linkedTo: region?.anchor }];
  });
};
