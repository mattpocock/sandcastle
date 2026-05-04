import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DeckLoader } from "../../src/deck/DeckLoader.js";
import { makeRepo } from "../helpers.js";

describe("DeckLoader", () => {
  it("loads valid frontmatter for mode, skills, and commands", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, ".sandcastle", "skills"), { recursive: true });
    mkdirSync(join(repo, ".sandcastle", "commands"), { recursive: true });
    writeFileSync(
      join(repo, ".sandcastle", "agents.md"),
      "---\ntitle: Agents\nsummary: Core mode\ntags: [core]\nconstraints:\n  - run tests\n---\nBe careful.\n",
    );
    writeFileSync(
      join(repo, ".sandcastle", "skills", "tests.md"),
      "---\ntitle: Testing\ntriggerHints: [vitest]\n---\nWrite tests.\n",
    );
    writeFileSync(
      join(repo, ".sandcastle", "commands", "fix.md"),
      "---\ntitle: Fix\nslashCommand: /fix\nverifyHints: [npm test]\n---\nFix it.\n",
    );

    const deck = new DeckLoader().loadDeck(repo);

    expect(deck.mode).toMatchObject({
      id: "mode-default",
      title: "Agents",
      constraints: ["run tests"],
    });
    expect(deck.skills[0]).toMatchObject({
      id: "skill-tests",
      triggerHints: ["vitest"],
    });
    expect(deck.commands[0]).toMatchObject({
      id: "command-fix",
      slashCommand: "/fix",
      verifyHints: ["npm test"],
    });
  });

  it("returns empty sections when optional files are missing", () => {
    const deck = new DeckLoader().loadDeck(makeRepo());

    expect(deck.mode.body).toBe("");
    expect(deck.skills).toEqual([]);
    expect(deck.commands).toEqual([]);
  });

  it("skips malformed frontmatter and warns", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, ".sandcastle", "skills"), { recursive: true });
    writeFileSync(
      join(repo, ".sandcastle", "skills", "bad.md"),
      "---\ntitle: [unterminated\n---\nBad.\n",
    );
    const warn = vi.fn();

    const deck = new DeckLoader({ warn }).loadDeck(repo);

    expect(deck.skills).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });
});
