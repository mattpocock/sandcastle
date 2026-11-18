import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { SpawnOptions } from "@fly/sprites";
import { killProcessTrees } from "./processTree.js";

// A stand-in for `@fly/sprites`, for `vi.mock`: just the calls sprites()
// makes, backed by real `sh` processes and a host directory per sprite, so
// the real session supervisor runs in it. The sprite's `/home/sprite` is
// `<root>/<name>/home` and its `/tmp/sandcastle-…` folders are under
// `<root>/<name>/tmp`: the fake rewrites those prefixes in commands, file
// paths and written files, and turns the home back into `/home/sprite` in
// output and files read, so both sides see the sprite's own paths. `curl`
// and `sudo` are shims: `curl` logs its arguments (the Task API calls) to
// `<root>/<name>.curl.log`, `sudo` runs its command. Like the SDK, an exec's URL carries its command line and `env` in its query
// string, and a failed connection's error prints that URL. Every call is
// recorded for the tests to assert on. POSIX only.

/** A command the fake ran, and the spawn options it was given. */
export interface FakeSpawn {
  readonly sprite: string;
  readonly line: string;
  readonly options: SpawnOptions;
}

interface FakeSprite {
  readonly name: string;
  readonly dir: string;
  readonly home: string;
  deleted: boolean;
  readonly children: Set<ChildProcess>;
}

/** What the fake records, and the failures a test can ask it for. */
export interface FakeSpritesState {
  root: string;
  tokens: string[];
  createCalls: {
    readonly name: string;
    readonly config: unknown;
    readonly options: Record<string, unknown>;
  }[];
  deleted: string[];
  spawns: FakeSpawn[];
  writes: {
    readonly path: string;
    readonly content: string;
    readonly mode: number | undefined;
  }[];
  sprites: Map<string, FakeSprite>;
  /** Thrown by the next create, after the sprite was made (a timed-out create). */
  createError: Error | undefined;
  /** Commands matching it exit 1 at once, saying so on stderr. */
  failCommands: RegExp | undefined;
  /** While set, every exec connection fails before it opens. */
  connectFails: boolean;
  /** The pages `listSprites` was asked for: its prefix and continuation token. */
  lists: {
    readonly prefix: string | undefined;
    readonly from: string | undefined;
  }[];
  /** How many sprites a page of `listSprites` holds. */
  pageSize: number;
  /** Names `listSprites` gives that aren't there: deleted by someone else since. */
  ghosts: string[];
  /** Deletes of names matching it fail with a 500. */
  deleteFails: RegExp | undefined;
  /** Each `getSprite`, by name, and each `filesystem()` opened. */
  gets: string[];
  filesystemOpens: number;
}

const fresh = (root: string): FakeSpritesState => ({
  root,
  tokens: [],
  createCalls: [],
  deleted: [],
  spawns: [],
  writes: [],
  sprites: new Map(),
  createError: undefined,
  failCommands: undefined,
  connectFails: false,
  lists: [],
  pageSize: 50,
  ghosts: [],
  deleteFails: undefined,
  gets: [],
  filesystemOpens: 0,
});

/** The fake's records, shared by the mocked module and the test. */
export const fakeSprites: FakeSpritesState = fresh("");

const BASE_URL = "https://api.sprites.example";

/** Forgets everything and makes a fresh temp dir for sprites, for `beforeEach`. */
export const resetFakeSprites = async (): Promise<void> => {
  const root = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-sprites-"));
  Object.assign(fakeSprites, fresh(root));
};

const notFound = (what: string) =>
  Object.assign(new Error(`sprite not found: ${what}`), { statusCode: 404 });

/** A sprite path as a host path. */
const hostPath = (sprite: FakeSprite, text: string): string =>
  text.replaceAll(
    /\/home\/sprite|\/tmp\/(?=sandcastle-[0-9a-f]{8}-)/gu,
    (prefix) =>
      prefix === "/home/sprite"
        ? sprite.home
        : `${path.join(sprite.dir, "tmp")}/`,
  );

/** Host paths in what a sprite prints or holds, as the sprite's own paths. */
const spritePath = (sprite: FakeSprite, text: string): string =>
  text.replaceAll(sprite.home, "/home/sprite");

const killGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
  try {
    if (child.pid !== undefined) {
      process.kill(-child.pid, signal);
    }
  } catch {
    // Already gone.
  }
};

/** The URL the SDK would open for this exec, query string and all. */
const execUrl = (name: string, args: string[], options: SpawnOptions) => {
  const url = new URL(
    `${BASE_URL.replace("https", "wss")}/v1/sprites/${name}/exec`,
  );
  for (const arg of args) {
    url.searchParams.append("cmd", arg);
  }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    url.searchParams.append("env", `${key}=${value}`);
  }
  return url.toString();
};

type Listener = (...args: unknown[]) => void;

/** Just the listener calls of the SDK's `SpriteCommand` (an EventEmitter), for the events it emits. */
class Events {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly wrappers = new WeakMap<Listener, Listener>();

  on(event: string, listener: Listener): this {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  once(event: string, listener: Listener): this {
    const wrapped: Listener = (...args) => {
      this.removeListener(event, wrapped);
      listener(...args);
    };
    this.wrappers.set(listener, wrapped);
    return this.on(event, wrapped);
  }

  removeListener(event: string, listener: Listener): this {
    const set = this.listeners.get(event);
    set?.delete(listener);
    const wrapped = this.wrappers.get(listener);
    if (wrapped !== undefined) {
      set?.delete(wrapped);
    }
    return this;
  }

  protected emit(event: string, ...args: unknown[]): void {
    // A copy: a `once` listener removes itself as it runs.
    for (const listener of new Set(this.listeners.get(event))) {
      listener(...args);
    }
  }
}

/** An exec, as the SDK's `SpriteCommand` behaves. */
class FakeCommand extends Events {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private child: ChildProcess | undefined;
  private connected = true;
  private readonly sprite: FakeSprite;
  private readonly options: SpawnOptions;

  constructor(sprite: FakeSprite, args: string[], options: SpawnOptions) {
    super();
    this.sprite = sprite;
    this.options = options;
    const line = args.at(-1) ?? "";
    fakeSprites.spawns.push({ sprite: sprite.name, line, options });
    setImmediate(() => {
      if (fakeSprites.connectFails || sprite.deleted) {
        const url = execUrl(sprite.name, ["sh", ...args], options);
        this.emit(
          "error",
          new Error(`WebSocket error: failed to connect to ${url}`),
        );
        return;
      }
      if (fakeSprites.failCommands?.test(line) === true) {
        this.finish(1, `failed: ${line}\n`);
        return;
      }
      this.start(hostPath(sprite, line));
    });
  }

  private start(line: string): void {
    const child = spawn("sh", ["-c", line], {
      cwd: this.sprite.home,
      env: {
        PATH: `${path.join(this.sprite.dir, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        HOME: this.sprite.home,
      },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.sprite.children.add(child);
    child.stdin.on("error", () => undefined);
    this.stdin.pipe(child.stdin);
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.connected) {
        this.stdout.push(spritePath(this.sprite, chunk.toString("utf8")));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.connected) {
        this.stderr.push(spritePath(this.sprite, chunk.toString("utf8")));
      }
    });
    child.once("close", (code: number | null) => {
      this.sprite.children.delete(child);
      if (this.connected) {
        this.finish(code ?? 137, "");
      }
    });
    this.emit("spawn");
  }

  private finish(code: number, stderr: string): void {
    if (stderr !== "") {
      this.stderr.push(stderr);
    }
    this.stdout.push(null);
    this.stderr.push(null);
    this.emit("exit", code);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.child !== undefined && this.connected) {
      killGroup(this.child, signal);
    }
  }

  /** Disconnects. Without `maxRunAfterDisconnect` the command is killed, as the fake's stand-in for Sprites' undocumented default. */
  close(): void {
    this.connected = false;
    if (
      this.child !== undefined &&
      this.options.maxRunAfterDisconnect === undefined
    ) {
      killGroup(this.child, "SIGKILL");
    }
  }
}

const fsApi = (sprite: FakeSprite) => ({
  readFile: async (file: string) =>
    readFile(hostPath(sprite, file), "utf8").then(
      (content) => spritePath(sprite, content),
      () => {
        throw Object.assign(new Error(`no such file: ${file}`), {
          code: "ENOENT",
        });
      },
    ),
  writeFile: async (
    file: string,
    data: string,
    options?: { mode?: number },
  ) => {
    fakeSprites.writes.push({ path: file, content: data, mode: options?.mode });
    const target = hostPath(sprite, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, hostPath(sprite, data));
    if (options?.mode !== undefined) {
      await chmod(target, options.mode);
    }
  },
  mkdir: async (
    dir: string,
    options?: { recursive?: boolean; mode?: number },
  ) => {
    await mkdir(hostPath(sprite, dir), options);
  },
  rm: async (
    target: string,
    options?: { recursive?: boolean; force?: boolean },
  ) => {
    await rm(hostPath(sprite, target), options);
  },
});

const sdkSprite = (sprite: FakeSprite) => ({
  name: sprite.name,
  spawn: (_command: string, args: string[] = [], options: SpawnOptions = {}) =>
    new FakeCommand(sprite, args, options),
  filesystem: () => {
    fakeSprites.filesystemOpens += 1;
    return fsApi(sprite);
  },
});

/** Where a sprite's Task API calls are logged: beside its directory, so they outlive it. */
const curlLog = (name: string): string =>
  path.join(fakeSprites.root, `${name}.curl.log`);

const shims = (name: string) => ({
  curl: `#!/bin/sh\nprintf "%s\\n" "$*" >> '${curlLog(name)}'\n`,
  sudo: '#!/bin/sh\nexec "$@"\n',
});

const makeSprite = async (name: string): Promise<FakeSprite> => {
  const dir = path.join(fakeSprites.root, name);
  const home = path.join(dir, "home");
  await mkdir(home, { recursive: true });
  await mkdir(path.join(dir, "tmp"), { recursive: true });
  await mkdir(path.join(dir, "bin"), { recursive: true });
  await Promise.all(
    Object.entries(shims(name)).map(async ([shim, script]) =>
      writeFile(path.join(dir, "bin", shim), script, { mode: 0o755 }),
    ),
  );
  const sprite = {
    name,
    dir,
    home,
    deleted: false,
    children: new Set<ChildProcess>(),
  };
  fakeSprites.sprites.set(name, sprite);
  return sprite;
};

const destroy = async (sprite: FakeSprite): Promise<void> => {
  sprite.deleted = true;
  killProcessTrees([...sprite.children].map((child) => child.pid));
  await rm(sprite.dir, { recursive: true, force: true });
};

/** What `new SpritesClient(token)` gives. */
export class FakeSpritesClient {
  readonly baseURL = BASE_URL;
  readonly token: string;
  constructor(token: string) {
    this.token = token;
    fakeSprites.tokens.push(token);
  }

  async createSprite(
    name: string,
    config?: unknown,
    options: Record<string, unknown> = {},
  ) {
    fakeSprites.createCalls.push({ name, config, options });
    const sprite = await makeSprite(name);
    if (fakeSprites.createError !== undefined) {
      const error = fakeSprites.createError;
      fakeSprites.createError = undefined;
      throw error;
    }
    return sdkSprite(sprite);
  }

  async getSprite(name: string) {
    fakeSprites.gets.push(name);
    const sprite = fakeSprites.sprites.get(name);
    if (sprite === undefined || sprite.deleted) {
      throw notFound(name);
    }
    return sdkSprite(sprite);
  }

  /** A page of the sprites standing (and ghosts), in the order they were made, `pageSize` at a time; the token is the next index. */
  async listSprites(
    options: { prefix?: string; continuationToken?: string } = {},
  ) {
    const { prefix, continuationToken } = options;
    fakeSprites.lists.push({ prefix, from: continuationToken });
    const names = [
      ...[...fakeSprites.sprites.values()]
        .filter((sprite) => !sprite.deleted)
        .map((sprite) => sprite.name),
      ...fakeSprites.ghosts,
    ].filter((name) => name.startsWith(prefix ?? ""));
    const start = Number(continuationToken ?? "0");
    const end = start + fakeSprites.pageSize;
    const hasMore = end < names.length;
    return {
      sprites: names.slice(start, end).map((name) => ({
        id: `id-${name}`,
        name,
        organization: "fake-org",
        // The API's status doesn't follow pauses: the sweep mustn't read it.
        status: "running",
        createdAt: new Date(0),
      })),
      hasMore,
      nextContinuationToken: hasMore ? String(end) : undefined,
    };
  }

  async deleteSprite(name: string) {
    if (fakeSprites.deleteFails?.test(name) === true) {
      throw Object.assign(new Error(`internal error deleting ${name}`), {
        statusCode: 500,
      });
    }
    const sprite = fakeSprites.sprites.get(name);
    if (sprite === undefined || sprite.deleted) {
      throw notFound(name);
    }
    fakeSprites.deleted.push(name);
    await destroy(sprite);
  }
}

/** Sprites standing in the fake account, made outside any test sandbox, one at a time so they list in this order. */
export const addFakeSprites = async (...names: string[]): Promise<void> => {
  await names.reduce<Promise<unknown>>(
    async (earlier, name) => earlier.then(async () => makeSprite(name)),
    Promise.resolve(),
  );
};

/** The names of the sprites still standing. */
export const standingSprites = (): string[] =>
  [...fakeSprites.sprites.values()]
    .filter((sprite) => !sprite.deleted)
    .map((sprite) => sprite.name);

/** Whether a file exists at a path in the sprite. */
export const spriteFileExists = async (
  name: string,
  file: string,
): Promise<boolean> => {
  const sprite = fakeSprites.sprites.get(name);
  if (sprite === undefined) {
    return false;
  }
  return access(hostPath(sprite, file)).then(
    () => true,
    () => false,
  );
};

/** The Task API calls a sprite's commands made, one line of curl arguments each. */
export const taskCalls = async (name: string): Promise<string[]> => {
  const log = await readFile(curlLog(name), "utf8").catch(() => "");
  return log.split("\n").filter((line) => line !== "");
};

/** Ends every fake sprite still standing and removes the temp dir, for `afterEach`. */
export const destroyAllFakeSprites = async (): Promise<void> => {
  await Promise.all(
    [...fakeSprites.sprites.values()].map(async (sprite) => destroy(sprite)),
  );
  await rm(fakeSprites.root, { recursive: true, force: true });
};
