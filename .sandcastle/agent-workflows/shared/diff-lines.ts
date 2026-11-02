const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(?<start>\d+)(?:,\d+)? @@/u;

/** Whether a hunk line is in the new file: an addition or a context line. */
const isNewFileLine = (line: string): boolean =>
  (line.startsWith("+") && !line.startsWith("+++")) ||
  line.startsWith(" ") ||
  line === "";

/** The line set for `file`, created on first sight. */
const linesOf = (
  files: Map<string, Set<number>>,
  file: string,
): Set<number> => {
  const existing = files.get(file);
  if (existing !== undefined) {
    return existing;
  }
  const lines = new Set<number>();
  files.set(file, lines);
  return lines;
};

export const parseDiffLines = (diff: string): Map<string, Set<number>> => {
  const files = new Map<string, Set<number>>();
  let currentLines: Set<number> | undefined;
  let newLine = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      const currentFile = line.slice("+++ b/".length);
      const lines = linesOf(files, currentFile);
      currentLines = currentFile === "" ? undefined : lines;
      continue;
    }

    if (currentLines === undefined) {
      continue;
    }

    const hunkStart = HUNK_HEADER.exec(line)?.groups?.start;
    if (hunkStart !== undefined) {
      newLine = Number(hunkStart);
    } else if (isNewFileLine(line)) {
      currentLines.add(newLine);
      newLine++;
    }
  }

  return files;
};
