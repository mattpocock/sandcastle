/** The agent a skill is installed for. Only Claude Code in v1. */
export type SkillsAgent = "claudeCode";

/** Where the run's tickets and specs live, as text the skills can follow. */
export type Tracker =
  | { readonly kind: "github" }
  | {
      readonly kind: "custom";
      /** The tracker's name, used as the title of its doc. */
      readonly name: string;
      /** How to read, create and comment on its tickets, in prose. */
      readonly instructions: string;
    };

/** What a skill's files are rendered from. Strings only, the same for every skill. */
export interface SkillsContext {
  /** Decides where the skills are installed, never what they say. */
  readonly agent: SkillsAgent;
  readonly tracker: Tracker;
}

/** The public skills repository the in-repo skills are mirrored from. */
export const UPSTREAM_REPO = "mattpocock/skills";

/** The upstream commit every in-repo skill was copied at. */
export const UPSTREAM_COMMIT = "4ae2317ddb22b046e26455e4f9c9b3aaaf62212d";

/** Where a skill came from upstream. */
export interface SkillUpstream {
  readonly repo: string;
  readonly commit: string;
  /** The skill's folder in the upstream repository. */
  readonly path: string;
}

/** A skill: its name, its upstream source, and its files rendered for a context. */
export interface Skill {
  /** The folder and slash-command name, e.g. `implement`. */
  readonly name: string;
  readonly upstream: SkillUpstream;
  /** Every file in the skill's folder, by path relative to it. */
  readonly files: (context: SkillsContext) => Readonly<Record<string, string>>;
}

/** Defines a skill mirrored from `UPSTREAM_REPO` at `UPSTREAM_COMMIT`. */
export const defineSkill = (skill: {
  readonly name: string;
  readonly files: Skill["files"];
}): Skill => ({
  ...skill,
  upstream: {
    repo: UPSTREAM_REPO,
    commit: UPSTREAM_COMMIT,
    path: `skills/engineering/${skill.name}`,
  },
});
