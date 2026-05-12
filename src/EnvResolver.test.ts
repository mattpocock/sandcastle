import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveEnv } from "./EnvResolver.js";

const makeDir = () => mkdtemp(join(tmpdir(), "env-resolver-"));

const runResolveEnv = (dir: string) =>
  Effect.runPromise(resolveEnv(dir).pipe(Effect.provide(NodeContext.layer)));

describe("resolveEnv", () => {
  it("returns all key-value pairs from .sandcastle/.env", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle"));
    await writeFile(
      join(dir, ".sandcastle", ".env"),
      "ANTHROPIC_API_KEY=sc-key\nGH_TOKEN=sc-gh\n",
    );

    const env = await runResolveEnv(dir);
    expect(env).toEqual({
      ANTHROPIC_API_KEY: "sc-key",
      GH_TOKEN: "sc-gh",
    });
  });

  it("ignores repo root .env — keys from root .env do not appear in result", async () => {
    const dir = await makeDir();
    await writeFile(
      join(dir, ".env"),
      "ROOT_SECRET=should-not-appear\nANOTHER_ROOT_KEY=also-ignored\n",
    );

    const env = await runResolveEnv(dir);
    expect(env["ROOT_SECRET"]).toBeUndefined();
    expect(env["ANOTHER_ROOT_KEY"]).toBeUndefined();
    expect(env).toEqual({});
  });

  it("root .env is ignored even when .sandcastle/.env also exists", async () => {
    const dir = await makeDir();
    await writeFile(join(dir, ".env"), "ROOT_ONLY=root-val\nSHARED=root\n");
    await mkdir(join(dir, ".sandcastle"));
    await writeFile(
      join(dir, ".sandcastle", ".env"),
      "SC_ONLY=sc-val\nSHARED=sc\n",
    );

    const env = await runResolveEnv(dir);
    expect(env["ROOT_ONLY"]).toBeUndefined();
    expect(env["SC_ONLY"]).toBe("sc-val");
    expect(env["SHARED"]).toBe("sc"); // only .sandcastle/.env is used
  });

  it("falls back to process.env for keys declared in .sandcastle/.env", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle"));
    // .sandcastle/.env declares the key but with empty value
    await writeFile(join(dir, ".sandcastle", ".env"), "MY_TOKEN=\n");

    const orig = process.env["MY_TOKEN"];
    try {
      process.env["MY_TOKEN"] = "from-process";
      const env = await runResolveEnv(dir);
      expect(env["MY_TOKEN"]).toBe("from-process");
    } finally {
      if (orig === undefined) delete process.env["MY_TOKEN"];
      else process.env["MY_TOKEN"] = orig;
    }
  });

  it("does NOT pull keys from process.env that are not in .sandcastle/.env", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle"));
    await writeFile(join(dir, ".sandcastle", ".env"), "DECLARED_KEY=value\n");

    // PATH is always in process.env but should not appear in result
    const env = await runResolveEnv(dir);
    expect(env["PATH"]).toBeUndefined();
    expect(env["HOME"]).toBeUndefined();
    expect(env["DECLARED_KEY"]).toBe("value");
  });

  it(".sandcastle/.env takes precedence over process.env", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle"));
    await writeFile(join(dir, ".sandcastle", ".env"), "MY_VAR=sc-val\n");

    const orig = process.env["MY_VAR"];
    try {
      process.env["MY_VAR"] = "from-process";
      const env = await runResolveEnv(dir);
      expect(env["MY_VAR"]).toBe("sc-val");
    } finally {
      if (orig === undefined) delete process.env["MY_VAR"];
      else process.env["MY_VAR"] = orig;
    }
  });

  it("returns empty object when no .env files exist", async () => {
    const dir = await makeDir();
    const env = await runResolveEnv(dir);
    expect(env).toEqual({});
  });

  it("ignores comments and blank lines in .sandcastle/.env", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle"));
    await writeFile(
      join(dir, ".sandcastle", ".env"),
      "# This is a comment\n\nKEY1=val1\n\n# Another comment\nKEY2=val2\n",
    );

    const env = await runResolveEnv(dir);
    expect(env).toEqual({ KEY1: "val1", KEY2: "val2" });
  });

  it("does no validation — returns whatever keys are present in .sandcastle/.env", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle"));
    // Only custom keys, no ANTHROPIC_API_KEY or GH_TOKEN
    await writeFile(
      join(dir, ".sandcastle", ".env"),
      "NPM_TOKEN=npm123\nDATABASE_URL=pg://localhost\n",
    );

    const env = await runResolveEnv(dir);
    expect(env).toEqual({
      NPM_TOKEN: "npm123",
      DATABASE_URL: "pg://localhost",
    });
  });

  it("strips matching double quotes from values", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle"));
    await writeFile(
      join(dir, ".sandcastle", ".env"),
      'ANTHROPIC_API_KEY="sk-ant-api03-real-key"\n',
    );

    const env = await runResolveEnv(dir);
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-ant-api03-real-key");
  });

  it("strips matching single quotes from values", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle"));
    await writeFile(join(dir, ".sandcastle", ".env"), "TOKEN='my-token'\n");

    const env = await runResolveEnv(dir);
    expect(env["TOKEN"]).toBe("my-token");
  });

  it("leaves mismatched quotes as-is", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle"));
    await writeFile(join(dir, ".sandcastle", ".env"), `KEY="value'\n`);

    const env = await runResolveEnv(dir);
    expect(env["KEY"]).toBe(`"value'`);
  });

  it("leaves interior quotes as-is", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle"));
    await writeFile(join(dir, ".sandcastle", ".env"), 'KEY=some"thing\n');

    const env = await runResolveEnv(dir);
    expect(env["KEY"]).toBe('some"thing');
  });

  it("handles empty quoted values", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle"));
    await writeFile(join(dir, ".sandcastle", ".env"), 'KEY=""\n');

    const env = await runResolveEnv(dir);
    expect(env).toEqual({});
  });

  it("process.env fallback works for keys in .sandcastle/.env too", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle"));
    await writeFile(join(dir, ".sandcastle", ".env"), "FALLBACK_KEY=\n");

    const orig = process.env["FALLBACK_KEY"];
    try {
      process.env["FALLBACK_KEY"] = "from-env";
      const env = await runResolveEnv(dir);
      expect(env["FALLBACK_KEY"]).toBe("from-env");
    } finally {
      if (orig === undefined) delete process.env["FALLBACK_KEY"];
      else process.env["FALLBACK_KEY"] = orig;
    }
  });

  it("unescapes \\n in double-quoted values", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle"));
    await writeFile(
      join(dir, ".sandcastle", ".env"),
      'KEY="line1\\nline2"\n',
    );

    const env = await runResolveEnv(dir);
    expect(env["KEY"]).toBe("line1\nline2");
  });

  it("does not unescape \\n in single-quoted values", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle"));
    await writeFile(
      join(dir, ".sandcastle", ".env"),
      "KEY='line1\\nline2'\n",
    );

    const env = await runResolveEnv(dir);
    expect(env["KEY"]).toBe("line1\\nline2");
  });

  it("preserves internal whitespace in double-quoted values", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle"));
    await writeFile(
      join(dir, ".sandcastle", ".env"),
      'KEY="  spaced  "\n',
    );

    const env = await runResolveEnv(dir);
    expect(env["KEY"]).toBe("  spaced  ");
  });

  it("unescapes \\r, \\t, and \\\\ in double-quoted values", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle"));
    await writeFile(
      join(dir, ".sandcastle", ".env"),
      'TAB="a\\tb"\nCR="a\\rb"\nBS="a\\\\b"\n',
    );

    const env = await runResolveEnv(dir);
    expect(env["TAB"]).toBe("a\tb");
    expect(env["CR"]).toBe("a\rb");
    expect(env["BS"]).toBe("a\\b");
  });

  it("handles escaped backslash before n in double-quoted values", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle"));
    await writeFile(
      join(dir, ".sandcastle", ".env"),
      'KEY="a\\\\nb"\n',
    );

    const env = await runResolveEnv(dir);
    // \\n in the file → literal backslash + literal n (not a newline)
    expect(env["KEY"]).toBe("a\\nb");
  });

  it("parses unquoted values unchanged", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle"));
    await writeFile(join(dir, ".sandcastle", ".env"), "KEY=plain\n");

    const env = await runResolveEnv(dir);
    expect(env["KEY"]).toBe("plain");
  });
});
