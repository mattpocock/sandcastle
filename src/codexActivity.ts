// Executed inside the sandbox (also works for the no-sandbox provider).
// Inspect metadata only: never send transcript/reasoning content to stdout.
const probe = `
const { readdir, stat } = require("node:fs/promises");
const { join } = require("node:path");
const { homedir } = require("node:os");
const [id, override] = process.argv.slice(1);
const root = override || join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
async function locate(dir, depth) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const matches = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith("-" + id + ".jsonl"))
      matches.push(join(dir, entry.name));
    else if (depth && entry.isDirectory())
      matches.push(...await locate(join(dir, entry.name), depth - 1));
  }
  return matches;
}
(async () => {
  const matches = await locate(root, 3);
  if (matches.length !== 1) return;
  const file = await stat(matches[0]);
  if (file.isFile()) process.stdout.write(String(file.size));
})().catch(() => { process.exitCode = 1; });
`;

/** Build the Codex-only, metadata-only probe for one exact rollout id. */
export const codexActivityCommand = (
  sessionId: string,
  sessionsDir: string | undefined,
): string => {
  const quote = (text: string) => "'" + text.replace(/'/g, "'\\''") + "'";
  return `node -e ${quote(probe)} ${quote(sessionId)} ${quote(sessionsDir ?? "")}`;
};
