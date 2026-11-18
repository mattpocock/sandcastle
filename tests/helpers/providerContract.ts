import { posix, win32 } from "node:path";
import { expect, test } from "vitest";
import type { Sandbox } from "@ai-hero/sandcastle/v1";
import { ExecFailedError } from "@ai-hero/sandcastle/v1";

// The Sandbox contract every provider honours, as tests a provider's
// own suite registers inside its describe: `providerContract(open)`, where
// `open` makes a fresh sandbox (the suite's afterEach closes it) whose
// commands get `env`. Each check runs through `createSandbox`, so it holds
// whether the provider or Sandcastle does the work.
//
// Its commands are `node -e` scripts in single quotes, a simple command
// every provider runs unchanged: through `sh` on a POSIX sandbox, and
// spawned from its argv by host() on Windows, which has no `sh`.

/** The value the redaction check puts in the sandbox's env. */
export const CONTRACT_SECRET = "contract-secret-0123456789";

/** Makes a sandbox for one check, its commands getting `env`. */
export type OpenSandbox = (
  env: Readonly<Record<string, string>>,
) => Promise<Sandbox>;

/** `node -e` running `script`, which must not hold a single quote. */
const node = (script: string): string => `node -e '${script}'`;

/** Writes `content` to `file`, making its folder: `mkdir -p` and `printf`, portably. */
const writeFileCommand = (file: string, content: string): string =>
  node(
    `const fs = require("node:fs"); fs.mkdirSync(require("node:path").dirname("${file}"), { recursive: true }); fs.writeFileSync("${file}", "${content}")`,
  );

/** Prints `file`: `cat`, portably. */
const catCommand = (file: string): string =>
  node(
    `process.stdout.write(require("node:fs").readFileSync("${file}", "utf8"))`,
  );

/** `child` joined onto the absolute `directory`, in that path's flavour. */
const joinTo = (directory: string, child: string): string =>
  win32.isAbsolute(directory) && !posix.isAbsolute(directory)
    ? win32.join(directory, child)
    : posix.join(directory, child);

/** The error `exec` rejected with; fails the test if it resolved. */
const failureOf = async (pending: Promise<unknown>): Promise<Error> => {
  const outcome: unknown = await pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof Error)) {
    throw new TypeError("exec didn't reject");
  }
  return outcome;
};

export const providerContract = (open: OpenSandbox): void => {
  test("contract: a relative workingDirectory on exec resolves against the sandbox's working directory", async () => {
    const sandbox = await open({});
    await sandbox.exec(writeFileCommand("clone/nested/marker", "here"));

    const relative = await sandbox.exec({
      command: catCommand("marker"),
      workingDirectory: "clone/nested",
    });
    const dotted = await sandbox.exec({
      command: catCommand("nested/marker"),
      workingDirectory: "./clone",
    });

    expect(relative.stdout).toBe("here");
    expect(dotted.stdout).toBe("here");
  });

  test("contract: an absolute workingDirectory on exec is used as it is", async () => {
    const sandbox = await open({});
    await sandbox.exec(writeFileCommand("clone/marker", "here"));

    const result = await sandbox.exec({
      command: catCommand("marker"),
      workingDirectory: joinTo(sandbox.workingDirectory, "clone"),
    });

    expect(result.stdout).toBe("here");
  });

  test("contract: relative file paths resolve against the sandbox's working directory", async () => {
    const sandbox = await open({});
    await sandbox.writeTextFile({ path: "notes/a.txt", content: "written" });

    await expect(
      sandbox.exec(catCommand("notes/a.txt")),
    ).resolves.toMatchObject({
      stdout: "written",
    });
    await expect(sandbox.readTextFile({ path: "./notes/a.txt" })).resolves.toBe(
      "written",
    );
  });

  test("contract: a failed exec says why in its message, with the sandbox's env values redacted", async () => {
    const sandbox = await open({ CONTRACT_TOKEN: CONTRACT_SECRET });

    const error = await failureOf(
      sandbox.exec({
        command: node(
          String.raw`process.stderr.write("fatal: no such ref, token " + process.env.CONTRACT_TOKEN + " " + process.env.STEP_TOKEN + "\n"); process.exitCode = 4`,
        ),
        env: { STEP_TOKEN: "step-secret-9876543210" },
      }),
    );

    expect(error).toBeInstanceOf(ExecFailedError);
    expect(error.message).toContain("Command exited with code 4");
    expect(error.message).toContain(
      "fatal: no such ref, token [REDACTED] [REDACTED]",
    );
    expect(error.message).not.toContain(CONTRACT_SECRET);
    expect(error.message).not.toContain("step-secret-9876543210");
  });

  test("contract: a failed exec's message keeps only the tail of a long stderr", async () => {
    const sandbox = await open({});

    const error = await failureOf(
      sandbox.exec(
        node(
          String.raw`for (let i = 0; i < 500; i++) process.stderr.write("noise line " + i + "\n"); process.stderr.write("the real " + (40 + 2) + " cause\n"); process.exitCode = 2`,
        ),
      ),
    );
    expect(error.message).toContain("the real 42 cause");
    expect(error.message).not.toContain("noise line 0\n");
    expect(error.message.length).toBeLessThan(3000);
  });
};
