import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SandboxProvider } from "@ai-hero/sandcastle";
import { createSandbox } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import {
  NATIVE_PROVIDERS,
  assertUsable,
  skipsHere,
} from "./helpers/nativeProviders.js";

// A streamed exec sends agent stdout to `onLine` as JSONL lines: a line ends
// only at "\n", with an optional "\r" before it. JSON allows a raw U+2028 or
// U+2029 inside a string, and Node's readline ends a line there too, so it
// cut valid agent frames in two. The command here writes its stdout in
// chunks, pausing between them, so frames and characters split across chunks.

const brain = Buffer.from("🧠");

/** The stdout chunks the command writes, in order. */
const chunks: readonly Buffer[] = [
  Buffer.from('{"text":"a\u2028b\u2029c"}\r\n{"text":"spl'),
  Buffer.from('it"}\n{"text":"'),
  brain.subarray(0, 2),
  Buffer.concat([brain.subarray(2), Buffer.from('"}\n{"end":true}')]),
];

/** The lines `onLine` gets: the frames as written, without line endings. */
const expectedLines = [
  '{"text":"a\u2028b\u2029c"}',
  '{"text":"split"}',
  '{"text":"🧠"}',
  '{"end":true}',
];

/** A node script that writes `chunks` to stdout, pausing between them. */
const chunkedScript = `
(async () => {
  for (const hex of ${JSON.stringify(chunks.map((c) => c.toString("hex")))}) {
    process.stdout.write(Buffer.from(hex, "hex"));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
})();
`;

interface ProviderCase {
  readonly name: string;
  readonly skips: boolean;
  readonly assertUsable: () => void;
  readonly make: () => SandboxProvider;
}

const PROVIDERS: readonly ProviderCase[] = [
  {
    name: "noSandbox()",
    skips: false,
    assertUsable: () => undefined,
    make: () => noSandbox(),
  },
  ...NATIVE_PROVIDERS.map((provider) => ({
    name: provider.name,
    skips: skipsHere(provider),
    assertUsable: () => {
      assertUsable(provider);
    },
    make: provider.make,
  })),
];

describe.each(PROVIDERS)("streamed stdout lines: $name", (provider) => {
  describe.skipIf(provider.skips)("on this host", () => {
    let repo = "";

    beforeAll(() => {
      provider.assertUsable();
    });

    beforeEach(() => {
      repo = mkdtempSync(path.join(tmpdir(), "e2e-stdout-lines-"));
      const git = (...args: string[]): void => {
        execFileSync("git", args, { cwd: repo, stdio: "ignore" });
      };
      git("init", "-b", "main");
      writeFileSync(path.join(repo, "README.md"), "# repo\n");
      git("add", ".");
      git("commit", "-m", "init");
    });

    afterEach(() => {
      rmSync(repo, { recursive: true, force: true });
    });

    it("ends a line only at a newline", async () => {
      await using sandbox = await createSandbox({
        branch: "lines",
        cwd: repo,
        sandbox: provider.make(),
      });
      const lines: string[] = [];
      const result = await sandbox.exec("node", {
        stdin: chunkedScript,
        onLine: (line) => {
          lines.push(line);
        },
      });

      expect({ ...result, lines }).toMatchObject({
        exitCode: 0,
        stdout: expectedLines.join("\n"),
        lines: expectedLines,
      });
    }, 30_000);
  });
});
