import { describe, expect, it } from "vitest";
import type {
  ProviderCreateOptions,
  ProviderExecOptions,
  ProviderSandbox,
} from "@ai-hero/sandcastle/v1";
import {
  CreateSandboxError,
  createSandbox,
  createSandboxProvider,
} from "@ai-hero/sandcastle/v1";

// createSandbox() through a provider built with the public contract. The fake
// provider's tests (v1-fakeSandbox.test.ts) cover real processes and files.

interface Recorded {
  readonly creates: ProviderCreateOptions[];
  readonly execs: ProviderExecOptions[];
  closes: number;
}

const recordingSandbox = (
  recorded: Recorded,
  overrides: Partial<ProviderSandbox<{ readonly vendor: string }>> = {},
): ProviderSandbox<{ readonly vendor: string }> => ({
  sandboxId: "sbx-1",
  workingDirectory: "/work",
  killTime: new Date("2030-01-01T00:00:00Z"),
  native: { vendor: "recording" },
  exec: async (options) => {
    recorded.execs.push(options);
    return { exitCode: 0, stdout: "", stderr: "" };
  },
  readTextFile: async () => null,
  writeTextFile: async () => undefined,
  close: async () => {
    recorded.closes += 1;
  },
  ...overrides,
});

const recordingProvider = (
  overrides: Partial<ProviderSandbox<{ readonly vendor: string }>> = {},
) => {
  const recorded: Recorded = { creates: [], execs: [], closes: 0 };
  const provider = createSandboxProvider({
    name: "recording",
    create: async (options) => {
      recorded.creates.push(options);
      return recordingSandbox(recorded, overrides);
    },
  });
  return { provider, recorded };
};

describe("createSandbox (v1)", () => {
  it("hands the provider exactly the env and time limit it was given", async () => {
    const { provider, recorded } = recordingProvider();

    await createSandbox({
      provider,
      env: { GH_TOKEN: "t" },
      timeLimitMinutes: 15,
    });

    expect(recorded.creates).toHaveLength(1);
    expect(recorded.creates[0]?.env).toStrictEqual({ GH_TOKEN: "t" });
    expect(recorded.creates[0]?.timeLimitMinutes).toBe(15);
  });

  it("defaults to no env and a 60-minute time limit", async () => {
    const { provider, recorded } = recordingProvider();

    await createSandbox({ provider });

    expect(recorded.creates[0]?.env).toStrictEqual({});
    expect(recorded.creates[0]?.timeLimitMinutes).toBe(60);
  });

  it("exposes the provider's id, directory, kill time and vendor object", async () => {
    const { provider } = recordingProvider();

    const sandbox = await createSandbox({ provider });

    expect(sandbox.sandboxId).toBe("sbx-1");
    expect(sandbox.workingDirectory).toBe("/work");
    expect(sandbox.killTime).toStrictEqual(new Date("2030-01-01T00:00:00Z"));
    expect(sandbox.native.vendor).toBe("recording");
    expect(sandbox.canDetach).toBe(false);
  });

  it("passes exec options through to the provider", async () => {
    const { provider, recorded } = recordingProvider();
    const sandbox = await createSandbox({ provider });

    await sandbox.exec({
      command: "make",
      workingDirectory: "sub",
      env: { ONLY: "this" },
      sudo: true,
    });

    expect(recorded.execs[0]).toMatchObject({
      command: "make",
      workingDirectory: "sub",
      env: { ONLY: "this" },
      sudo: true,
    });
  });

  it("rejects with CreateSandboxError when the provider's create throws", async () => {
    const provider = createSandboxProvider({
      name: "broken",
      create: async () => {
        throw new Error("quota exceeded");
      },
    });

    const error: unknown = await createSandbox({ provider }).catch(
      (error_: unknown) => error_,
    );

    expect(error).toBeInstanceOf(CreateSandboxError);
    expect(error).toHaveProperty(
      "message",
      expect.stringContaining("quota exceeded"),
    );
    expect(error).not.toHaveProperty("sandboxId");
  });

  it("closes what it made when creation is aborted after the provider created it", async () => {
    const controller = new AbortController();
    const recorded: Recorded = { creates: [], execs: [], closes: 0 };
    const provider = createSandboxProvider({
      name: "aborting",
      create: async () => {
        controller.abort();
        return recordingSandbox(recorded);
      },
    });

    const error: unknown = await createSandbox({
      provider,
      abortSignal: controller.signal,
    }).catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(CreateSandboxError);
    expect(error).toHaveProperty("sandboxId", "sbx-1");
    expect(recorded.closes).toBe(1);
  });

  it("closes what it made when the provider reports an invalid kill time", async () => {
    const { provider, recorded } = recordingProvider({
      killTime: new Date(Number.NaN),
    });

    await expect(createSandbox({ provider })).rejects.toBeInstanceOf(
      CreateSandboxError,
    );
    expect(recorded.closes).toBe(1);
  });

  it("rejects invalid options before creating anything", async () => {
    const { provider, recorded } = recordingProvider();

    await expect(
      createSandbox({ provider, timeLimitMinutes: 0 }),
    ).rejects.toThrow(RangeError);
    await expect(
      createSandbox({ provider, env: { "BAD-KEY": "x" } }),
    ).rejects.toThrow(TypeError);
    expect(recorded.creates).toHaveLength(0);
  });

  it("closes the provider sandbox once, however often close is called", async () => {
    const { provider, recorded } = recordingProvider();
    const sandbox = await createSandbox({ provider });

    await sandbox.close();
    await sandbox.close();

    expect(recorded.closes).toBe(1);
  });

  it("closes the sandbox when an `await using` block ends", async () => {
    const { provider, recorded } = recordingProvider();
    {
      await using sandbox = await createSandbox({ provider });
      expect(sandbox.sandboxId).toBe("sbx-1");
    }
    expect(recorded.closes).toBe(1);
  });

  it("has no providerOptions and no detach on a local sandbox (types)", async () => {
    const { provider } = recordingProvider();

    const sandbox = await createSandbox({
      provider,
      // @ts-expect-error v1 takes no providerOptions: vendor options go to the provider factory
      providerOptions: {},
    });

    // @ts-expect-error a provider without a detach capability makes handles without detach
    expect(sandbox.detach).toBeUndefined();
  });
});
