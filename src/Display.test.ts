import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer, Ref } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Display,
  FileDisplay,
  SilentDisplay,
  terminalStyle,
} from "./Display.js";
import type { DisplayEntry } from "./Display.js";

describe("SilentDisplay", () => {
  const setup = () => {
    const ref = Ref.unsafeMake<readonly DisplayEntry[]>([]);
    const layer = SilentDisplay.layer(ref);
    return { ref, layer };
  };

  const readEntries = (ref: Ref.Ref<readonly DisplayEntry[]>) => Ref.get(ref);

  describe("status", () => {
    it("captures status messages with severity", async () => {
      const { ref, layer } = setup();

      const entries = await Effect.runPromise(
        Effect.gen(function* () {
          const d = yield* Display;
          yield* d.status("Syncing files...", "info");
          return yield* readEntries(ref);
        }).pipe(Effect.provide(layer)),
      );

      expect(entries).toStrictEqual([
        { _tag: "status", message: "Syncing files...", severity: "info" },
      ]);
    });

    it("captures multiple status messages in order", async () => {
      const { ref, layer } = setup();

      const entries = await Effect.runPromise(
        Effect.gen(function* () {
          const d = yield* Display;
          yield* d.status("Starting...", "info");
          yield* d.status("Done!", "success");
          yield* d.status("Something failed", "error");
          return yield* readEntries(ref);
        }).pipe(Effect.provide(layer)),
      );

      expect(entries).toStrictEqual([
        { _tag: "status", message: "Starting...", severity: "info" },
        { _tag: "status", message: "Done!", severity: "success" },
        { _tag: "status", message: "Something failed", severity: "error" },
      ]);
    });

    it("captures all severity levels", async () => {
      const { ref, layer } = setup();

      const entries = await Effect.runPromise(
        Effect.gen(function* () {
          const d = yield* Display;
          yield* d.status("info msg", "info");
          yield* d.status("success msg", "success");
          yield* d.status("warn msg", "warn");
          yield* d.status("error msg", "error");
          return yield* readEntries(ref);
        }).pipe(Effect.provide(layer)),
      );

      expect(entries).toHaveLength(4);
      expect(
        entries.map((e) => (e as { severity: string }).severity),
      ).toStrictEqual(["info", "success", "warn", "error"]);
    });
  });

  describe("spinner", () => {
    it("passes through the wrapped effect result", async () => {
      const { layer } = setup();

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const d = yield* Display;
          return yield* d.spinner("Loading...", Effect.succeed("hello"));
        }).pipe(Effect.provide(layer)),
      );

      expect(result).toBe("hello");
    });

    it("captures spinner entry with message", async () => {
      const { ref, layer } = setup();

      const entries = await Effect.runPromise(
        Effect.gen(function* () {
          const d = yield* Display;
          yield* d.spinner("Building image...", Effect.succeed(42));
          return yield* readEntries(ref);
        }).pipe(Effect.provide(layer)),
      );

      expect(entries).toStrictEqual([
        { _tag: "spinner", message: "Building image..." },
      ]);
    });

    it("passes through the wrapped effect failure", async () => {
      const { layer } = setup();

      const result = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const d = yield* Display;
          return yield* d.spinner("Failing...", Effect.fail("boom"));
        }).pipe(Effect.provide(layer)),
      );

      expect(result._tag).toBe("Failure");
    });
  });

  describe("summary", () => {
    it("captures summary with title and rows", async () => {
      const { ref, layer } = setup();

      const entries = await Effect.runPromise(
        Effect.gen(function* () {
          const d = yield* Display;
          yield* d.summary("Token Usage", {
            "Input tokens": "1,234",
            "Output tokens": "567",
          });
          return yield* readEntries(ref);
        }).pipe(Effect.provide(layer)),
      );

      expect(entries).toStrictEqual([
        {
          _tag: "summary",
          title: "Token Usage",
          rows: {
            "Input tokens": "1,234",
            "Output tokens": "567",
          },
        },
      ]);
    });
  });

  describe("textChunk", () => {
    it("captures streaming chunks as textChunk entries", async () => {
      const { ref, layer } = setup();

      const entries = await Effect.runPromise(
        Effect.gen(function* () {
          const d = yield* Display;
          yield* d.textChunk("Now I have");
          yield* d.textChunk(" a clear picture.");
          return yield* readEntries(ref);
        }).pipe(Effect.provide(layer)),
      );

      expect(entries).toStrictEqual([
        { _tag: "textChunk", message: "Now I have" },
        { _tag: "textChunk", message: " a clear picture." },
      ]);
    });
  });

  describe("mixed calls", () => {
    it("captures all entry types in order", async () => {
      const { ref, layer } = setup();

      const entries = await Effect.runPromise(
        Effect.gen(function* () {
          const d = yield* Display;
          yield* d.status("Starting run", "info");
          yield* d.spinner("Running agent...", Effect.succeed("done"));
          yield* d.summary("Results", { Iterations: "3" });
          yield* d.status("Run complete", "success");
          return yield* readEntries(ref);
        }).pipe(Effect.provide(layer)),
      );

      expect(entries).toHaveLength(4);
      expect(entries.map((e) => e._tag)).toStrictEqual([
        "status",
        "spinner",
        "summary",
        "status",
      ]);
    });
  });
});

describe("FileDisplay", () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "sandcastle-display-"));
    const logPath = join(dir, "test.log");
    const layer = Layer.provide(
      FileDisplay.layer(logPath),
      NodeFileSystem.layer,
    );
    return { logPath, layer };
  };

  const readLog = (logPath: string) => readFileSync(logPath, "utf8");

  it("intro is a no-op (only delimiter in log)", async () => {
    const { logPath, layer } = setup();

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.intro("sandcastle");
      }).pipe(Effect.provide(layer)),
    );

    const log = readLog(logPath);
    expect(log).toMatch(/^\n--- Run started: .+ ---\n$/);
  });

  it("writes status messages to file", async () => {
    const { logPath, layer } = setup();

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.status("Syncing files...", "info");
        yield* d.status("Done!", "success");
      }).pipe(Effect.provide(layer)),
    );

    const log = readLog(logPath);
    expect(log).toContain("Syncing files...");
    expect(log).toContain("Done!");
    expect(log).not.toContain("[INFO]");
    expect(log).not.toContain("[SUCCESS]");
  });

  it("writes spinner messages to file and passes through result", async () => {
    const { logPath, layer } = setup();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        return yield* d.spinner("Loading...", Effect.succeed("hello"));
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toBe("hello");
    const log = readLog(logPath);
    expect(log).toContain("Loading...");
    expect(log).toContain("Loading... done");
  });

  it("spinner done line includes elapsed time in seconds", async () => {
    const { logPath, layer } = setup();

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.spinner("Building image", Effect.succeed(undefined));
      }).pipe(Effect.provide(layer)),
    );

    const log = readLog(logPath);
    expect(log).toMatch(/Building image done \(\d+\.\ds\)/);
  });

  it("writes summary to file", async () => {
    const { logPath, layer } = setup();

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.summary("Token Usage", {
          "Input tokens": "1,234",
          "Output tokens": "567",
        });
      }).pipe(Effect.provide(layer)),
    );

    const log = readLog(logPath);
    expect(log).toContain("Token Usage");
    expect(log).toContain("Input tokens: 1,234");
    expect(log).toContain("Output tokens: 567");
  });

  it("writes taskLog messages to file", async () => {
    const { logPath, layer } = setup();

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.taskLog("Sync in", (msg) =>
          Effect.sync(() => {
            msg("Cloning repo...");
            msg("Running hooks...");
          }),
        );
      }).pipe(Effect.provide(layer)),
    );

    const log = readLog(logPath);
    expect(log).toContain("Cloning repo...");
    expect(log).toContain("Running hooks...");
    expect(log).toContain("Sync in done");
  });

  it("taskLog done line includes elapsed time in seconds", async () => {
    const { logPath, layer } = setup();

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.taskLog("Setting up sandbox", (msg) =>
          Effect.sync(() => {
            msg("Running hooks...");
          }),
        );
      }).pipe(Effect.provide(layer)),
    );

    const log = readLog(logPath);
    expect(log).toMatch(/Setting up sandbox done \(\d+\.\ds\)/);
  });

  it("writes text messages to file", async () => {
    const { logPath, layer } = setup();

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.text("Some agent output here");
      }).pipe(Effect.provide(layer)),
    );

    const log = readLog(logPath);
    expect(log).toContain("Some agent output here");
  });

  it("text() writes each message on its own line", async () => {
    const { logPath, layer } = setup();

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.text("Context window: 10%");
        yield* d.text("Context window: 20%");
      }).pipe(Effect.provide(layer)),
    );

    const log = readLog(logPath);
    expect(log).toContain("Context window: 10%\nContext window: 20%\n");
  });

  it("textChunk() writes raw chunks with no appended newline", async () => {
    const { logPath, layer } = setup();

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.textChunk("Now I have");
        yield* d.textChunk(" a clear picture.");
      }).pipe(Effect.provide(layer)),
    );

    const log = readLog(logPath);
    expect(log).toContain("Now I have a clear picture.");
    expect(log).not.toContain("Now I have\n");
  });

  it("starts a following line entry on a fresh line after a mid-line chunk", async () => {
    const { logPath, layer } = setup();

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.textChunk("Let me read the file.");
        yield* d.toolCall("Read", "src/hello.ts");
      }).pipe(Effect.provide(layer)),
    );

    const log = readLog(logPath);
    expect(log).toContain("Let me read the file.\nRead(src/hello.ts)\n");
  });

  it("does not insert an extra newline when the chunk already ends with one", async () => {
    const { logPath, layer } = setup();

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.textChunk("Done.\n");
        yield* d.text("Context window: 10%");
      }).pipe(Effect.provide(layer)),
    );

    const log = readLog(logPath);
    expect(log).toContain("Done.\nContext window: 10%\n");
    expect(log).not.toContain("Done.\n\nContext window");
  });

  it("creates log file with run delimiter on initialization", async () => {
    const { logPath, layer } = setup();

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.intro("sandcastle");
      }).pipe(Effect.provide(layer)),
    );

    const log = readLog(logPath);
    expect(log).toMatch(/^\n--- Run started: .+ ---\n$/);
  });

  it("strips [Name] prefix from status messages", async () => {
    const { logPath, layer } = setup();

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.status("[Implementer #119] Iteration 1/100", "info");
        yield* d.status("[Implementer #119] Agent started", "success");
        yield* d.status("No prefix here", "info");
      }).pipe(Effect.provide(layer)),
    );

    const log = readLog(logPath);
    expect(log).toContain("Iteration 1/100");
    expect(log).toContain("Agent started");
    expect(log).toContain("No prefix here");
    expect(log).not.toContain("[Implementer #119]");
  });

  it("writes status messages without ANSI escape codes", async () => {
    const { logPath, layer } = setup();

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.status("Agent started", "success");
        yield* d.status("Iteration 1/3", "info");
      }).pipe(Effect.provide(layer)),
    );

    const log = readLog(logPath);
    expect(log).not.toContain("\u001B[");
  });

  it("appends a run delimiter on initialization instead of truncating", async () => {
    const { logPath, layer } = setup();

    // First run: write some content
    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.text("first run output");
      }).pipe(Effect.provide(layer)),
    );

    const logAfterFirstRun = readLog(logPath);
    expect(logAfterFirstRun).toContain("--- Run started:");
    expect(logAfterFirstRun).toContain("first run output");

    // Second run: create a new layer on the same path
    const layer2 = Layer.provide(
      FileDisplay.layer(logPath),
      NodeFileSystem.layer,
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.text("second run output");
      }).pipe(Effect.provide(layer2)),
    );

    const logAfterSecondRun = readLog(logPath);
    // Previous content must be preserved
    expect(logAfterSecondRun).toContain("first run output");
    expect(logAfterSecondRun).toContain("second run output");
    // Two run delimiters
    const delimiterMatches = logAfterSecondRun.match(
      /--- Run started: .+ ---/g,
    );
    expect(delimiterMatches).toHaveLength(2);
  });

  it("writes run delimiter with ISO 8601 UTC timestamp", async () => {
    const { logPath, layer } = setup();

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.intro("sandcastle");
      }).pipe(Effect.provide(layer)),
    );

    const log = readLog(logPath);
    expect(log).toMatch(
      /--- Run started: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z ---/,
    );
  });

  it("writes summary without ANSI escape codes", async () => {
    const { logPath, layer } = setup();

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.summary("Token Usage", {
          Tokens: "1,234 in / 567 out",
          Turns: "3",
        });
      }).pipe(Effect.provide(layer)),
    );

    const log = readLog(logPath);
    expect(log).not.toContain("\u001B[");
  });
});

describe("SilentDisplay - toolCall", () => {
  const setup = () => {
    const ref = Ref.unsafeMake<readonly DisplayEntry[]>([]);
    const layer = SilentDisplay.layer(ref);
    return { ref, layer };
  };

  it("stores toolCall entries for test assertions", async () => {
    const { ref, layer } = setup();

    const entries = await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.toolCall("Bash", "npm test");
        return yield* Ref.get(ref);
      }).pipe(Effect.provide(layer)),
    );

    expect(entries).toStrictEqual([
      { _tag: "toolCall", name: "Bash", formattedArgs: "npm test" },
    ]);
  });

  it("stores multiple toolCall entries in order", async () => {
    const { ref, layer } = setup();

    const entries = await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.toolCall("Bash", "npm install");
        yield* d.toolCall("WebSearch", "npm trusted publishing OIDC");
        yield* d.toolCall("Agent", "Run tests");
        return yield* Ref.get(ref);
      }).pipe(Effect.provide(layer)),
    );

    expect(entries).toStrictEqual([
      { _tag: "toolCall", name: "Bash", formattedArgs: "npm install" },
      {
        _tag: "toolCall",
        name: "WebSearch",
        formattedArgs: "npm trusted publishing OIDC",
      },
      { _tag: "toolCall", name: "Agent", formattedArgs: "Run tests" },
    ]);
  });
});

describe("FileDisplay - toolCall", () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "sandcastle-display-"));
    const logPath = join(dir, "test.log");
    const layer = Layer.provide(
      FileDisplay.layer(logPath),
      NodeFileSystem.layer,
    );
    return { logPath, layer };
  };

  const readLog = (logPath: string) => readFileSync(logPath, "utf8");

  it("writes tool call as Name(args) line in log file", async () => {
    const { logPath, layer } = setup();

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.toolCall("Bash", "npm test");
      }).pipe(Effect.provide(layer)),
    );

    const log = readLog(logPath);
    expect(log).toContain("Bash(npm test)");
  });

  it("writes different tool types correctly", async () => {
    const { logPath, layer } = setup();

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.toolCall("WebSearch", "npm trusted publishing OIDC");
        yield* d.toolCall("Agent", "Run tests");
      }).pipe(Effect.provide(layer)),
    );

    const log = readLog(logPath);
    expect(log).toContain("WebSearch(npm trusted publishing OIDC)");
    expect(log).toContain("Agent(Run tests)");
  });
});

describe("terminalStyle", () => {
  beforeEach(() => {
    process.env.FORCE_COLOR = "1";
  });
  afterEach(() => {
    delete process.env.FORCE_COLOR;
  });

  it("wraps status messages with bold ANSI codes", () => {
    const styled = terminalStyle.status("Agent started");
    expect(styled).toBe("\u001B[1mAgent started\u001B[22m");
  });

  it("wraps summary title with bold ANSI codes", () => {
    const styled = terminalStyle.summaryTitle("Token Usage");
    expect(styled).toBe("\u001B[1mToken Usage\u001B[22m");
  });

  it("formats summary row with bold key and dim value", () => {
    const styled = terminalStyle.summaryRow("Tokens", "1,234 in / 567 out");
    expect(styled).toContain("\u001B[1mTokens\u001B[22m");
    expect(styled).toContain("\u001B[2m1,234 in / 567 out\u001B[22m");
    expect(styled).toContain(": ");
  });
});
