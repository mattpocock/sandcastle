---
"@ai-hero/sandcastle": patch
---

`vercel()` now reads `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` from the environment when the matching options aren't passed. Before, a token in the environment was ignored and `vercel()` failed with "Could not get credentials from OIDC context". A token without a team or project id now fails naming the missing variable.
