/**
 * Auth for the Vercel sandbox provider (`./vercel.ts`): the token, team and
 * project ids `Sandbox.create()` takes, from options or env vars.
 */

/** The auth options of `VercelOptions`. */
export interface VercelAuthOptions {
  readonly token?: string;
  readonly teamId?: string;
  readonly projectId?: string;
}

/** An option or env var counts as unset when it is missing or empty. */
const setOrUndefined = (value: string | undefined): string | undefined =>
  value === "" ? undefined : value;

/**
 * Resolve the auth params for `Sandbox.create()`.
 *
 * `@vercel/sandbox` only accepts a token as an explicit param, together with
 * `teamId` and `projectId` (all three or none); otherwise it falls back to
 * OIDC. So read `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`
 * here, explicit options first.
 */
export const resolveVercelAuth = (
  options: VercelAuthOptions | undefined,
): { token?: string; teamId?: string; projectId?: string } => {
  const { env } = process;
  const tokenOption = setOrUndefined(options?.token);
  const teamIdOption = setOrUndefined(options?.teamId);
  const projectIdOption = setOrUndefined(options?.projectId);
  const token = tokenOption ?? setOrUndefined(env.VERCEL_TOKEN);

  if (token === undefined) {
    // No token: the SDK's OIDC flow, which may use team/project ids as hints.
    return {
      ...(teamIdOption === undefined ? {} : { teamId: teamIdOption }),
      ...(projectIdOption === undefined ? {} : { projectId: projectIdOption }),
    };
  }

  const teamId = teamIdOption ?? setOrUndefined(env.VERCEL_TEAM_ID);
  const projectId = projectIdOption ?? setOrUndefined(env.VERCEL_PROJECT_ID);
  const missing = [
    teamId === undefined ? "VERCEL_TEAM_ID (or the teamId option)" : null,
    projectId === undefined
      ? "VERCEL_PROJECT_ID (or the projectId option)"
      : null,
  ].filter((name): name is string => name !== null);

  if (missing.length > 0) {
    const source =
      tokenOption === undefined ? "VERCEL_TOKEN" : "the token option";
    throw new Error(
      `vercel(): ${source} is set, but a Vercel token also needs a team and project id. ` +
        `Missing: ${missing.join(", ")}.`,
    );
  }

  return { token, teamId, projectId };
};
