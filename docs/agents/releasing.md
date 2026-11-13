# Releasing

Releases go through [changesets](https://github.com/changesets/changesets). On every push to `main`, `.github/workflows/release.yml` runs `changesets/action`:

- While `.changeset/` holds unreleased changesets, it opens (or updates) the **Version Packages** PR from `changeset-release/main`. That PR bumps `package.json` and writes `CHANGELOG.md`.
- Merging that PR is the release: the next run on `main` finds no changesets and publishes to npm (`npx changeset publish`).

## The release App

`release.yml` pushes the Version Packages PR with a token minted from a GitHub App, not `GITHUB_TOKEN`: GitHub never starts workflows for pushes made with `GITHUB_TOKEN`, so the PR's required checks (`ci`, `windows`) would never run. The App has no webhook, has Contents, Pull requests and Workflows set to read and write (Workflows because the release branch is reset onto `main`, and a push that changes `.github/workflows/` needs it), and is installed on this repo only. The workflow reads its Client ID from the repo variable `RELEASE_APP_CLIENT_ID` and its private key from the repo secret `RELEASE_APP_PRIVATE_KEY`. npm publishing is untouched: it still uses trusted publishing (`id-token: write`).

## Before you merge the Version Packages PR

Run the local tests on the PR's branch, with Docker and Podman both running:

```sh
gh pr checkout <version-packages-pr>
npm ci
npm run test:local
```

Merge only when it passes. CI can't run these: its machines have no container engine, so `npm test` and CI never see `tests/local/`. They are the only tests that start real `docker()` and `podman()` containers (the `sandcastle docker` CLI too), so a release that skips them ships container adapters nothing has run.

- A missing or stopped engine fails the run, with a message naming it. That is on purpose: a run that skipped an engine must not look like a pass.
- `SANDCASTLE_LOCAL_ENGINES=docker` (or `podman`) narrows a run to one engine, for working on one adapter. A narrowed run does not clear a release.
- It takes under a minute once the base image (`alpine:3.20`) is pulled. It builds its own small test images and removes them, and the containers and networks it starts, when it finishes.

## Writing local tests

Local tests live in `tests/local/` and follow the same rules as the rest of `tests/` (public API only, imported by package name; see `.sandcastle/CODING_STANDARDS.md`, "Where tests live"). Put a test there only when it needs a real engine; anything that can run without one belongs in `tests/`, where CI runs it. `vitest.local.config.ts` runs them, and `tests/local/globalSetup.ts` checks the engines and builds the shared images.

To count them toward deleting a legacy test, pass `--local` to the coverage gate: `npm run coverage:gate -- <file> --local`.
