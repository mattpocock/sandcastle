// Mirrored from mattpocock/skills, skills/engineering/implement/, at
// UPSTREAM_COMMIT (./Skill.ts). Don't edit the text here: change it
// upstream, copy it again, and check with `npm run skills:check-mirror`.

import { defineSkill } from "./Skill.js";
import { trackerDoc } from "./trackerDoc.js";

const SKILL_MD = `---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

If the user passes a ticket reference, fetch it from the issue tracker described in [tracker.md](tracker.md) and state its title before starting. If the reference is ambiguous, ask.

Call the Skill tool with "tdd" where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, call the Skill tool with "code-review" to review the work.

Commit your work to the current branch.
`;

/** The `implement` skill. */
export const implement = defineSkill({
  name: "implement",
  files: (context) => ({
    "SKILL.md": SKILL_MD,
    "tracker.md": trackerDoc(context.tracker),
  }),
});
