# Sandboxes

Every sandbox gets the same env (`src/EnvResolver.ts:56`, `src/mergeProviderEnv.ts:8`):

- **Declared keys only.** Sandcastle reads `<cwd>/.sandcastle/.env`. For each key declared there, it takes the file's value, or, when that is empty, `process.env`'s. Undeclared host variables never pass.
- **Provider and agent env go on top.** It then merges the provider's `env` and the agent factory's `env`, and throws when the two share a key.

Ledger section (e) checks the result against the world's canary and every undeclared host secret.

## docker (`@ai-hero/sandcastle/sandboxes/docker`, bind-mount)

- **Entry:** `docker({ imageName?, mounts?, env?, network?, … })` (`src/sandboxes/docker.ts:126`).
- **What it creates** (`src/DockerLifecycle.ts:156-170`):
  - A container named `sandcastle-<uuid>`, started with `docker run -d`, `-e` for each key, `HOME=/home/agent`, `--user <host uid>:<gid>`, workdir `/home/agent/workspace`.
  - No `--rm` and no labels.
- **Cleanup:** `docker stop` and `rm` on close; `docker rm -f` on SIGINT/SIGTERM.
- **Proof:**
  - The run's result, per its entry point.
  - Ledger (c) shows no container and (e) shows only declared keys.
  - The harness prints `[verify] observed docker:sandcastle-… env ok` while the run is live.
- **Ready when** `docker info` works.

## podman (`…/sandboxes/podman`, bind-mount)

- **Entry:** `podman({ …docker's options, userns? })` (`src/sandboxes/podman.ts:139`).
- **What it creates:**
  - A container `sandcastle-<uuid>`, started with `--userns=keep-id:uid=N,gid=N` and `--entrypoint sleep … infinity`.
  - The uid defaults to 1000, not the host's.
- **Cleanup:** `podman rm -f` on close and on signals.
- **Proof:** as docker. The harness observes podman containers too.
- **Ready when** `podman info` works. Init builds a `Containerfile` with no UID args.

## vercel (`…/sandboxes/vercel`, isolated)

- **Entry:** `vercel({ token?, projectId?, teamId?, env?, … })` (`src/sandboxes/vercel.ts:134`).
- **Peer dependency:** `@vercel/sandbox`, which a world lacks. Add it as a user would: `npm run -s verify -- sh <run> npm install @vercel/sandbox`, then commit.
- **Auth:** `VERCEL_TOKEN` with `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` (all three, read by Sandcastle; a token without the ids fails naming the missing one). With no token, the SDK reads `VERCEL_OIDC_TOKEN`. An OIDC token expires (about 12 hours), so a `doctor` "ready" can still fail at create; that failure is UNVERIFIABLE, naming the token.
- **Behaviour:**
  - With no `runtime`, the sandbox starts from Vercel's default image (`vercel/sandbox/universal` in `@vercel/sandbox` 3.x): user `ubuntu`, `HOME=/vercel`, and the `claude` CLI on the PATH. The named runtimes (`node24`, `node22`) ship no agent CLI, so install it in an `onSandboxReady` hook.
  - The repo lands at `/vercel/sandbox/workspace`, synced in and out as in [branch-strategies.md](branch-strategies.md).
  - The default strategy is merge-to-head.
  - `close()` calls `sandbox.stop()`. Nothing stops it on SIGINT.
- **Proof:**
  - The commits are on the host branch, per the strategy.
  - No `.sandcastle/patches/` remain.
  - Ledger (c) and (e) can't see a remote sandbox and say so, so env and teardown claims need the SDK's own listing.

## daytona (`…/sandboxes/daytona`, isolated)

- **Entry:** `daytona({ apiKey?, apiUrl?, target?, create?, env? })` (`src/sandboxes/daytona.ts:80`).
- **Auth:** falls back to `DAYTONA_API_KEY` / `DAYTONA_API_URL` / `DAYTONA_TARGET`.
- **Peer dependency:** `@daytona/sdk`.
- **Behaviour:** `close()` deletes the sandbox. Sync works as vercel's.
- **Suspected:** the merged env is never passed to `create` (see the README's suspected list).
- **Proof:** as vercel.

## noSandbox: never run

`noSandbox()` runs the agent on this host with the host's **whole** env (`src/sandboxes/no-sandbox.ts:50`). That is unsafe here, and no sandbox seam exists to test. Its claims are proved by vitest tests beside `src/sandboxes/no-sandbox.ts` and reported as `VERIFIED (unit test)` or `FAILED (unit test)`, naming the test. `interactive()` and `wt.interactive()` default to it, so always pass a sandbox.
