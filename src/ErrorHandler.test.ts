import { Effect, Ref } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Display, SilentDisplay } from "./Display.js";
import type { DisplayEntry } from "./Display.js";
import {
  AgentError,
  AgentIdleTimeoutError,
  AppleContainerError,
  ConfigDirError,
  CopyError,
  DockerError,
  ExecError,
  ExecHostError,
  InitError,
  PromptError,
  PromptExpansionTimeoutError,
  SyncError,
  WorktreeError,
} from "./errors.js";
import { formatErrorMessage, withFriendlyErrors } from "./ErrorHandler.js";

// --- formatErrorMessage ---

describe("formatErrorMessage", () => {
  it("ExecError includes command and message", () => {
    const msg = formatErrorMessage(
      new ExecError({ message: "permission denied", command: "ls /root" }),
    );
    expect(msg).toContain("ls /root");
    expect(msg).toContain("permission denied");
  });

  it("ExecHostError includes command and message", () => {
    const msg = formatErrorMessage(
      new ExecHostError({ message: "not found", command: "git status" }),
    );
    expect(msg).toContain("git status");
    expect(msg).toContain("not found");
  });

  it("CopyError includes message", () => {
    const msg = formatErrorMessage(new CopyError({ message: "disk full" }));
    expect(msg).toContain("disk full");
  });

  it("DockerError includes message and Docker hint", () => {
    const msg = formatErrorMessage(
      new DockerError({ message: "daemon not running" }),
    );
    expect(msg).toContain("daemon not running");
    expect(msg).toContain("Docker");
    expect(msg).toContain("Is Docker running?");
  });

  it("AppleContainerError includes message and service hint", () => {
    const msg = formatErrorMessage(
      new AppleContainerError({ message: "API server unavailable" }),
    );
    expect(msg).toContain("API server unavailable");
    expect(msg).toContain("Apple Container");
    expect(msg).toContain("services running");
  });

  it("SyncError includes message", () => {
    const msg = formatErrorMessage(
      new SyncError({ message: "merge conflict" }),
    );
    expect(msg).toContain("merge conflict");
  });

  it("WorktreeError includes message", () => {
    const msg = formatErrorMessage(
      new WorktreeError({ message: "already exists" }),
    );
    expect(msg).toContain("already exists");
  });

  it("PromptError includes message", () => {
    const msg = formatErrorMessage(
      new PromptError({ message: "file not found" }),
    );
    expect(msg).toContain("Failed to resolve prompt");
    expect(msg).toContain("file not found");
  });

  it("PromptError surfaces exitCode when set", () => {
    const msg = formatErrorMessage(
      new PromptError({
        message: "Command `gh api ...` exited with code 4: bad credentials",
        exitCode: 4,
      }),
    );
    expect(msg).toContain("code 4");
  });

  it("PromptExpansionTimeoutError surfaces elapsedMs", () => {
    const msg = formatErrorMessage(
      new PromptExpansionTimeoutError({
        message: "Shell expression `gh api ...` timed out after 30142ms",
        timeoutMs: 30_000,
        expression: "gh api ...",
        elapsedMs: 30_142,
      }),
    );
    expect(msg).toContain("30142");
    expect(msg).toContain("timed out");
  });

  it("AgentError includes message", () => {
    const msg = formatErrorMessage(
      new AgentError({ message: "claude not installed" }),
    );
    expect(msg).toContain("claude not installed");
  });

  it("ConfigDirError passes through message (includes init hint)", () => {
    const msg = formatErrorMessage(
      new ConfigDirError({
        message: "No .sandcastle/ found. Run `sandcastle init` first.",
      }),
    );
    expect(msg).toContain("No .sandcastle/");
    expect(msg).toContain("sandcastle init");
  });

  it("InitError passes through message", () => {
    const msg = formatErrorMessage(
      new InitError({ message: 'Unknown template "foo".' }),
    );
    expect(msg).toContain("Unknown template");
  });

  it("AgentIdleTimeoutError passes through message", () => {
    const msg = formatErrorMessage(
      new AgentIdleTimeoutError({
        message:
          "Agent idle for 1200 seconds — no output received. Consider increasing the idle timeout with --idle-timeout.",
        timeoutMs: 1_200_000,
      }),
    );
    expect(msg).toContain("1200");
    expect(msg).toContain("--idle-timeout");
  });
});

// --- withFriendlyErrors ---

describe("withFriendlyErrors", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockExit: any;

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    mockExit.mockRestore();
  });

  const runWithDisplay = async (
    effect: Effect.Effect<unknown, never, Display>,
  ): Promise<ReadonlyArray<DisplayEntry>> => {
    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    await Effect.runPromise(Effect.provide(effect, SilentDisplay.layer(ref)));
    return Effect.runSync(Ref.get(ref));
  };

  const statusOf = (entries: ReadonlyArray<DisplayEntry>) =>
    entries.find((e) => e._tag === "status") as
      | Extract<DisplayEntry, { _tag: "status" }>
      | undefined;

  it("routes DockerError through Display as error severity", async () => {
    const entries = await runWithDisplay(
      withFriendlyErrors(
        Effect.fail(new DockerError({ message: "daemon not running" })),
      ),
    );
    const s = statusOf(entries);
    expect(s).toBeDefined();
    expect(s!.severity).toBe("error");
    expect(s!.message).toContain("daemon not running");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("routes ConfigDirError through Display with its message", async () => {
    const entries = await runWithDisplay(
      withFriendlyErrors(
        Effect.fail(
          new ConfigDirError({
            message: "No .sandcastle/ found. Run `sandcastle init` first.",
          }),
        ),
      ),
    );
    expect(statusOf(entries)!.message).toContain("No .sandcastle/");
  });

  it("routes AgentIdleTimeoutError through Display with timeout seconds", async () => {
    const entries = await runWithDisplay(
      withFriendlyErrors(
        Effect.fail(
          new AgentIdleTimeoutError({
            message:
              "Agent idle for 600 seconds — no output received. Consider increasing the idle timeout with --idle-timeout.",
            timeoutMs: 600_000,
          }),
        ),
      ),
    );
    const s = statusOf(entries);
    expect(s!.message).toContain("600");
    expect(s!.severity).toBe("error");
  });

  it("passes through successful effects unchanged", async () => {
    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const result = await Effect.runPromise(
      withFriendlyErrors(Effect.succeed("ok")).pipe(
        Effect.provide(SilentDisplay.layer(ref)),
      ),
    );
    expect(result).toBe("ok");
    expect(mockExit).not.toHaveBeenCalled();
  });
});
