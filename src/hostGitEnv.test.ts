import { describe, expect, it } from "vitest";
import { hostGitEnv } from "./hostGitEnv.js";

describe("hostGitEnv", () => {
  it("disables hooks and fsmonitor via GIT_CONFIG_* overrides", () => {
    const env = hostGitEnv({ PATH: "/bin" });
    expect(env).toMatchObject({
      PATH: "/bin",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_CONFIG_KEY_1: "core.fsmonitor",
      GIT_CONFIG_VALUE_1: "false",
    });
  });

  it("appends after existing GIT_CONFIG_* entries instead of replacing them", () => {
    const env = hostGitEnv({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.proxy",
      GIT_CONFIG_VALUE_0: "http://proxy",
    });
    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "http.proxy",
      GIT_CONFIG_VALUE_0: "http://proxy",
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_KEY_2: "core.fsmonitor",
    });
  });

  it("does not mutate the input env", () => {
    const base = { PATH: "/bin" };
    hostGitEnv(base);
    expect(base).toEqual({ PATH: "/bin" });
  });
});
