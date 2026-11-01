export const parseDiffLines = (diff: string): Map<string, Set<number>> => {
  const files = new Map<string, Set<number>>();
  let currentFile: string | undefined;
  let newLine = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice("+++ b/".length);
      if (!files.has(currentFile)) {
        files.set(currentFile, new Set());
      }
      continue;
    }

    if (currentFile === undefined || currentFile === "") {
      continue;
    }

    const hunkStart = /^@@ -\d+(?:,\d+)? \+(?<start>\d+)(?:,\d+)? @@/u.exec(
      line,
    )?.groups?.start;
    if (hunkStart !== undefined) {
      newLine = Number(hunkStart);
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      files.get(currentFile)?.add(newLine);
      newLine++;
      continue;
    }

    if (line.startsWith(" ") || line === "") {
      files.get(currentFile)?.add(newLine);
      newLine++;
    }
  }

  return files;
};
