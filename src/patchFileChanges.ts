/**
 * Reads a patch (a `format-patch` file or a `git diff`) into the per-file
 * facts sync-out's symlink check needs. See `syncOutPatchSymlinks.ts`.
 */

/** One file's section of a patch. */
export interface FileChange {
  /** The file is a symlink after the patch. */
  symlink: boolean;
  /** Became a symlink with no content saying where it points. */
  modeOnly: boolean;
  binary: boolean;
  deleted: boolean;
  /** The new path (`+++`, `rename to`, `copy to`). */
  path: string | undefined;
  /** The old path (`---`), for a deletion. */
  oldPath: string | undefined;
  /** The source of a rename or copy. */
  from: string | undefined;
  inHunk: boolean;
  /** The new side of the hunks: a symlink's target is its single line. */
  newLines: string[];
}

const newChange = (): FileChange => ({
  symlink: false,
  modeOnly: false,
  binary: false,
  deleted: false,
  path: undefined,
  oldPath: undefined,
  from: undefined,
  inHunk: false,
  newLines: [],
});

const C_ESCAPES: Readonly<Record<string, string>> = {
  a: "\u0007",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

/** A path as git prints it in a patch, C-quoted when it has odd bytes. */
const unquote = (raw: string): string => {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) {
    return raw;
  }
  const latin1 = raw
    .slice(1, -1)
    .replaceAll(/\\(?<escaped>[0-7]{3}|.)/gu, (_match, escaped: string) =>
      /^[0-7]{3}$/u.test(escaped)
        ? String.fromCodePoint(Number.parseInt(escaped, 8))
        : (C_ESCAPES[escaped] ?? escaped),
    );
  return Buffer.from(latin1, "latin1").toString("utf8");
};

/** `b/path` → `path`, as `git apply -p1` reads it. */
const stripPrefix = (raw: string): string => {
  const path = unquote(raw.trim());
  const slash = path.indexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
};

const named = (match: RegExpExecArray): string => match.groups?.["p"] ?? "";

/** Header lines that matter, and what each says about the file. */
const HEADER_RULES: readonly (readonly [
  RegExp,
  (change: FileChange, match: RegExpExecArray) => void,
])[] = [
  [
    /^new file mode 120000$/u,
    (c) => {
      c.symlink = true;
    },
  ],
  [
    /^new mode 120000$/u,
    (c) => {
      c.symlink = true;
      c.modeOnly = true;
    },
  ],
  [
    /^index [0-9a-f]+\.\.[0-9a-f]+ 120000$/u,
    (c) => {
      c.symlink = true;
    },
  ],
  [
    /^deleted file mode /u,
    (c) => {
      c.deleted = true;
    },
  ],
  [
    /^\+\+\+ (?<p>.*)$/u,
    (c, m) => {
      const raw = named(m);
      if (raw.trim() === "/dev/null") {
        c.deleted = true;
      } else {
        c.path = stripPrefix(raw);
      }
    },
  ],
  [
    /^--- (?<p>.*)$/u,
    (c, m) => {
      const raw = named(m);
      c.oldPath = raw.trim() === "/dev/null" ? undefined : stripPrefix(raw);
    },
  ],
  [
    /^(?:rename|copy) to (?<p>.*)$/u,
    (c, m) => {
      c.path = unquote(named(m));
    },
  ],
  [
    /^(?:rename|copy) from (?<p>.*)$/u,
    (c, m) => {
      c.from = unquote(named(m));
    },
  ],
  [
    /^(?:GIT binary patch$|Binary files )/u,
    (c) => {
      c.binary = true;
    },
  ],
  [
    /^@@/u,
    (c) => {
      c.inHunk = true;
      c.modeOnly = false;
    },
  ],
];

const applyHeaderLine = (change: FileChange, line: string): void => {
  for (const [pattern, apply] of HEADER_RULES) {
    const match = pattern.exec(line);
    if (match !== null) {
      apply(change, match);
      return;
    }
  }
};

/** Consumes a hunk line; `false` once the hunk has ended. */
const applyHunkLine = (change: FileChange, line: string): boolean => {
  if (/^[+ ]/u.test(line)) {
    change.newLines.push(line.slice(1));
  }
  return /^(?:[+\- \\]|@@)/u.test(line);
};

/** Each file's section of one patch (a `format-patch` file or a diff). */
export const parsePatch = (patch: string): FileChange[] => {
  const changes: FileChange[] = [];
  let current: FileChange | undefined;
  for (const raw of patch.split("\n")) {
    const line = raw.replace(/\r$/u, "");
    if (line.startsWith("diff --git ")) {
      current = newChange();
      changes.push(current);
    } else if (current !== undefined) {
      const stillInHunk = current.inHunk && applyHunkLine(current, line);
      if (!stillInHunk) {
        current.inHunk = false;
        applyHeaderLine(current, line);
      }
    }
  }
  return changes;
};
