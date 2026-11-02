/**
 * The remote providers' accounts, as `reap` sees them: list what is alive,
 * remove one. Keys come from the env (lib.ts loadKeys) and are never printed.
 *
 * Sandcastle's mark: Sprites are named `sandcastle-<uuid>`, and Modal
 * sandboxes go in the `sandcastle` App. Vercel, Daytona and E2B sandboxes
 * carry no mark, so `reap` deletes one of those only when named by id.
 */
import { missingKeys, redact, SANDBOX_NEEDS } from "./lib.ts";
import { parseReapArgs, reap, REMOTE_PROVIDERS } from "./reap.ts";
import type { AliveSandbox, RemoteAccount, RemoteProvider } from "./reap.ts";

const env = (name: string): string => process.env[name] ?? "";

// --- Vercel: REST, since @vercel/sandbox isn't a dev dependency ------------

const VERCEL_API = "https://api.vercel.com/v1/sandboxes";
const VERCEL_DEAD = new Set(["stopped", "failed", "aborted"]);

const vercelFetch = async (url: string, method = "GET"): Promise<unknown> => {
  const response = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${env("VERCEL_TOKEN")}` },
  });
  if (!response.ok) {
    throw new Error(`${method} ${response.status} ${response.statusText}`);
  }
  return response.json();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** One page of `GET /v1/sandboxes`, newest first. */
const vercelPage = async (
  until: unknown,
): Promise<{ sandboxes: AliveSandbox[]; next: unknown; all: number }> => {
  const query = new URLSearchParams({
    project: env("VERCEL_PROJECT_ID"),
    teamId: env("VERCEL_TEAM_ID"),
    limit: "100",
  });
  if (typeof until === "number") {
    query.set("until", String(until));
  }
  const body = await vercelFetch(`${VERCEL_API}?${query}`);
  const items =
    isRecord(body) && Array.isArray(body.sandboxes) ? body.sandboxes : [];
  const sandboxes: AliveSandbox[] = [];
  for (const item of items) {
    if (isRecord(item) && typeof item.id === "string") {
      const state = typeof item.status === "string" ? item.status : "unknown";
      if (!VERCEL_DEAD.has(state)) {
        sandboxes.push({ id: item.id, state, ours: false });
      }
    }
  }
  const next =
    isRecord(body) && isRecord(body.pagination)
      ? body.pagination.next
      : undefined;
  return { sandboxes, next, all: items.length };
};

/** Walks the pages from `until` on. A stopped sandbox stays listed forever,
 *  so the walk stops after `pagesLeft` pages of 100. */
const vercelList = async (
  until?: unknown,
  pagesLeft = 20,
): Promise<AliveSandbox[]> => {
  const { sandboxes, next, all } = await vercelPage(until);
  if (all === 0 || typeof next !== "number" || pagesLeft <= 1) {
    return sandboxes;
  }
  return [...sandboxes, ...(await vercelList(next, pagesLeft - 1))];
};

const vercelAccount: RemoteAccount = {
  provider: "vercel",
  // Only a long-lived token: an OIDC token names no team or project here.
  missing: () =>
    missingKeys([["VERCEL_TOKEN"], ["VERCEL_TEAM_ID"], ["VERCEL_PROJECT_ID"]]),
  list: async () => vercelList(),
  remove: async (id) => {
    const query = new URLSearchParams({ teamId: env("VERCEL_TEAM_ID") });
    await vercelFetch(
      `${VERCEL_API}/${encodeURIComponent(id)}/stop?${query}`,
      "POST",
    );
  },
};

// --- Daytona -----------------------------------------------------------------

const DAYTONA_DORMANT = new Set([
  "archived",
  "archiving",
  "destroyed",
  "destroying",
]);

const daytonaClient = async () => {
  const { Daytona } = await import("@daytona/sdk");
  return new Daytona();
};

const daytonaAccount: RemoteAccount = {
  provider: "daytona",
  missing: () => missingKeys(SANDBOX_NEEDS.daytona.keys),
  list: async () => {
    const client = await daytonaClient();
    const alive: AliveSandbox[] = [];
    for await (const sandbox of client.list()) {
      const state = sandbox.state ?? "unknown";
      // A stopped sandbox still holds its disk, so it counts; an archived
      // one is in cold storage, and listing all of them would bury the rest.
      if (!DAYTONA_DORMANT.has(state)) {
        alive.push({ id: sandbox.id, state, ours: false });
      }
    }
    return alive;
  },
  remove: async (id) => {
    const client = await daytonaClient();
    await client.delete(await client.get(id));
  },
};

// --- E2B -----------------------------------------------------------------------

const e2bAccount: RemoteAccount = {
  provider: "e2b",
  missing: () => missingKeys(SANDBOX_NEEDS.e2b.keys),
  list: async () => {
    const { Sandbox } = await import("e2b");
    const paginator = Sandbox.list({
      query: { state: ["running", "paused"] },
    });
    const drain = async (): Promise<AliveSandbox[]> => {
      if (!paginator.hasNext) {
        return [];
      }
      const page = await paginator.nextItems();
      const alive = page.map((info) => ({
        id: info.sandboxId,
        state: info.state,
        ours: false,
      }));
      return [...alive, ...(await drain())];
    };
    return drain();
  },
  remove: async (id) => {
    const { Sandbox } = await import("e2b");
    await Sandbox.kill(id);
  },
};

// --- Modal ---------------------------------------------------------------------

/** Sandcastle's default App (`modal({ appName })` in src/sandboxes/modal.ts). */
const MODAL_APP = "sandcastle";

const modalAccount: RemoteAccount = {
  provider: "modal",
  missing: () => missingKeys(SANDBOX_NEEDS.modal.keys),
  list: async () => {
    const { ModalClient, NotFoundError } = await import("modal");
    const client = new ModalClient();
    try {
      const app = await client.apps
        .fromName(MODAL_APP)
        .catch((error: unknown) => {
          if (error instanceof NotFoundError) {
            return undefined;
          }
          throw error;
        });
      const alive: AliveSandbox[] = [];
      if (app === undefined) {
        return alive;
      }
      // `list()` misses sandboxes on Modal's V2 backend; this lists both.
      for await (const sandbox of client.sandboxes.experimentalList({
        appId: app.appId,
      })) {
        alive.push({ id: sandbox.sandboxId, state: "running", ours: true });
      }
      return alive;
    } finally {
      client.close();
    }
  },
  remove: async (id) => {
    const { ModalClient } = await import("modal");
    const client = new ModalClient();
    try {
      const sandbox = await client.sandboxes.fromId(id);
      await sandbox.terminate();
    } finally {
      client.close();
    }
  },
};

// --- Sprites -------------------------------------------------------------------

const SPRITE_PREFIX = "sandcastle-";

const spritesClient = async () => {
  const { SpritesClient } = await import("@fly/sprites");
  return new SpritesClient(env("SPRITES_TOKEN") || env("SPRITE_TOKEN"));
};

const spritesAccount: RemoteAccount = {
  provider: "sprites",
  missing: () => missingKeys(SANDBOX_NEEDS.sprites.keys),
  list: async () => {
    const client = await spritesClient();
    // Sprites persist until deleted, so every one listed is alive.
    const sprites = await client.listAllSprites();
    return sprites.map((sprite) => ({
      id: sprite.name,
      state: sprite.status ?? "unknown",
      ours: sprite.name.startsWith(SPRITE_PREFIX),
    }));
  },
  remove: async (id) => {
    const client = await spritesClient();
    await client.deleteSprite(id);
  },
};

export const REMOTE_ACCOUNTS: Readonly<Record<RemoteProvider, RemoteAccount>> =
  {
    vercel: vercelAccount,
    daytona: daytonaAccount,
    e2b: e2bAccount,
    modal: modalAccount,
    sprites: spritesAccount,
  };

/** `npm run -s verify -- reap [--delete] [<provider>:<id>…]`; returns the exit code. */
export const reapVerb = async (args: readonly string[]): Promise<number> => {
  const options = parseReapArgs(args);
  const { code, lines } = await reap(
    REMOTE_PROVIDERS.map((provider) => REMOTE_ACCOUNTS[provider]),
    options,
  );
  console.log(
    `remote sandboxes${options.remove ? " (--delete)" : ""}:\n${redact(lines.join("\n"))}`,
  );
  return code;
};
