/**
 * `reap`: the sandboxes still alive on each remote provider whose key is
 * present, and, with `--delete`, removing the ones Sandcastle made. The ledger
 * can't see a remote sandbox, so this is how a world proves it left none.
 * The accounts themselves (the SDK and REST calls) are in remoteAccounts.ts.
 */

export type RemoteProvider = "vercel" | "daytona" | "e2b" | "modal" | "sprites";
export const REMOTE_PROVIDERS: readonly RemoteProvider[] = [
  "vercel",
  "daytona",
  "e2b",
  "modal",
  "sprites",
];

export interface AliveSandbox {
  readonly id: string;
  /** The provider's own word for it: `running`, `paused`, `started`… */
  readonly state: string;
  /** Carries Sandcastle's mark (a Sprite named `sandcastle-…`, a Modal sandbox in the `sandcastle` App). */
  readonly ours: boolean;
}

export interface RemoteAccount {
  readonly provider: RemoteProvider;
  /** Key groups missing from the env; the account is skipped when any is. */
  readonly missing: () => readonly string[];
  /** Every sandbox on the account that is alive (costing money) now. */
  readonly list: () => Promise<readonly AliveSandbox[]>;
  readonly remove: (id: string) => Promise<void>;
}

export interface ReapOptions {
  readonly remove: boolean;
  /** Sandboxes named on the command line: Sandcastle's whatever their mark. */
  readonly named: ReadonlyMap<RemoteProvider, ReadonlySet<string>>;
}

const isProvider = (value: string): value is RemoteProvider =>
  REMOTE_PROVIDERS.some((p) => p === value);

/** `[--delete] [<provider>:<id>…]` */
export const parseReapArgs = (args: readonly string[]): ReapOptions => {
  const named = new Map<RemoteProvider, Set<string>>();
  let remove = false;
  for (const arg of args) {
    if (arg === "--delete") {
      remove = true;
      continue;
    }
    const at = arg.indexOf(":");
    const provider = arg.slice(0, at);
    const id = arg.slice(at + 1);
    if (at === -1 || !isProvider(provider) || id === "") {
      throw new Error(
        `reap: name a sandbox as <provider>:<id>, provider one of ${REMOTE_PROVIDERS.join(", ")}`,
      );
    }
    const ids = named.get(provider) ?? new Set<string>();
    ids.add(id);
    named.set(provider, ids);
  }
  return { remove, named };
};

const errorText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

interface AccountReport {
  readonly lines: string[];
  /** Sandboxes still alive, or a failure, after this account's turn. */
  readonly bad: number;
}

/** Deletes one sandbox when asked to and it is ours; returns its line. */
const handle = async (
  account: RemoteAccount,
  sandbox: AliveSandbox,
  options: ReapOptions,
): Promise<{ line: string; gone: boolean }> => {
  const ours =
    sandbox.ours ||
    (options.named.get(account.provider)?.has(sandbox.id) ?? false);
  const head = `    ${sandbox.id} (${sandbox.state})`;
  if (!ours) {
    return {
      line: `${head}, not known to be Sandcastle's: pass ${account.provider}:${sandbox.id} to delete it`,
      gone: false,
    };
  }
  if (!options.remove) {
    return { line: `${head}, Sandcastle's`, gone: false };
  }
  try {
    await account.remove(sandbox.id);
    return { line: `${head}, deleted`, gone: true };
  } catch (error) {
    return {
      line: `${head}, Sandcastle's, FAILED to delete: ${errorText(error)}`,
      gone: false,
    };
  }
};

const reapAccount = async (
  account: RemoteAccount,
  options: ReapOptions,
): Promise<AccountReport> => {
  const label = `  ${account.provider.padEnd(8)} `;
  const missing = account.missing();
  if (missing.length > 0) {
    return {
      lines: [`${label}skipped (missing ${missing.join(", ")})`],
      bad: 0,
    };
  }
  let alive: readonly AliveSandbox[];
  try {
    alive = await account.list();
  } catch (error) {
    return { lines: [`${label}ERROR listing: ${errorText(error)}`], bad: 1 };
  }
  const lines = [`${label}${alive.length} alive`];
  const handled = await Promise.all(
    alive.map(async (sandbox) => handle(account, sandbox, options)),
  );
  lines.push(...handled.map((h) => h.line));
  const bad = handled.filter((h) => !h.gone).length;
  const listed = new Set(alive.map((s) => s.id));
  for (const id of options.named.get(account.provider) ?? []) {
    if (!listed.has(id)) {
      lines.push(`    ${id}: named, but not alive`);
    }
  }
  return { lines, bad };
};

/** Exit code 0 only when nothing is left alive and every call worked. */
export const reap = async (
  accounts: readonly RemoteAccount[],
  options: ReapOptions,
): Promise<{ code: number; lines: string[] }> => {
  const reports = await Promise.all(
    accounts.map(async (account) => reapAccount(account, options)),
  );
  return {
    code: reports.some((r) => r.bad > 0) ? 1 : 0,
    lines: reports.flatMap((r) => r.lines),
  };
};
