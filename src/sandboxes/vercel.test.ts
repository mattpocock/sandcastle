import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Writable } from "node:stream";
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { vercel } from "./vercel.js";

// A fake @vercel/sandbox modelling Vercel's default image: the user's
// home is /vercel, and /vercel/sandbox doesn't exist. `mkDir` isn't recursive,
// as on Vercel; a `mkdir -p` command creates the parents.
//
// Other commands run in a real local `sh` with no stdin, as `runCommand`
// gives none: the command reads EOF. Streamed output is written to the given
// streams, which are not ended (as observed with SDK 3.9.1). `writeFiles`
// writes the file where a command can read it.
const fs = vi.hoisted(() => ({ dirs: new Set<string>() }));
const sdk = vi.hoisted(() => ({ writtenPaths: [] as string[] }));

interface FakeResult {
  exitCode: number | null;
  stdout: () => Promise<string>;
  stderr: () => Promise<string>;
}

interface FakeRunCommandParams {
  cmd: string;
  args?: string[];
  cwd?: string;
  stdout?: Writable;
  stderr?: Writable;
}

interface FakeSandbox {
  mkDir: (path: string) => Promise<void>;
  writeFiles: (files: { path: string; content: Uint8Array }[]) => Promise<void>;
  runCommand: (params: FakeRunCommandParams) => Promise<FakeResult>;
  stop?: () => Promise<void>;
}

const sandboxCreate = vi.hoisted(() =>
  vi.fn<(params: Record<string, unknown>) => Promise<FakeSandbox>>(async () => {
    const { spawnSync } = await import("node:child_process");
    const { writeFileSync } = await import("node:fs");
    const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
    return {
      mkDir: async (path: string) => {
        if (!fs.dirs.has(parentOf(path))) {
          throw new Error(
            "Status code 400 is not ok: error creating directory: No such file or directory",
          );
        }
        fs.dirs.add(path);
      },
      writeFiles: async (files: { path: string; content: Uint8Array }[]) => {
        for (const file of files) {
          sdk.writtenPaths.push(file.path);
          writeFileSync(file.path, file.content);
        }
      },
      runCommand: async (params: FakeRunCommandParams) => {
        const [flag, target] = params.args ?? [];
        if (params.cmd === "mkdir" && flag === "-p" && target !== undefined) {
          for (let path = target; path !== ""; path = parentOf(path)) {
            fs.dirs.add(path);
          }
          return {
            exitCode: 0,
            stdout: async () => "",
            stderr: async () => "",
          };
        }
        const r = spawnSync(params.cmd, params.args ?? [], {
          cwd: params.cwd,
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
        });
        const write = async (stream: Writable | undefined, text: string) =>
          new Promise<void>((resolve) => {
            if (stream === undefined || text === "") {
              resolve();
              return;
            }
            stream.write(text, () => {
              resolve();
            });
          });
        await write(params.stdout, r.stdout);
        await write(params.stderr, r.stderr);
        return {
          exitCode: r.status,
          stdout: async () => r.stdout,
          stderr: async () => r.stderr,
        };
      },
    };
  }),
);

beforeEach(() => {
  fs.dirs = new Set(["/vercel"]);
});

vi.mock("@vercel/sandbox", () => ({
  Sandbox: { create: sandboxCreate },
}));

describe("vercel()", () => {
  it("returns a SandboxProvider with tag 'isolated' and name 'vercel'", () => {
    const provider = vercel();
    expect(provider.tag).toBe("isolated");
    expect(provider.name).toBe("vercel");
  });

  it("has a create function", () => {
    const provider = vercel();
    expect(provider.create).toBeTypeOf("function");
  });

  it("accepts a token option", () => {
    // Should not throw
    const provider = vercel({ token: "my-token" });
    expect(provider.tag).toBe("isolated");
  });

  it("passes through Vercel SDK options", () => {
    // Should not throw when arbitrary SDK options are provided
    const provider = vercel({
      template: "node-22",
      timeoutMs: 30_000,
    });
    expect(provider.tag).toBe("isolated");
  });

  it("accepts an env option", () => {
    const provider = vercel({ env: { VERCEL_VAR: "value" } });
    expect(provider.tag).toBe("isolated");
    expect(provider.env).toStrictEqual({ VERCEL_VAR: "value" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = vercel();
    expect(provider.env).toStrictEqual({});
  });
});

describe("vercel() setup", () => {
  beforeEach(() => {
    sandboxCreate.mockClear();
    vi.stubEnv("VERCEL_TOKEN", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates the worktree folder on a runtime with no /vercel/sandbox", async () => {
    const handle = await vercel().create({ env: {} });

    expect(handle.worktreePath).toBe("/vercel/sandbox/workspace");
    expect(fs.dirs.has("/vercel/sandbox/workspace")).toBe(true);
  });

  it("leaves the runtime unset by default, so Vercel uses its default image, which ships the claude CLI", async () => {
    await vercel().create({ env: {} });

    expect(sandboxCreate.mock.lastCall?.[0]).not.toHaveProperty("runtime");
  });

  it("passes the runtime option, then the template alias", async () => {
    await vercel({ runtime: "node22", template: "python3.13" }).create({
      env: {},
    });
    await vercel({ template: "python3.13" }).create({ env: {} });

    expect(sandboxCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ runtime: "node22" }),
    );
    expect(sandboxCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ runtime: "python3.13" }),
    );
  });
});

describe("vercel() when setup fails inside create()", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL_TOKEN", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const failingSandbox = (setupError: Error, stop: () => Promise<void>) =>
    ({
      mkDir: async () => {},
      writeFiles: async () => {},
      runCommand: async () => {
        throw setupError;
      },
      stop,
    }) satisfies FakeSandbox;

  it("stops the sandbox it created, then rethrows", async () => {
    const stop = vi.fn<() => Promise<void>>(async () => {});
    const setupError = new Error("error creating directory");
    sandboxCreate.mockImplementationOnce(async () =>
      failingSandbox(setupError, stop),
    );

    await expect(vercel().create({ env: {} })).rejects.toBe(setupError);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("stops the sandbox when mkdir exits non-zero", async () => {
    const stop = vi.fn<() => Promise<void>>(async () => {});
    sandboxCreate.mockImplementationOnce(async () => ({
      mkDir: async () => {},
      writeFiles: async () => {},
      runCommand: async () => ({
        exitCode: 1,
        stdout: async () => "",
        stderr: async () => "mkdir: permission denied",
      }),
      stop,
    }));

    await expect(vercel().create({ env: {} })).rejects.toThrow(
      /could not create .*permission denied/,
    );
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("rethrows the setup error even when stopping fails too", async () => {
    const setupError = new Error("error creating directory");
    sandboxCreate.mockImplementationOnce(async () =>
      failingSandbox(setupError, async () => {
        throw new Error("stop failed");
      }),
    );

    await expect(vercel().create({ env: {} })).rejects.toBe(setupError);
  });
});

describe("vercel() auth from the environment", () => {
  const AUTH_KEYS = [
    "VERCEL_TOKEN",
    "VERCEL_TEAM_ID",
    "VERCEL_PROJECT_ID",
    "VERCEL_OIDC_TOKEN",
  ] as const;

  beforeEach(() => {
    sandboxCreate.mockClear();
    for (const key of AUTH_KEYS) {
      vi.stubEnv(key, undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const createdWith = async (options?: Parameters<typeof vercel>[0]) => {
    await vercel(options).create({ env: {} });
    expect(sandboxCreate).toHaveBeenCalledTimes(1);
    const [call] = sandboxCreate.mock.calls;
    assert.isDefined(call);
    return call[0];
  };

  it("passes VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID from the environment", async () => {
    vi.stubEnv("VERCEL_TOKEN", "env-token");
    vi.stubEnv("VERCEL_TEAM_ID", "team_env");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_env");

    const params = await createdWith();

    expect(params).toMatchObject({
      token: "env-token",
      teamId: "team_env",
      projectId: "prj_env",
    });
  });

  it("prefers explicit options over the environment", async () => {
    vi.stubEnv("VERCEL_TOKEN", "env-token");
    vi.stubEnv("VERCEL_TEAM_ID", "team_env");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_env");

    const params = await createdWith({
      token: "opt-token",
      teamId: "team_opt",
      projectId: "prj_opt",
    });

    expect(params).toMatchObject({
      token: "opt-token",
      teamId: "team_opt",
      projectId: "prj_opt",
    });
  });

  it("fills a missing team or project id from the environment when a token is passed", async () => {
    vi.stubEnv("VERCEL_TEAM_ID", "team_env");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_env");

    const params = await createdWith({ token: "opt-token" });

    expect(params).toMatchObject({
      token: "opt-token",
      teamId: "team_env",
      projectId: "prj_env",
    });
  });

  it("names the missing variables when VERCEL_TOKEN is set without team and project ids", async () => {
    vi.stubEnv("VERCEL_TOKEN", "env-token");

    await expect(vercel().create({ env: {} })).rejects.toThrow(
      /VERCEL_TEAM_ID.*VERCEL_PROJECT_ID/,
    );
    expect(sandboxCreate).not.toHaveBeenCalled();
  });

  it("names only VERCEL_PROJECT_ID when the team id is set", async () => {
    vi.stubEnv("VERCEL_TOKEN", "env-token");
    vi.stubEnv("VERCEL_TEAM_ID", "team_env");

    const failure = await vercel()
      .create({ env: {} })
      .catch((error: unknown) => error);

    assert.instanceOf(failure, Error);
    expect(failure.message).toContain("VERCEL_PROJECT_ID");
    expect(failure.message).not.toContain("VERCEL_TEAM_ID");
    expect(failure.message).not.toContain("env-token");
  });

  it("leaves auth to the SDK's OIDC flow when no token is available", async () => {
    vi.stubEnv("VERCEL_OIDC_TOKEN", "oidc");

    const params = await createdWith();

    expect(params).not.toHaveProperty("token");
    expect(params).not.toHaveProperty("teamId");
    expect(params).not.toHaveProperty("projectId");
  });
});

describe("vercel() exec", () => {
  const cwd = tmpdir();
  const prompt = "Create a file named a.txt\nwith 'quotes' and $HOME, verbatim";

  beforeEach(() => {
    sdk.writtenPaths.length = 0;
    vi.stubEnv("VERCEL_TOKEN", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("delivers stdin to the command", async () => {
    const handle = await vercel().create({ env: {} });

    const result = await handle.exec("cat", { cwd, stdin: prompt });

    expect(result).toMatchObject({ exitCode: 0, stdout: prompt });
  });

  it("delivers stdin to a streamed command", async () => {
    const handle = await vercel().create({ env: {} });
    const lines: string[] = [];

    const result = await handle.exec("cat", {
      cwd,
      stdin: `${prompt}\n`,
      onLine: (line) => {
        lines.push(line);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(lines).toStrictEqual(prompt.split("\n"));
  });

  it("delivers stdin to every command of a compound command", async () => {
    const handle = await vercel().create({ env: {} });

    const result = await handle.exec("echo first && cat", {
      cwd,
      stdin: prompt,
    });

    expect(result.stdout).toBe(`first\n${prompt}`);
  });

  it("removes the stdin file once the command has run", async () => {
    const handle = await vercel().create({ env: {} });

    await handle.exec("cat", { cwd, stdin: prompt });
    await handle.exec("cat", { cwd, stdin: prompt, onLine: () => {} });

    expect(sdk.writtenPaths).toHaveLength(2);
    for (const path of sdk.writtenPaths) {
      expect(existsSync(path)).toBe(false);
    }
  });

  it("writes no stdin file when there is no stdin", async () => {
    const handle = await vercel().create({ env: {} });

    const result = await handle.exec("echo ok", { cwd });

    expect(result.stdout).toBe("ok\n");
    expect(sdk.writtenPaths).toHaveLength(0);
  });
});
