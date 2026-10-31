/**
 * Which of a sandbox's env vars should never have reached it. Pure, so the
 * ledger's judgement is unit-tested (envLeaks.test.ts).
 */

export interface EnvLeak {
  readonly name: string;
  readonly reason: string;
}

export interface EnvContext {
  /** Keys the world's `.sandcastle/.env` declares: Sandcastle may pass these. */
  readonly declared: ReadonlySet<string>;
  /** Secret-looking variables of the host process, name → value. */
  readonly hostSecrets: ReadonlyMap<string, string>;
  /** A random value set in the world's env and declared nowhere. */
  readonly canary: string;
}

/** Every leaked variable in `env` (the sandbox's name/value pairs). */
export const classifyEnv = (
  env: readonly (readonly [string, string])[],
  ctx: EnvContext,
): EnvLeak[] => {
  const leaks: EnvLeak[] = [];
  for (const [name, value] of env) {
    if (ctx.canary && value.includes(ctx.canary)) {
      leaks.push({
        name,
        reason: "carries the world's canary, which no .env declares",
      });
      continue;
    }
    if (ctx.declared.has(name)) {
      continue;
    }
    if (ctx.hostSecrets.has(name)) {
      leaks.push({ name, reason: "a host secret the world never declared" });
      continue;
    }
    for (const [hostName, hostValue] of ctx.hostSecrets) {
      if (ctx.declared.has(hostName)) {
        continue;
      }
      if (value.includes(hostValue)) {
        leaks.push({
          name,
          reason: `carries the value of host ${hostName}, which the world never declared`,
        });
        break;
      }
    }
  }
  return leaks;
};
