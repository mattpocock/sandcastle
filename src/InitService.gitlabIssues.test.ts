import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  scaffold,
  getAgent,
  getIssueTracker,
  listIssueTrackers,
} from "./InitService.js";
import type { ScaffoldOptions } from "./InitService.js";

const makeDir = () => mkdtemp(join(tmpdir(), "init-service-"));

const claudeCodeAgent = getAgent("claude-code")!;

const defaultOptions: ScaffoldOptions = {
  agent: claudeCodeAgent,
  model: "claude-opus-4-8",
};

const runScaffold = (repoDir: string, options?: Partial<ScaffoldOptions>) =>
  Effect.runPromise(
    scaffold(repoDir, { ...defaultOptions, ...options }).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );

describe("gitlab-issues issue tracker registry entry", () => {
  it("is listed among the issue trackers", () => {
    const trackers = listIssueTrackers();
    expect(trackers.some((t) => t.name === "gitlab-issues")).toBe(true);
  });

  it("has the GitLab Issues label", () => {
    expect(getIssueTracker("gitlab-issues")!.label).toBe("GitLab Issues");
  });

  it("lists open issues with glab as JSON, filtered by the Sandcastle label", () => {
    const cmd =
      getIssueTracker("gitlab-issues")!.templateArgs.LIST_TASKS_COMMAND;
    expect(cmd).toContain("glab issue list");
    expect(cmd).toContain(" --label Sandcastle");
    expect(cmd).toContain("--output json");
  });

  it("views a single issue with its comments", () => {
    expect(
      getIssueTracker("gitlab-issues")!.templateArgs.VIEW_TASK_COMMAND,
    ).toContain("glab issue view <ID>");
  });

  it("closes an issue with a completion note", () => {
    const cmd =
      getIssueTracker("gitlab-issues")!.templateArgs.CLOSE_TASK_COMMAND;
    expect(cmd).toContain("glab issue close <ID>");
    expect(cmd).toContain("Completed by Sandcastle");
  });

  it("installs the GitLab CLI in the Dockerfile block", () => {
    const tools =
      getIssueTracker("gitlab-issues")!.templateArgs.ISSUE_TRACKER_TOOLS;
    expect(tools).toContain("glab");
    expect(tools).toContain("dpkg --print-architecture");
  });

  it("declares a create-label command using glab", () => {
    const tracker = getIssueTracker("gitlab-issues")!;
    expect(tracker.createLabelCommand).toContain("glab label create");
    expect(tracker.createLabelCommand).toContain("Sandcastle");
  });

  it("github-issues keeps its create-label command through gh", () => {
    const tracker = getIssueTracker("github-issues")!;
    expect(tracker.createLabelCommand).toContain("gh label create");
  });

  it("beads and custom trackers declare no create-label command", () => {
    expect(getIssueTracker("beads")!.createLabelCommand).toBeUndefined();
    expect(getIssueTracker("custom")!.createLabelCommand).toBeUndefined();
  });
});

describe("scaffold with the gitlab-issues tracker", () => {
  it("Dockerfile installs glab with no template argument left behind", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { issueTracker: getIssueTracker("gitlab-issues") });

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain("GitLab CLI");
    expect(dockerfile).toContain("glab");
    expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");
  });

  it(".env.example includes GITLAB_TOKEN", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { issueTracker: getIssueTracker("gitlab-issues") });

    const envExample = await readFile(
      join(dir, ".sandcastle", ".env.example"),
      "utf-8",
    );
    expect(envExample).toContain("GITLAB_TOKEN=");
    expect(envExample).not.toContain("GH_TOKEN=");
  });

  it("simple-loop prompt uses glab commands", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      templateName: "simple-loop",
      issueTracker: getIssueTracker("gitlab-issues"),
    });

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("glab issue list");
    expect(prompt).toContain("glab issue close");
    expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
  });

  it("strips --label Sandcastle from prompts when label creation is declined", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      templateName: "simple-loop",
      issueTracker: getIssueTracker("gitlab-issues"),
      createLabel: false,
    });

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("glab issue list");
    expect(prompt).not.toContain("--label Sandcastle");
  });

  it("does not scaffold SETUP_ISSUE_TRACKER.md (gitlab-issues is fully wired)", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { issueTracker: getIssueTracker("gitlab-issues") });

    const { access } = await import("node:fs/promises");
    await expect(
      access(join(dir, ".sandcastle", "SETUP_ISSUE_TRACKER.md")),
    ).rejects.toThrow();
  });
});
