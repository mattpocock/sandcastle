import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Sandbox } from "@ai-hero/sandcastle/v1";
import { createSandbox } from "@ai-hero/sandcastle/v1";
import type { FakeSandboxProvider } from "@ai-hero/sandcastle/v1/testing";
import { fakeSandbox } from "@ai-hero/sandcastle/v1/testing";
import type { ChooserContext, SpecTickets } from "@ai-hero/sandcastle/v1/tasks";
import { jevChooser } from "@ai-hero/sandcastle/v1/tasks";
import { hostPath } from "./helpers/finishReportReceiver.js";

// `jevChooser` on the fake sandbox, with TypeSafe faked at the network: an
// injected `fetch` answers each System One request with a Choice answer in
// the shape TypeSafe's API reference documents
// (https://docs.typesafe.ai/api/system-one), and records what it was sent.
// A stub `gh` on the sandbox's PATH stands in for GitHub. No test calls the
// live API. POSIX only, like the other task tests.

const KEY = "ts_test_key_not_real";
const TOKEN = "ghs_jevtesttoken0123456789";

/** A spec of three tickets: B (42) is blocked by A (41); C (43) stands alone. */
const SPEC = {
  title: "Widgets",
  body: "Build the widgets.",
  tickets: [
    { id: "41", title: "A: the widget", body: "Blocked by: none", open: true },
    { id: "42", title: "B: widget docs", body: "Blocked by: #41", open: true },
    { id: "43", title: "C: the gadget", body: "Blocked by: none", open: true },
  ],
} as const satisfies SpecTickets;

/** A System One response choosing `choice`, as the API reference shows one. */
const answer = (choice: string): Response =>
  Response.json({
    model: "jev-1.14.0",
    answers: {
      next_ticket: {
        type: "choice",
        choice,
        confidence: 0.9,
        probabilities: { [choice]: 0.95 },
      },
    },
    usage: { input_tokens: 420, output_tokens: 12 },
  });

/** What a System One request's body must hold, as far as these tests read it. */
const SentBody = z.object({
  model: z.string(),
  state: z.object({
    tickets: z.array(z.object({ id: z.string(), status: z.string() })),
  }),
  questions: z.object({
    next_ticket: z.object({
      type: z.string(),
      criteria: z.record(z.string(), z.string()),
    }),
  }),
});

interface Sent {
  readonly url: string;
  readonly headers: Headers;
  readonly body: z.infer<typeof SentBody>;
}

/** A fake TypeSafe: answers each request with the next of `replies`, and keeps what it was sent. */
const fakeTypeSafe = (replies: readonly (() => Response)[]) => {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    sent.push({
      url: request.url,
      headers: request.headers,
      body: SentBody.parse(await request.json()),
    });
    const reply = replies[sent.length - 1];
    return reply === undefined ? answer("none_ready") : reply();
  };
  return { fetch, sent };
};

/** Each request's options, without `none_ready`. */
const optionsOf = (sent: readonly Sent[]) =>
  sent.map((request) =>
    Object.keys(request.body.questions.next_ticket.criteria).filter(
      (option) => option !== "none_ready",
    ),
  );

describe.skipIf(process.platform === "win32")("jevChooser (v1)", () => {
  let rootDir = "";
  let provider: FakeSandboxProvider = fakeSandbox();

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-jev-"));
    provider = fakeSandbox({ rootDir: path.join(rootDir, "sandboxes") });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
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

  /** A stub `gh` that prints `spec` for `gh issue view` and `subIssues` for `gh api`, or fails when `spec` is null. */
  const stubGh = async (spec: unknown, subIssues: readonly unknown[]) => {
    const dir = path.join(rootDir, "gh");
    const bin = path.join(dir, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(dir, "view.json"), JSON.stringify(spec));
    await writeFile(
      path.join(dir, "subs.jsonl"),
      subIssues.map((issue) => JSON.stringify(issue)).join("\n"),
    );
    const script = [
      "#!/bin/sh",
      `printf '%s repo=%s token=%s\\n' "$*" "$GH_REPO" "$GH_TOKEN" >> "${dir}/calls.txt"`,
      spec === null ? "echo 'no such issue' >&2; exit 1" : "",
      `[ "$1 $2" = "issue view" ] && exec cat "${dir}/view.json"`,
      `[ "$1" = "api" ] && exec cat "${dir}/subs.jsonl"`,
      "exit 1",
    ].join("\n");
    await writeFile(path.join(bin, "gh"), `${script}\n`);
    await chmod(path.join(bin, "gh"), 0o755);
    return {
      env: { PATH: `${bin}:${hostPath()}` },
      calls: async () => readFile(path.join(dir, "calls.txt"), "utf8"),
    };
  };

  it("picks [A, C], then [B] once A is merged, asking Jev one ticket at a time", async () => {
    const sandbox = await createSandbox({ provider });
    const first = fakeTypeSafe([() => answer("41"), () => answer("43")]);
    const read = async () => SPEC;

    const round1 = await jevChooser({ apiKey: KEY, fetch: first.fetch, read })(
      contextOn(sandbox),
    );
    const second = fakeTypeSafe([() => answer("42")]);
    const round2 = await jevChooser({ apiKey: KEY, fetch: second.fetch, read })(
      contextOn(sandbox, { round: 2, merged: ["41", "43"] }),
    );

    expect(round1).toStrictEqual({
      status: "ok",
      next: ["41", "43"],
      remaining: ["42"],
    });
    expect(optionsOf(first.sent)).toStrictEqual([
      ["41", "42", "43"],
      ["42", "43"],
      ["42"],
    ]);
    expect(first.sent[2]?.body.state.tickets).toContainEqual(
      expect.objectContaining({ id: "41", status: "chosen" }),
    );
    expect(round2).toStrictEqual({ status: "ok", next: ["42"], remaining: [] });
    expect(optionsOf(second.sent)).toStrictEqual([["42"]]);
  });

  it("sends a Choice request to System One with the key as a bearer token and jev-latest by default", async () => {
    const sandbox = await createSandbox({ provider });
    const typeSafe = fakeTypeSafe([]);

    await jevChooser({
      apiKey: KEY,
      fetch: typeSafe.fetch,
      read: async () => SPEC,
    })(contextOn(sandbox));

    const [request] = typeSafe.sent;
    expect(request?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(request?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(request?.body.model).toBe("jev-latest");
    expect(request?.body.questions.next_ticket.type).toBe("choice");
  });

  it("never offers or returns a stuck or skipped ticket", async () => {
    const sandbox = await createSandbox({ provider });
    const typeSafe = fakeTypeSafe([() => answer("41"), () => answer("43")]);

    const chosen = await jevChooser({
      apiKey: KEY,
      fetch: typeSafe.fetch,
      read: async () => SPEC,
    })(contextOn(sandbox, { stuck: ["41"], skipped: ["42"] }));

    expect(optionsOf(typeSafe.sent)).toStrictEqual([["43"]]);
    expect(chosen).toStrictEqual({ status: "ok", next: [], remaining: ["43"] });
  });

  it("reads the spec and its open sub-issues with gh, with the token and repo in its env only", async () => {
    const gh = await stubGh({ title: "Widgets", body: "Build them." }, [
      { number: 41, title: "A", body: null, state: "closed" },
      { number: 42, title: "B", body: "Blocked by #41", state: "open" },
    ]);
    const sandbox = await createSandbox({ provider, env: gh.env });
    const typeSafe = fakeTypeSafe([() => answer("42")]);

    const chosen = await jevChooser({ apiKey: KEY, fetch: typeSafe.fetch })(
      contextOn(sandbox, { spec: "#40" }),
    );

    expect(chosen).toStrictEqual({ status: "ok", next: ["42"], remaining: [] });
    const calls = await gh.calls();
    expect(calls).toContain(
      `issue view 40 --json title,body repo=o/widgets token=${TOKEN}`,
    );
    expect(calls).toContain("repos/{owner}/{repo}/issues/40/sub_issues");
    expect(JSON.stringify(typeSafe.sent)).not.toContain(TOKEN);
  });

  it("gives blocked, asking Jev nothing, when the spec can't be read or has no tickets", async () => {
    const gh = await stubGh(null, []);
    const sandbox = await createSandbox({ provider, env: gh.env });
    const typeSafe = fakeTypeSafe([]);

    const unreadable = await jevChooser({ apiKey: KEY, fetch: typeSafe.fetch })(
      contextOn(sandbox),
    );
    const empty = await jevChooser({
      apiKey: KEY,
      fetch: typeSafe.fetch,
      read: async () => ({ title: "Widgets", body: "", tickets: [] }),
    })(contextOn(sandbox));

    expect(unreadable).toMatchObject({ status: "blocked", next: [] });
    expect(unreadable.reason).toMatch(/Couldn't read spec 40/u);
    expect(empty).toStrictEqual({
      status: "blocked",
      next: [],
      remaining: [],
      reason: "Spec 40 has no tickets.",
    });
    expect(typeSafe.sent).toHaveLength(0);
  });

  it("takes its key from TYPESAFE_API_KEY, and rejects without one", async () => {
    const sandbox = await createSandbox({ provider });
    const typeSafe = fakeTypeSafe([]);
    const choose = jevChooser({
      fetch: typeSafe.fetch,
      read: async () => SPEC,
    });

    vi.stubEnv("TYPESAFE_API_KEY", "");
    await expect(choose(contextOn(sandbox))).rejects.toThrow(
      /TYPESAFE_API_KEY/u,
    );
    vi.stubEnv("TYPESAFE_API_KEY", KEY);
    await choose(contextOn(sandbox));

    expect(
      typeSafe.sent.map((request) => request.headers.get("authorization")),
    ).toStrictEqual([`Bearer ${KEY}`]);
  });

  it("rejects, naming the status and not the key, when TypeSafe refuses the request", async () => {
    const sandbox = await createSandbox({ provider });
    const typeSafe = fakeTypeSafe([
      () => Response.json({ detail: "Invalid API key" }, { status: 401 }),
    ]);

    const choosing = jevChooser({
      apiKey: KEY,
      fetch: typeSafe.fetch,
      read: async () => SPEC,
    })(contextOn(sandbox));

    await expect(choosing).rejects.toThrow(/TypeSafe answered 401/u);
    await expect(choosing).rejects.not.toThrow(KEY);
  });

  it("rejects on a custom tracker without read", async () => {
    const sandbox = await createSandbox({ provider });

    await expect(
      jevChooser({ apiKey: KEY, fetch: fakeTypeSafe([]).fetch })(
        contextOn(sandbox, {
          skillsContext: {
            tracker: { kind: "custom", name: "Linear", instructions: "…" },
          },
        }),
      ),
    ).rejects.toThrow(/pass read for a custom tracker/u);
  });
});
