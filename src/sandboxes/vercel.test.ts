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

const sandboxCreate = vi.hoisted(() =>
  vi
    .fn<
      (
        params: Record<string, unknown>,
      ) => Promise<{ mkDir: () => Promise<void> }>
    >()
    .mockResolvedValue({ mkDir: async () => {} }),
);

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
