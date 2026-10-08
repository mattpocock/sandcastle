import { randomUUID } from "node:crypto";

export const createStdinFilePath = (): string =>
  `/tmp/sandcastle-stdin-${randomUUID()}`;

interface StdinFileOperations {
  readonly upload: (path: string, content: Buffer) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
}

export const withStdinFile = async <T>(
  stdin: string | undefined,
  operations: StdinFileOperations,
  run: (stdinPath: string | undefined) => Promise<T>,
): Promise<T> => {
  if (stdin === undefined) return run(undefined);

  const stdinPath = createStdinFilePath();
  try {
    await operations.upload(stdinPath, Buffer.from(stdin));
    return await run(stdinPath);
  } finally {
    await operations.remove(stdinPath).catch(() => {});
  }
};

const shellEscape = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;

export const redirectCommandStdinFromFile = (
  command: string,
  stdinPath: string,
): string =>
  `chmod 600 ${shellEscape(stdinPath)} && sh -c ${shellEscape(command)} < ${shellEscape(stdinPath)}`;

export const removeStdinFileCommand = (stdinPath: string): string =>
  `rm -f -- ${shellEscape(stdinPath)}`;
