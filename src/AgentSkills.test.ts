import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SANDBOX_SKILLS_DIR,
  buildSkillsPromptPreamble,
  exposeSkillsViaHostPaths,
  prependSkillsPrompt,
  resolveSkills,
} from "./AgentSkills.js";

const tempDirs: string[] = [];

const makeTempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandcastle-skills-"));
  tempDirs.push(dir);
  return dir;
};

const makeSkill = async (root: string, name: string) => {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill\n---\n\n# ${name}\n`,
  );
  return dir;
};

describe("AgentSkills", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.map((d) => rm(d, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  describe("resolveSkills", () => {
    it("resolves a skill directory to a stable sandbox path", async () => {
      const root = await makeTempDir();
      const source = await makeSkill(root, "tdd");

      const [skill] = resolveSkills({
        cwd: root,
        skills: [{ source }],
      });

      expect(skill).toEqual({
        name: "tdd",
        hostPath: source,
        sandboxPath: `${DEFAULT_SANDBOX_SKILLS_DIR}/tdd`,
        readonly: true,
      });
    });

    it("resolves relative sources against the supplied cwd", async () => {
      const root = await makeTempDir();
      const source = await makeSkill(root, "relative-skill");

      const [skill] = resolveSkills({
        cwd: root,
        skills: [{ source: "relative-skill" }],
      });

      expect(skill?.hostPath).toBe(source);
      expect(skill?.sandboxPath).toBe(
        `${DEFAULT_SANDBOX_SKILLS_DIR}/relative-skill`,
      );
    });

    it("uses an explicit name and readonly override", async () => {
      const root = await makeTempDir();
      const source = await makeSkill(root, "source-dir");

      const [skill] = resolveSkills({
        cwd: root,
        skills: [{ source, name: "custom.name", readonly: false }],
      });

      expect(skill).toMatchObject({
        name: "custom.name",
        sandboxPath: `${DEFAULT_SANDBOX_SKILLS_DIR}/custom.name`,
        readonly: false,
      });
    });

    it("fails when source does not exist", async () => {
      const root = await makeTempDir();

      expect(() =>
        resolveSkills({ cwd: root, skills: [{ source: "missing" }] }),
      ).toThrow("Skill source does not exist");
    });

    it("fails when source is not a directory", async () => {
      const root = await makeTempDir();
      await writeFile(join(root, "not-a-dir"), "nope");

      expect(() =>
        resolveSkills({ cwd: root, skills: [{ source: "not-a-dir" }] }),
      ).toThrow("Skill source must be a directory");
    });

    it("fails when SKILL.md is missing", async () => {
      const root = await makeTempDir();
      await mkdir(join(root, "not-a-skill"), { recursive: true });

      expect(() =>
        resolveSkills({ cwd: root, skills: [{ source: "not-a-skill" }] }),
      ).toThrow("SKILL.md");
    });

    it("fails on unsafe skill names", async () => {
      const root = await makeTempDir();
      const source = await makeSkill(root, "safe-source");

      expect(() =>
        resolveSkills({ cwd: root, skills: [{ source, name: "../bad" }] }),
      ).toThrow("Invalid skill name");
    });
  });

  describe("buildSkillsPromptPreamble", () => {
    it("returns an empty preamble when no skills are configured", () => {
      expect(buildSkillsPromptPreamble([])).toBe("");
    });

    it("builds a prompt preamble listing skill entrypoints", () => {
      const preamble = buildSkillsPromptPreamble([
        {
          name: "tdd",
          hostPath: "/host/tdd",
          sandboxPath: `${DEFAULT_SANDBOX_SKILLS_DIR}/tdd`,
          readonly: true,
        },
      ]);

      expect(preamble).toContain("# Available Skills");
      expect(preamble).toContain(`${DEFAULT_SANDBOX_SKILLS_DIR}/tdd/SKILL.md`);
      expect(preamble).toContain("Do not modify or commit skill files");
    });
  });

  describe("prependSkillsPrompt", () => {
    it("prepends the skill preamble before the original prompt", () => {
      const prompt = prependSkillsPrompt("Do the work.", [
        {
          name: "tdd",
          hostPath: "/host/tdd",
          sandboxPath: `${DEFAULT_SANDBOX_SKILLS_DIR}/tdd`,
          readonly: true,
        },
      ]);

      expect(prompt).toContain("# Available Skills");
      expect(prompt).toContain("---\n\nDo the work.");
    });
  });

  describe("exposeSkillsViaHostPaths", () => {
    it("uses host paths when a no-sandbox provider runs directly on the host", () => {
      const [skill] = exposeSkillsViaHostPaths([
        {
          name: "tdd",
          hostPath: "/host/tdd",
          sandboxPath: `${DEFAULT_SANDBOX_SKILLS_DIR}/tdd`,
          readonly: true,
        },
      ]);

      expect(skill?.sandboxPath).toBe("/host/tdd");
    });
  });
});
