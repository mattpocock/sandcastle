import { assertBwrapUsable } from "./bwrapPreflight.js";
import { assertSeatbeltUsable } from "./seatbeltPreflight.js";

/**
 * A sandbox provider `sandcastle init` offers: one with a v1 factory at
 * `@ai-hero/sandcastle/v1/sandboxes/<name>`, which the main file calls.
 */
export interface SandboxProviderEntry {
  /** The factory name, which is also its `/v1/sandboxes/<name>` subpath. */
  readonly name: string;
  readonly label: string;
  /**
   * The factory call written into the main file, indented for its place
   * there (`provider: <call>,` inside `createSandbox({ ... })`). It names each of
   * `credentials` as a variable, which the main file takes out of
   * `.sandcastle/.env` so it stays on the host.
   */
  readonly call: string;
  /** Env vars the provider itself needs, kept out of the sandbox's env. */
  readonly credentials: readonly string[];
  /** Lines to append to `.env.example` for `credentials`, or "" when none. */
  readonly envExample: string;
  /** The vendor SDK the factory loads: an optional peer dependency. */
  readonly peerDependency?: string;
  /** What the sandbox runs on, for init's next steps. */
  readonly setupNote: string;
  /**
   * The provider runs the host's own programs, so the agent CLI must be on
   * the host `PATH`. Init warns when it isn't.
   */
  readonly runsHostPrograms: boolean;
  /**
   * The one host OS a native provider runs on. Init offers it first (and
   * preselects it) on that OS, and doesn't offer it on any other.
   * `--sandbox <name>` still accepts it anywhere.
   */
  readonly nativePlatform?: NodeJS.Platform;
  /**
   * The native provider's host check: throws `NativeSandboxUnavailableError`
   * (whose message names the fix) when the host can't run it. Init runs it
   * and warns, but still scaffolds.
   */
  readonly preflight?: () => void;
}

const IMAGE_NOTE =
  "Build an image with Node LTS, git and the agent's CLI, and put its name in the main file (it says `my-agent-image` now).";

const SANDBOX_PROVIDER_REGISTRY: readonly SandboxProviderEntry[] = [
  {
    name: "bwrap",
    label: "Bubblewrap",
    call: "bwrap()",
    credentials: [],
    envExample: "",
    setupNote:
      "bwrap() runs your host's own Node, git, gh and agent CLI, read-only, so install them on the host.",
    runsHostPrograms: true,
    nativePlatform: "linux",
    preflight: assertBwrapUsable,
  },
  {
    name: "seatbelt",
    label: "Seatbelt",
    call: "seatbelt()",
    credentials: [],
    envExample: "",
    setupNote:
      "seatbelt() runs your host's own Node, git, gh and agent CLI, so install them on the host.",
    runsHostPrograms: true,
    nativePlatform: "darwin",
    preflight: assertSeatbeltUsable,
  },
  {
    name: "docker",
    label: "Docker",
    call: 'docker({ image: "my-agent-image" })',
    credentials: [],
    envExample: "",
    setupNote: IMAGE_NOTE,
    runsHostPrograms: false,
  },
  {
    name: "podman",
    label: "Podman",
    call: 'podman({ image: "my-agent-image" })',
    credentials: [],
    envExample: "",
    setupNote: IMAGE_NOTE,
    runsHostPrograms: false,
  },
  {
    name: "daytona",
    label: "Daytona",
    call: "daytona({ apiKey: DAYTONA_API_KEY })",
    credentials: ["DAYTONA_API_KEY"],
    envExample: `# Daytona API key. Stays on this machine: the main file keeps it out of the sandbox.
DAYTONA_API_KEY=`,
    peerDependency: "@daytona/sdk",
    setupNote:
      "Name a Daytona snapshot with Node, git and the agent's CLI in daytona({ create: { snapshot } }), or install the CLI with a setup exec.",
    runsHostPrograms: false,
  },
  {
    name: "e2b",
    label: "E2B",
    call: "e2b({ apiKey: E2B_API_KEY })",
    credentials: ["E2B_API_KEY"],
    envExample: `# E2B API key. Stays on this machine: the main file keeps it out of the sandbox.
E2B_API_KEY=`,
    peerDependency: "e2b",
    setupNote:
      "E2B's default `claude` template has Claude Code; for another agent, name a template with its CLI in e2b({ create: { template } }).",
    runsHostPrograms: false,
  },
  {
    name: "modal",
    label: "Modal",
    call: `modal({
    tokenId: MODAL_TOKEN_ID,
    tokenSecret: MODAL_TOKEN_SECRET,
  })`,
    credentials: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"],
    envExample: `# Modal token. Stays on this machine: the main file keeps it out of the sandbox.
MODAL_TOKEN_ID=
MODAL_TOKEN_SECRET=`,
    peerDependency: "modal",
    setupNote:
      "modal()'s default image has Claude Code; for another agent, pass an image with its CLI in modal({ image }).",
    runsHostPrograms: false,
  },
  {
    name: "sprites",
    label: "Sprites",
    call: "sprites({ token: SPRITES_TOKEN })",
    credentials: ["SPRITES_TOKEN"],
    envExample: `# Sprites API token. Stays on this machine: the main file keeps it out of the sandbox.
SPRITES_TOKEN=`,
    peerDependency: "@fly/sprites",
    setupNote:
      "The Sprites base image has Claude Code; install another agent's CLI with a setup exec.",
    runsHostPrograms: false,
  },
  {
    name: "vercel",
    label: "Vercel",
    call: `vercel({
    token: VERCEL_TOKEN,
    teamId: VERCEL_TEAM_ID,
    projectId: VERCEL_PROJECT_ID,
  })`,
    credentials: ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"],
    envExample: `# Vercel access token, with the team and project the sandboxes belong to.
# They stay on this machine: the main file keeps them out of the sandbox.
VERCEL_TOKEN=
VERCEL_TEAM_ID=
VERCEL_PROJECT_ID=`,
    peerDependency: "@vercel/sandbox",
    setupNote:
      "Vercel's default image has the Claude Code and Codex CLIs; install another agent's CLI with a setup exec.",
    runsHostPrograms: false,
  },
  {
    name: "host",
    label: "Host (no isolation)",
    call: "host()",
    credentials: [],
    envExample: "",
    setupNote:
      "host() runs sessions on this machine, as you, with no isolation. It needs Node, git and the agent CLI on your PATH.",
    runsHostPrograms: true,
  },
];

export const listSandboxProviders = (): readonly SandboxProviderEntry[] =>
  SANDBOX_PROVIDER_REGISTRY;

/**
 * The providers init's interactive prompt offers on `platform`, in order: the
 * host's native provider first (the one to preselect, marked recommended),
 * then the rest. Other OSes' native providers aren't offered.
 */
export const listSandboxProviderChoices = (
  platform: NodeJS.Platform,
): {
  readonly entry: SandboxProviderEntry;
  readonly recommended: boolean;
}[] => {
  const native = SANDBOX_PROVIDER_REGISTRY.filter(
    (p) => p.nativePlatform === platform,
  );
  const others = SANDBOX_PROVIDER_REGISTRY.filter(
    (p) => p.nativePlatform === undefined,
  );
  return [
    ...native.map((entry) => ({ entry, recommended: true })),
    ...others.map((entry) => ({ entry, recommended: false })),
  ];
};

/**
 * Why the host can't run `sandboxProvider`, as a warning naming the fix, or
 * undefined when it can (or the provider has no host check).
 */
export const sandboxProviderPreflightWarning = (
  sandboxProvider: SandboxProviderEntry,
): string | undefined => {
  try {
    sandboxProvider.preflight?.();
    return undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `This host can't run ${sandboxProvider.name}() yet, so the scaffolded main file fails until you fix it. ${reason}`;
  }
};

export const getSandboxProvider = (
  name: string,
): SandboxProviderEntry | undefined =>
  SANDBOX_PROVIDER_REGISTRY.find((p) => p.name === name);
