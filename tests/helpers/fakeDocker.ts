import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// The fake `docker` CLI (tests/helpers/fakeDockerCli.ts) first on PATH, for
// tests of the v1 docker() provider that run no real engine. POSIX only.

/** Failures the fake can be asked for. */
export interface FakeDockerFaults {
  /** Every call fails as a CLI whose daemon is down does. */
  readonly daemonDown?: boolean;
  /**
   * `"run"`: `run` makes the container, then fails. Any other string: an
   * `exec` whose command contains it fails before it runs.
   */
  readonly execFails?: string;
}

export interface FakeDocker {
  /** Where its containers live: `<root>/containers/<id>`. */
  readonly root: string;
  /** The argv of every call so far, verb first. */
  readonly calls: () => Promise<string[][]>;
  /** The argv of every call of `verb` so far, verb first. */
  readonly callsOf: (verb: string) => Promise<string[][]>;
  /** Each `--env-file` a call was given, and whether it is still there. */
  readonly envFiles: () => Promise<{ file: string; exists: boolean }[]>;
  /** The argv of the last `docker run`, verb first. */
  readonly lastRun: () => Promise<string[]>;
  /** The ids of the containers still standing. */
  readonly containers: () => Promise<string[]>;
  /** Asks for failures from the next call on. */
  readonly fault: (faults: FakeDockerFaults) => Promise<void>;
  /** Removes every container (killing what it runs), the fake, and restores PATH. */
  readonly cleanup: () => Promise<void>;
}

const CLI = path.join(import.meta.dirname, "fakeDockerCli.ts");

const isArgv = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const removeContainer = async (wrapper: string, id: string): Promise<void> => {
  await new Promise<void>((resolve) => {
    execFile(wrapper, ["rm", "-f", id], () => {
      resolve();
    });
  });
};

/** Puts a fresh fake `docker` first on this process's PATH (inherited by its children). */
export const installFakeDocker = async (): Promise<FakeDocker> => {
  const root = await mkdtemp(path.join(tmpdir(), "sandcastle-fake-docker-"));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const wrapper = path.join(bin, "docker");
  await writeFile(
    wrapper,
    `#!/bin/sh\nFAKE_DOCKER_ROOT='${root}' exec '${process.execPath}' --no-warnings '${CLI}' "$@"\n`,
  );
  await chmod(wrapper, 0o755);
  const originalPath = process.env["PATH"];
  process.env["PATH"] = `${bin}${path.delimiter}${originalPath ?? ""}`;

  const calls = async (): Promise<string[][]> => {
    const text = await readFile(path.join(root, "calls.jsonl"), "utf8").catch(
      () => "",
    );
    return text
      .split("\n")
      .filter((line) => line !== "")
      .map((line): unknown => JSON.parse(line))
      .filter((argv) => isArgv(argv));
  };
  const containers = async (): Promise<string[]> =>
    readdir(path.join(root, "containers")).catch((): string[] => []);
  const callsOf = async (verb: string): Promise<string[][]> => {
    const all = await calls();
    return all.filter(([called]) => called === verb);
  };
  return {
    root,
    calls,
    callsOf,
    envFiles: async () => {
      const all = await calls();
      const files = all.flatMap((argv) => {
        const at = argv.indexOf("--env-file");
        return at === -1 ? [] : [argv[at + 1] ?? ""];
      });
      return Promise.all(
        files.map(async (file) => ({
          file,
          exists: await access(file).then(
            () => true,
            () => false,
          ),
        })),
      );
    },
    lastRun: async () => {
      const runs = await callsOf("run");
      const last = runs.at(-1);
      if (last === undefined) {
        throw new Error("docker run was not called");
      }
      return last;
    },
    containers,
    fault: async (faults) => {
      await writeFile(path.join(root, "faults.json"), JSON.stringify(faults));
    },
    cleanup: async () => {
      process.env["PATH"] = originalPath;
      await rm(path.join(root, "faults.json"), { force: true });
      const left = await containers();
      await Promise.all(left.map(async (id) => removeContainer(wrapper, id)));
      await rm(root, { recursive: true, force: true });
    },
  };
};
