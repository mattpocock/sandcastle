import { lstatSync } from "node:fs";

// Prettier refuses to format symbolic links (e.g. the AGENTS.md -> CLAUDE.md
// and .claude/skills -> ../.agents/skills symlinks), which would otherwise
// fail the pre-commit hook on any commit that stages them. Filter symlinks
// out before handing paths to prettier.
const formattable = (files) =>
  files.filter((file) => !lstatSync(file).isSymbolicLink());

export default {
  "*.{ts,tsx,js,jsx,json,md}": (files) => {
    const real = formattable(files);
    if (real.length === 0) {
      return [];
    }
    return `prettier --write ${real.map((f) => JSON.stringify(f)).join(" ")}`;
  },
};
