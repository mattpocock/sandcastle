import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Sandbox } from "@ai-hero/sandcastle/v1";
import { createSandbox, StructuredOutputError } from "@ai-hero/sandcastle/v1";
import type { FakeSandboxProvider } from "@ai-hero/sandcastle/v1/testing";
import { fakeAgent, fakeSandbox } from "@ai-hero/sandcastle/v1/testing";
import type { ChooserContext } from "@ai-hero/sandcastle/v1/tasks";
import { sessionChooser } from "@ai-hero/sandcastle/v1/tasks";
import { stubClaude } from "./helpers/taskWorld.js";

// `sessionChooser`, the default chooser: one structured-output session on
// the fake sandbox. The fake agent prints a scripted `choice`; a stub
// `claude` on the PATH shows how the default agent is run. POSIX only, like
// the other task tests.

const TOKEN = "ghs_choosertesttoken0123456789";

const init = (sessionId: string): string =>
  JSON.stringify({ type: "system", subtype: "init", session_id: sessionId });

const result = (text: string): string =>
  JSON.stringify({ type: "result", is_error: false, result: text });

const chose = (choice: unknown): string =>
  `Read the spec.\n<choice>${JSON.stringify(choice)}</choice>`;

describe.skipIf(process.platform === "win32")("sessionChooser (v1)", () => {
  let rootDir = "";
  let provider: FakeSandboxProvider = fakeSandbox();

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-chooser-"));
    provider = fakeSandbox({ rootDir: path.join(rootDir, "sandboxes") });
  });

  afterEach(async () => {
    await provider.closeAll();
    await rm(rootDir, { recursive: true, force: true });
  });

  const contextOn = (
    sandbox: Sandbox,
    progress: Partial<ChooserContext> = {},
  ): ChooserContext => ({
    spec: "40",
    repo: "o/widgets",
    sandbox,
    githubToken: TOKEN,
    skillsContext: { tracker: { kind: "github" } },
    round: 1,
    merged: [],
    stuck: [],
    skipped: [],
    ...progress,
  });

  it("runs one session on the requested agent and returns its validated choice", async () => {
    const sandbox = await createSandbox({ provider });
    const choice = { status: "ok", next: ["41", "43"], remaining: ["42"] };

    const chosen = await sessionChooser({
      agent: fakeAgent({ lines: [init("s-choose"), result(chose(choice))] }),
    })(contextOn(sandbox));

    expect(chosen).toStrictEqual(choice);
  });

  it("runs Claude Code on Haiku by default, told the spec, the repo and the progress, with the token", async () => {
    const claude = await stubClaude(path.join(rootDir, "agent"), [
      init("s-haiku"),
      result(chose({ status: "ok", next: [], remaining: [] })),
    ]);
    const sandbox = await createSandbox({ provider, env: claude.env });

    await sessionChooser()(
      contextOn(sandbox, {
        round: 3,
        merged: ["41"],
        stuck: ["44"],
        skipped: ["45"],
      }),
    );

    await expect(claude.read("agent-argv.txt")).resolves.toContain(
      "--model haiku",
    );
    await expect(claude.read("agent-env.txt")).resolves.toContain(
      `GH_TOKEN=${TOKEN}`,
    );
    const prompt = await claude.read("agent-prompt.txt");
    expect(prompt).toContain("spec 40 in o/widgets");
    expect(prompt).toContain("Merged: 41.");
    expect(prompt).toContain("Stuck: 44.");
    expect(prompt).toContain("Skipped: 45.");
    expect(prompt).toContain("<choice>");
    expect(prompt).toContain("gh issue view");
  });

  it("never returns a merged, stuck or skipped ticket, whatever the session says", async () => {
    const sandbox = await createSandbox({ provider });
    const said = {
      status: "ok",
      next: ["41", "43", "#44"],
      remaining: ["42", "45"],
    };

    const chosen = await sessionChooser({
      agent: fakeAgent({ lines: [init("s-loose"), result(chose(said))] }),
    })(contextOn(sandbox, { merged: ["41"], stuck: ["44"], skipped: ["45"] }));

    expect(chosen).toStrictEqual({
      status: "ok",
      next: ["43"],
      remaining: ["42"],
    });
  });

  it("returns blocked, building nothing, when the session can't read the spec", async () => {
    const sandbox = await createSandbox({ provider });
    const said = {
      status: "blocked",
      next: ["41"],
      remaining: [],
      reason: "Issue 40 doesn't exist.",
    };

    const chosen = await sessionChooser({
      agent: fakeAgent({ lines: [init("s-blocked"), result(chose(said))] }),
    })(contextOn(sandbox));

    expect(chosen).toStrictEqual({
      status: "blocked",
      next: [],
      remaining: [],
      reason: "Issue 40 doesn't exist.",
    });
  });

  it("rejects with StructuredOutputError when the session's choice doesn't match", async () => {
    const sandbox = await createSandbox({ provider });

    await expect(
      sessionChooser({
        agent: fakeAgent({
          lines: [init("s-bad"), result(chose({ status: "maybe", next: [] }))],
        }),
      })(contextOn(sandbox)),
    ).rejects.toBeInstanceOf(StructuredOutputError);
  });
});
