import { posix } from "node:path";
import { expect, test } from "vitest";
import type { Sandbox } from "@ai-hero/sandcastle/v1";
import { ExecFailedError } from "@ai-hero/sandcastle/v1";

// The Sandbox contract every provider honours, as tests a provider's
// own suite registers inside its describe: `providerContract(open)`, where
// `open` makes a fresh sandbox (the suite's afterEach closes it) whose
// commands get `env`. Each check runs through `createSandbox`, so it holds
// whether the provider or Sandcastle does the work.

/** The value the redaction check puts in the sandbox's env. */
export const CONTRACT_SECRET = "contract-secret-0123456789";

/** Makes a sandbox for one check, its commands getting `env`. */
export type OpenSandbox = (
  env: Readonly<Record<string, string>>,
) => Promise<Sandbox>;

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
    await sandbox.exec(
      "mkdir -p clone/nested && printf here > clone/nested/marker",
    );

    const relative = await sandbox.exec({
      command: "cat marker",
      workingDirectory: "clone/nested",
    });
    const dotted = await sandbox.exec({
      command: "cat nested/marker",
      workingDirectory: "./clone",
    });

    expect(relative.stdout).toBe("here");
    expect(dotted.stdout).toBe("here");
  });

  test("contract: an absolute workingDirectory on exec is used as it is", async () => {
    const sandbox = await open({});
    await sandbox.exec("mkdir -p clone && printf here > clone/marker");

    const result = await sandbox.exec({
      command: "cat marker",
      workingDirectory: posix.join(sandbox.workingDirectory, "clone"),
    });

    expect(result.stdout).toBe("here");
  });

  test("contract: relative file paths resolve against the sandbox's working directory", async () => {
    const sandbox = await open({});
    await sandbox.exec("mkdir -p notes");

    await sandbox.writeTextFile({ path: "notes/a.txt", content: "written" });

    await expect(sandbox.exec("cat notes/a.txt")).resolves.toMatchObject({
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
        command:
          'echo "fatal: no such ref, token $CONTRACT_TOKEN $STEP_TOKEN" >&2; exit 4',
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
        'i=0; while [ $i -lt 500 ]; do echo "noise line $i" >&2; i=$((i+1)); done; echo "the real $((40+2)) cause" >&2; exit 2',
      ),
    );
    expect(error.message).toContain("the real 42 cause");
    expect(error.message).not.toContain("noise line 0\n");
    expect(error.message.length).toBeLessThan(3000);
  });
};
