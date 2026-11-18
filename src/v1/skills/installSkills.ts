import { Effect } from "effect";
import type { Sandbox } from "../Sandbox.js";
import { joinInSandbox } from "../sandboxPath.js";
import { HOME_PROBE } from "../supervisorHost.js";
import { InstallSkillsError } from "./InstallSkillsError.js";
import type { Skill, SkillsAgent, SkillsContext } from "./Skill.js";

/** Each agent's user skills folder, relative to the sandbox user's home. */
const SKILLS_FOLDER: Readonly<Record<SkillsAgent, readonly string[]>> = {
  claudeCode: [".claude", "skills"],
};

const attempt = <A>(message: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new InstallSkillsError({ message, cause }),
  });

const homeOf = (sandbox: Sandbox) =>
  attempt("Couldn't find the sandbox user's home", () =>
    sandbox.exec(HOME_PROBE),
  ).pipe(Effect.map((result) => result.stdout.trim()));

/**
 * Renders `skills` for `context` on the host and writes them into the
 * sandbox, at `<home>/<agent's skills folder>/<skill>/<file>`.
 */
export const installSkills = (
  sandbox: Sandbox,
  skills: readonly Skill[],
  context: SkillsContext,
) =>
  Effect.gen(function* () {
    const folder = joinInSandbox(
      yield* homeOf(sandbox),
      ...SKILLS_FOLDER[context.agent],
    );
    const writes = skills.flatMap((skill) =>
      Object.entries(skill.files(context)).map(([file, content]) => {
        const filePath = joinInSandbox(folder, skill.name, file);
        return attempt(`Couldn't write ${filePath}`, () =>
          sandbox.writeTextFile({ path: filePath, content }),
        );
      }),
    );
    yield* Effect.all(writes, { concurrency: 8 });
  });
