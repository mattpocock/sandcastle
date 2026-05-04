import { join } from "node:path";
import { Context, Layer } from "effect";

/**
 * Host- and sandbox-side `projects` directories used by the orchestrator when
 * capturing and resuming agent sessions.
 */
export class SessionPaths extends Context.Tag("SessionPaths")<
  SessionPaths,
  {
    /** Host path to the agent session projects directory. */
    readonly hostProjectsDir: string;
    /** Sandbox path to the agent session projects directory. */
    readonly sandboxProjectsDir: string;
  }
>() {}

/** Build a `SessionPaths` layer with explicit host and sandbox project directories. */
export const sessionPathsLayer = (config: {
  readonly hostProjectsDir: string;
  readonly sandboxProjectsDir: string;
}): Layer.Layer<SessionPaths> => Layer.succeed(SessionPaths, config);

/**
 * Default `SessionPaths` layer using Sandcastle's conventional session
 * locations: `~/.claude/projects` on the host and
 * `/home/agent/.claude/projects` in the sandbox.
 */
export const defaultSessionPathsLayer: Layer.Layer<SessionPaths> = Layer.sync(
  SessionPaths,
  () => ({
    hostProjectsDir: join(process.env.HOME ?? "~", ".claude", "projects"),
    sandboxProjectsDir: join("/home/agent", ".claude", "projects"),
  }),
);
