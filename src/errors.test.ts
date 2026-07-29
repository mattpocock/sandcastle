import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentError,
  AppleContainerError,
  CopyError,
  DockerError,
  ExecError,
  ExecHostError,
  InitError,
  PromptError,
  SyncError,
  WorktreeError,
} from "./errors.js";

describe("tagged errors", () => {
  it("ExecError has correct _tag and extends Error", () => {
    const err = new ExecError({ message: "failed", command: "ls" });
    expect(err._tag).toBe("ExecError");
    expect(err.message).toBe("failed");
    expect(err.command).toBe("ls");
    expect(err).toBeInstanceOf(Error);
  });

  it("ExecHostError has correct _tag and extends Error", () => {
    const err = new ExecHostError({ message: "failed", command: "git status" });
    expect(err._tag).toBe("ExecHostError");
    expect(err.command).toBe("git status");
    expect(err).toBeInstanceOf(Error);
  });

  it("CopyError has correct _tag", () => {
    const err = new CopyError({ message: "copy failed" });
    expect(err._tag).toBe("CopyError");
    expect(err).toBeInstanceOf(Error);
  });

  it("DockerError has correct _tag", () => {
    const err = new DockerError({ message: "docker failed" });
    expect(err._tag).toBe("DockerError");
    expect(err).toBeInstanceOf(Error);
  });

  it("AppleContainerError has correct _tag", () => {
    const err = new AppleContainerError({ message: "service unavailable" });
    expect(err._tag).toBe("AppleContainerError");
    expect(err).toBeInstanceOf(Error);
  });

  it("SyncError has correct _tag", () => {
    const err = new SyncError({ message: "sync failed" });
    expect(err._tag).toBe("SyncError");
    expect(err).toBeInstanceOf(Error);
  });

  it("PromptError has correct _tag", () => {
    const err = new PromptError({ message: "prompt failed" });
    expect(err._tag).toBe("PromptError");
    expect(err).toBeInstanceOf(Error);
  });

  it("AgentError has correct _tag", () => {
    const err = new AgentError({ message: "agent failed" });
    expect(err._tag).toBe("AgentError");
    expect(err).toBeInstanceOf(Error);
  });

  it("WorktreeError has correct _tag", () => {
    const err = new WorktreeError({ message: "worktree failed" });
    expect(err._tag).toBe("WorktreeError");
    expect(err).toBeInstanceOf(Error);
  });

  it("errors can be discriminated with Effect.catchTag", async () => {
    const program = Effect.gen(function* () {
      yield* Effect.fail(new ExecError({ message: "boom", command: "ls" }));
      return "unreachable";
    });

    const result = await Effect.runPromise(
      program.pipe(
        Effect.catchTag("ExecError", (e) =>
          Effect.succeed(`caught: ${e.command}`),
        ),
      ),
    );

    expect(result).toBe("caught: ls");
  });

  it("errors propagate when catchTag doesn't match", async () => {
    const program: Effect.Effect<string, ExecError | CopyError> = Effect.gen(
      function* () {
        yield* Effect.fail(new CopyError({ message: "copy failed" }));
        return "unreachable";
      },
    );

    const error = await Effect.runPromise(
      program.pipe(
        Effect.catchTag("ExecError", () => Effect.succeed("wrong tag")),
        Effect.flip,
      ),
    );

    expect(error._tag).toBe("CopyError");
  });

  it("different error types compose in the same Effect chain", async () => {
    const execFail = Effect.fail(
      new ExecError({ message: "exec failed", command: "ls" }),
    );
    const copyFail = Effect.fail(new CopyError({ message: "copy failed" }));

    // Both errors compose into a single chain
    const program = Effect.gen(function* () {
      if (Math.random() > 2) yield* execFail;
      yield* copyFail;
    });

    const error = await Effect.runPromise(program.pipe(Effect.flip));
    expect(error._tag).toBe("CopyError");
  });
});
