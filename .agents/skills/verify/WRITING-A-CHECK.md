# Writing a check

Copy the nearest check in `.sandcastle/verify/` to `.sandcastle/verify/<slug>.ts`, keeping its shape: one `verify()` call on `harness.ts` (its header and exports are the API), with prerequisites first, then setup, then assertions.

- **Prerequisites.** `requireEnv` every key the combination needs and `requireCommand` every daemon, so a gap becomes UNVERIFIABLE naming it rather than a FAILED.
- **Deterministic assertions.** Assert only on observables: exit codes, commit counts, a file's exact content, a fixed string in the output. When an agent runs inside the sandbox, prompt it for one fixed artefact (one file holding one line, one commit) so the model's wording never decides the verdict.
- **Faithful path.** Drive the same entry point a user would: `sandcastleCli(["init", …])` plus the scaffolded `main.ts` for init claims, or the `run()` / `createSandbox()` call the claim names. Keep the combination from step 2: a stand-in agent binary or another agent is a different combination, so run it only as a separately labelled extra and keep it out of the verdict.
- **Image fallback.** If the stock `sandcastle init` image can't build (the network blocks apt or the Claude installer) and the claim doesn't need the agent CLI, build this minimal image with `sandcastle docker build-image --dockerfile <path>`. A claim that needs the agent CLI is UNVERIFIABLE here instead.

  ```Dockerfile
  FROM node:22-bookworm
  ARG AGENT_UID=1000
  ARG AGENT_GID=1000
  RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
  USER ${AGENT_UID}:${AGENT_GID}
  WORKDIR /home/agent
  ENTRYPOINT ["sleep", "infinity"]
  ```

- **Teardown.** Register anything outside the scratch repo (containers, hooks, git config) with `onCleanup`, so this checkout's working tree stays clean.

Done when the check has one `check.expect` per part of the claim and runs to a `RESULT:` line.
