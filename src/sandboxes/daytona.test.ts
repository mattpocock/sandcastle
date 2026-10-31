import { beforeEach, describe, expect, it, vi } from "vitest";

// A fake @daytona/sdk modelling the default snapshot: the work dir is the
// `daytona` user's home, /home/daytona, whose parent (/home) it can't write.
const sdk = vi.hoisted(() => ({
  createParams: [] as unknown[],
  createdFolders: [] as string[],
}));

vi.mock("@daytona/sdk", () => {
  class Daytona {
    async create(params: unknown) {
      sdk.createParams.push(params);
      return {
        getWorkDir: async () => "/home/daytona",
        getUserHomeDir: async () => "/home/daytona",
        fs: {
          createFolder: async (path: string) => {
            sdk.createdFolders.push(path);
          },
        },
        process: {},
      };
    }
    async delete() {}
  }
  return { Daytona };
});

import { daytona } from "./daytona.js";

beforeEach(() => {
  sdk.createParams.length = 0;
  sdk.createdFolders.length = 0;
});

describe("daytona()", () => {
  it("returns an isolated provider named 'daytona'", () => {
    const provider = daytona();
    expect(provider.tag).toBe("isolated");
    expect(provider.name).toBe("daytona");
  });

  it("puts the worktree in a subdirectory of the work dir, so sync-in can replace it", async () => {
    // syncIn clones into `${worktreePath}_clone` and then replaces
    // worktreePath, so worktreePath's parent must be writable by the
    // sandbox user. On the default snapshot only the home dir is.
    const handle = await daytona().create({ env: {} });

    expect(handle.worktreePath).toBe("/home/daytona/workspace");
    expect(sdk.createdFolders).toContain("/home/daytona/workspace");
  });

  it("passes the resolved env to the sandbox as envVars", async () => {
    await daytona().create({ env: { CLAUDE_CODE_OAUTH_TOKEN: "t", FOO: "1" } });

    expect(sdk.createParams[0]).toMatchObject({
      envVars: { CLAUDE_CODE_OAUTH_TOKEN: "t", FOO: "1" },
    });
  });

  it("keeps the user's create options and merges their envVars", async () => {
    await daytona({
      create: {
        ephemeral: true,
        labels: { a: "b" },
        envVars: { USER_VAR: "u", FOO: "from-create" },
      },
    }).create({ env: { FOO: "resolved", BAR: "2" } });

    expect(sdk.createParams[0]).toEqual({
      ephemeral: true,
      labels: { a: "b" },
      envVars: { USER_VAR: "u", FOO: "from-create", BAR: "2" },
    });
  });
});
