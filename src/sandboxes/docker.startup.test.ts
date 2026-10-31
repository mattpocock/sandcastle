import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Exit, TestClock, TestContext } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const shutdown = vi.hoisted(() => new Set<() => void>());
vi.mock("../shutdownRegistry.js", () => ({
  registerShutdown: (callback: () => void) => {
    shutdown.add(callback);
    return () => shutdown.delete(callback);
  },
}));
vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  )),
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

import { execFile, execFileSync } from "node:child_process";
import { docker } from "./docker.js";
import { startSandbox } from "../startSandbox.js";
import { ContainerStartTimeoutError } from "../errors.js";

describe("Docker startup cleanup (#916)", () => {
  let tempDir: string;
  let blockedCommand: string | undefined;
  let failedCommand: string | undefined;
  let reachedCommand: () => void;
  let commandReached: Promise<void>;
  let finishCommand: () => void;
  let abortedCommands: string[];
  let containers: Set<string>;

  const createOptions = {
    worktreePath: "/tmp/worktree",
    hostRepoPath: "/tmp/repo",
    mounts: [
      { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
    ],
    env: {},
  };

  const provider = () =>
    docker({
      mounts: [
        {
          hostPath: join(tempDir, "auth.json"),
          sandboxPath: "/home/agent/.codex/auth.json",
        },
      ],
    });

  const forcedRemovals = () =>
    vi
      .mocked(execFileSync)
      .mock.calls.filter(
        ([command, args]) => command === "docker" && args?.[0] === "rm",
      );

  beforeEach(() => {
    vi.resetAllMocks();
    shutdown.clear();
    blockedCommand = undefined;
    failedCommand = undefined;
    abortedCommands = [];
    containers = new Set();
    commandReached = new Promise<void>((resolve) => {
      reachedCommand = resolve;
    });
    tempDir = mkdtempSync(join(tmpdir(), "sandcastle-docker-startup-"));
    writeFileSync(join(tempDir, "auth.json"), "{}");

    vi.mocked(execFile).mockImplementation((_command, args, ...rest: any[]) => {
      const argv = args as string[];
      const command = argv[0]!;
      const callback = rest[rest.length - 1];
      const signal =
        rest.length > 1
          ? (rest[0]?.signal as AbortSignal | undefined)
          : undefined;
      if (command === "run") containers.add(argv[argv.indexOf("--name") + 1]!);
      if (command === "rm") containers.delete(argv[1]!);
      let settled = false;
      const finish = (error: Error | null = null) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        callback(error, "", "");
      };
      const abort = () => {
        abortedCommands.push(command);
        finish(new Error("command aborted"));
      };
      if (signal?.aborted) {
        queueMicrotask(abort);
      } else if (command === blockedCommand) {
        signal?.addEventListener("abort", abort, { once: true });
        finishCommand = () => finish();
        reachedCommand();
      } else {
        queueMicrotask(() =>
          finish(command === failedCommand ? new Error("setup failed") : null),
        );
      }
      return undefined as any;
    });
    vi.mocked(execFileSync).mockImplementation((_command, args) => {
      const argv = args as string[];
      expect(argv.slice(0, 2)).toEqual(["rm", "-f"]);
      containers.delete(argv[2]!);
      return Buffer.from("");
    });
  });

  afterEach(() => {
    shutdown.clear();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("force-removes a started container when parent-directory setup fails", async () => {
    failedCommand = "exec";
    await expect(provider().create(createOptions)).rejects.toThrow(
      "Failed to create parent directory",
    );
    expect(forcedRemovals()).toHaveLength(1);
    expect(forcedRemovals()[0]![2]).toMatchObject({ timeout: 5000 });
    expect(containers.size).toBe(0);
    expect(shutdown.size).toBe(0);
  });

  it.each(["run", "exec"])(
    "cancels a hung %s command and force-removes the container on the outer timeout",
    async (command) => {
      blockedCommand = command;
      const sandboxProvider = provider();
      if (sandboxProvider.tag !== "bind-mount")
        throw new Error("Expected bind-mount provider");
      const program = Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          Effect.acquireUseRelease(
            startSandbox({
              provider: sandboxProvider,
              hostRepoDir: createOptions.hostRepoPath,
              worktreeOrRepoPath: createOptions.worktreePath,
              repoDir: "/home/agent/workspace",
              gitMounts: [],
              env: {},
            }),
            Effect.succeed,
            ({ handle }) => Effect.promise(() => handle.close()),
          ),
        );
        yield* Effect.promise(() => commandReached);
        yield* TestClock.adjust(120_001);
        return yield* fiber.await;
      }).pipe(Effect.provide(TestContext.TestContext));

      const exit = await Effect.runPromise(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(ContainerStartTimeoutError);
      } else {
        throw new Error("Expected ContainerStartTimeoutError");
      }
      expect(abortedCommands).toContain(command);
      await vi.waitFor(() => expect(forcedRemovals()).toHaveLength(1));
      expect(containers.size).toBe(0);
      expect(shutdown.size).toBe(0);
    },
  );

  it("registers shutdown cleanup before docker run completes and shares it with cancellation", async () => {
    blockedCommand = "run";
    const controller = new AbortController();
    const creation = provider().create({
      ...createOptions,
      signal: controller.signal,
    });
    const rejected = expect(creation).rejects.toThrow();
    await commandReached;
    expect(shutdown.size).toBe(1);
    for (const cleanup of shutdown) cleanup();
    controller.abort();
    await rejected;
    expect(abortedCommands).toContain("run");
    expect(forcedRemovals()).toHaveLength(1);
    expect(containers.size).toBe(0);
    expect(shutdown.size).toBe(0);
  });

  it("cleans up when docker run fails before returning a handle", async () => {
    failedCommand = "run";
    await expect(provider().create(createOptions)).rejects.toThrow(
      "setup failed",
    );
    expect(forcedRemovals()).toHaveLength(1);
    expect(containers.size).toBe(0);
    expect(shutdown.size).toBe(0);
  });

  it("does not launch any Docker commands after an already-aborted create request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("creation cancelled"));
    await expect(
      provider().create({ ...createOptions, signal: controller.signal }),
    ).rejects.toThrow("creation cancelled");
    expect(execFile).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
    expect(shutdown.size).toBe(0);
  });

  it("cancels preflight without attempting to remove a container that was never started", async () => {
    blockedCommand = "image";
    const controller = new AbortController();
    const creation = provider().create({
      ...createOptions,
      signal: controller.signal,
    });
    const rejected = expect(creation).rejects.toThrow("creation cancelled");
    await commandReached;
    controller.abort(new Error("creation cancelled"));
    await rejected;
    expect(abortedCommands).toEqual(["image"]);
    expect(forcedRemovals()).toHaveLength(0);
    expect(shutdown.size).toBe(0);
  });

  it("keeps normal close idempotent even when called concurrently", async () => {
    const handle = await provider().create(createOptions);
    blockedCommand = "stop";
    const firstClose = handle.close();
    const secondClose = handle.close();
    expect(secondClose).toBe(firstClose);
    await commandReached;
    finishCommand();
    await Promise.all([firstClose, secondClose]);
    await handle.close();
    const commands = vi
      .mocked(execFile)
      .mock.calls.map(([, args]) => args?.[0]);
    expect(commands.filter((command) => command === "stop")).toHaveLength(1);
    expect(commands.filter((command) => command === "rm")).toHaveLength(1);
    expect(forcedRemovals()).toHaveLength(0);
    expect(containers.size).toBe(0);
    expect(shutdown.size).toBe(0);
  });

  it("cleans a handle when cancellation races with delivery and does not remove it twice", async () => {
    const controller = new AbortController();
    const handle = await provider().create({
      ...createOptions,
      signal: controller.signal,
    });
    controller.abort();
    await handle.close();
    expect(forcedRemovals()).toHaveLength(1);
    expect(containers.size).toBe(0);
    expect(shutdown.size).toBe(0);
  });

  it("preserves the setup error if best-effort cleanup also fails", async () => {
    failedCommand = "exec";
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("Docker unavailable");
    });
    await expect(provider().create(createOptions)).rejects.toThrow(
      "setup failed",
    );
    expect(forcedRemovals()).toHaveLength(1);
    expect(shutdown.size).toBe(0);
  });
});
