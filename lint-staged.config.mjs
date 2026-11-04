// Biome formats staged files only (its linter is off; oxlint owns linting).
// --no-errors-on-unmatched: staged files that biome.json ignores (dist,
// .changeset, api-report) are skipped instead of failing the hook.
export default {
  "*.{ts,tsx,js,jsx,mjs,cjs,json,md,yml,yaml}":
    "biome format --write --no-errors-on-unmatched",
};
