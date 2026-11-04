import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Resolves `file` against `work/`, refusing anything outside the sandbox `dir`. */
const contained = (dir: string, file: string): string => {
  const resolved = path.resolve(path.join(dir, "work"), file);
  const relative = path.relative(dir, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`fakeSandbox: ${file} is outside the sandbox (${dir})`);
  }
  return resolved;
};

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/** Reads a text file in a fake sandbox, or `null` when it doesn't exist. */
export const readSandboxFile = async (
  dir: string,
  file: string,
): Promise<string | null> => {
  const resolved = contained(dir, file);
  return readFile(resolved, "utf8").catch((error: unknown) => {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  });
};

/** Writes a text file in a fake sandbox, creating parent directories. */
export const writeSandboxFile = async (
  dir: string,
  file: string,
  content: string,
) => {
  const resolved = contained(dir, file);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, content);
};
