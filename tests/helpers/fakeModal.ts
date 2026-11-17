import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// A stand-in for the `modal` SDK, for `vi.mock`: just the calls modal()
// makes, backed by real processes and a host directory per sandbox, so the
// real session supervisor runs in it. A sandbox's own folders (`/workspace`,
// `/home/sandcastle`, `/var/lib/sandcastle`) live under `<root>/<id>`: the fake
// rewrites them in every command, env value, stdin and path it's handed, and leaves
// every other path (`/bin/sh`, `/tmp`) the host's. An image whose Dockerfile
// commands add a user has the `sandcastle` user: `getent`, `setpriv` and
// `chown` stubs on its PATH answer for it. Every call is recorded. POSIX only.

/** A command the fake ran. */
export interface FakeModalExec {
  readonly sandboxId: string;
  readonly argv: readonly string[];
  readonly workdir: string | undefined;
  readonly env: Readonly<Record<string, string>>;
}

/** An image as the fake's `images.fromRegistry` builds it. */
export interface FakeModalImage {
  readonly tag: string;
  readonly commands: readonly string[];
  readonly dockerfileCommands: (more: readonly string[]) => FakeModalImage;
}

interface FakeSandbox {
  readonly id: string;
  readonly root: string;
  readonly bin: string;
  readonly running: Set<ChildProcess>;
  exitCode: number | null;
}

/** What the fake records, and the failures a test can ask it for. */
export interface FakeModalState {
  root: string;
  clientParams: unknown[];
  clientsClosed: number;
  apps: { readonly name: string; readonly params: unknown }[];
  createCalls: {
    readonly image: FakeModalImage;
    readonly params: Record<string, unknown>;
  }[];
  execs: FakeModalExec[];
  terminated: string[];
  sandboxes: Map<string, FakeSandbox>;
  createError: Error | undefined;
  /** Each exec whose command line includes the key rejects with its error. */
  execErrors: Map<string, Error>;
  writeTextError: Error | undefined;
}

const fresh = (root: string): FakeModalState => ({
  root,
  clientParams: [],
  clientsClosed: 0,
  apps: [],
  createCalls: [],
  execs: [],
  terminated: [],
  sandboxes: new Map(),
  createError: undefined,
  execErrors: new Map(),
  writeTextError: undefined,
});

/** The fake's records, shared by the mocked module and the test. */
export const fakeModal: FakeModalState = fresh("");

/** Forgets everything and makes a fresh temp dir for sandboxes, for `beforeEach`. */
export const resetFakeModal = async (): Promise<void> => {
  const root = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-modal-"));
  Object.assign(fakeModal, fresh(root));
};

/** A gRPC error, as the real client raises one: `code` 5 is NOT_FOUND. */
const clientError = (message: string, code = 5) =>
  Object.assign(new Error(message), { name: "ClientError", code });

const OWN_FOLDERS =
  /(?<![\w./-])(?<folder>\/workspace|\/home\/sandcastle|\/var\/lib\/sandcastle)(?![\w.-])/gu;

/** `text` with the sandbox's own folders moved under its host directory. */
const rewrite = (sandbox: FakeSandbox, text: string): string =>
  text.replaceAll(OWN_FOLDERS, (folder) => `${sandbox.root}${folder}`);

/** Where a sandbox path lives on the host. */
const onHost = (sandbox: FakeSandbox, remotePath: string): string =>
  remotePath.startsWith(sandbox.root)
    ? remotePath
    : path.join(sandbox.root, remotePath);

const STUBS = {
  getent: `#!/bin/sh\n[ "$1" = passwd ] && [ "$2" = sandcastle ] || exit 2\necho "sandcastle:x:1001:1001::/home/sandcastle:/bin/sh"\n`,
  // Drops its options: the fake runs everything as the host user.
  setpriv: `#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n`,
  // Every file is the host user's already.
  chown: `#!/bin/sh\nexit 0\n`,
  setsid: `#!/bin/sh\n[ "$1" = -w ] && shift\nexec "$@"\n`,
};

/** Makes the sandbox's folders, and the image's stubs. */
const provision = async (
  sandbox: FakeSandbox,
  image: FakeModalImage,
): Promise<void> => {
  await mkdir(sandbox.bin, { recursive: true });
  const hasUser = image.commands.some((command) => command.includes("useradd"));
  const stubs = Object.entries(STUBS).filter(
    ([name]) => hasUser || name === "setsid",
  );
  await Promise.all(
    stubs.map(async ([name, script]) => {
      const file = path.join(sandbox.bin, name);
      await writeFile(file, script);
      await chmod(file, 0o755);
    }),
  );
  await mkdir(path.join(sandbox.root, "root"), { recursive: true });
  if (hasUser) {
    await mkdir(path.join(sandbox.root, "home", "sandcastle"), {
      recursive: true,
    });
    await mkdir(path.join(sandbox.root, "workspace"), { recursive: true });
  }
};

/** A text stream with the SDK's `readText`. */
const textStream = (source: NodeJS.ReadableStream | null) => {
  const stream = new ReadableStream<string>({
    start(controller) {
      if (source === null) {
        controller.close();
        return;
      }
      source.setEncoding("utf8");
      source.on("data", (chunk: string) => {
        controller.enqueue(chunk);
      });
      source.on("end", () => {
        controller.close();
      });
    },
  });
  return Object.assign(stream, {
    readText: async () => {
      let text = "";
      for await (const chunk of stream) {
        text += chunk;
      }
      return text;
    },
  });
};

interface ExecParams {
  readonly workdir?: string;
  readonly env?: Record<string, string>;
  readonly stdout?: "pipe" | "ignore";
  readonly stderr?: "pipe" | "ignore";
}

const startProcess = (
  sandbox: FakeSandbox,
  argv: readonly string[],
  params: ExecParams,
) => {
  const [program = "sh", ...args] = argv.map((arg) => rewrite(sandbox, arg));
  const env = Object.fromEntries(
    Object.entries(params.env ?? {}).map(([key, value]) => [
      key,
      rewrite(sandbox, value),
    ]),
  );
  const child = spawn(program, args, {
    cwd: rewrite(sandbox, params.workdir ?? "/"),
    env: {
      PATH: `${sandbox.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: path.join(sandbox.root, "root"),
      ...env,
    },
    detached: true,
    stdio: ["pipe", params.stdout ?? "pipe", params.stderr ?? "pipe"],
  });
  sandbox.running.add(child);
  const closed = once(child, "close").then(([code, signal]) => {
    sandbox.running.delete(child);
    if (typeof code === "number") {
      return code;
    }
    return signal === "SIGTERM" ? 143 : 137;
  });
  child.stdin?.on("error", () => undefined);
  return {
    stdin: {
      writeText: async (text: string) =>
        new Promise<void>((resolve, reject) => {
          child.stdin?.write(rewrite(sandbox, text), (error) => {
            if (error === null || error === undefined) {
              resolve();
            } else {
              reject(error);
            }
          });
        }),
      close: async () => {
        child.stdin?.end();
      },
    },
    stdout: textStream(child.stdout),
    stderr: textStream(child.stderr),
    wait: async () => closed,
  };
};

const killAll = (sandbox: FakeSandbox): void => {
  for (const child of sandbox.running) {
    try {
      if (child.pid !== undefined) {
        process.kill(-child.pid, "SIGKILL");
      }
    } catch {
      // Already gone.
    }
  }
};

const ensureRunning = (sandbox: FakeSandbox | undefined, id: string) => {
  if (sandbox === undefined) {
    throw clientError(`sandbox ${id} not found`);
  }
  if (sandbox.exitCode !== null) {
    throw clientError(`Modal Sandbox ${id} has already shut down.`);
  }
  return sandbox;
};

const filesystemOf = (id: string) => {
  const open = () => ensureRunning(fakeModal.sandboxes.get(id), id);
  return {
    readText: async (remotePath: string) => {
      const sandbox = open();
      return readFile(onHost(sandbox, remotePath), "utf8").catch(() => {
        throw Object.assign(new Error(`path does not exist: ${remotePath}`), {
          name: "SandboxFilesystemNotFoundError",
        });
      });
    },
    writeText: async (data: string, remotePath: string) => {
      const sandbox = open();
      if (fakeModal.writeTextError !== undefined) {
        throw fakeModal.writeTextError;
      }
      const file = onHost(sandbox, remotePath);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, data);
    },
    remove: async (remotePath: string) => {
      await rm(onHost(open(), remotePath), { force: true });
    },
  };
};

/** The SDK's view of a sandbox, by id: like `fromId`, it doesn't check it exists. */
const sdkSandbox = (id: string) => ({
  sandboxId: id,
  exec: async (argv: string[], params: ExecParams = {}) => {
    const sandbox = ensureRunning(fakeModal.sandboxes.get(id), id);
    fakeModal.execs.push({
      sandboxId: id,
      argv,
      workdir: params.workdir,
      env: params.env ?? {},
    });
    const line = argv.join(" ");
    for (const [key, error] of fakeModal.execErrors) {
      if (line.includes(key)) {
        throw error;
      }
    }
    return startProcess(sandbox, argv, params);
  },
  filesystem: filesystemOf(id),
  poll: async () => {
    const sandbox = fakeModal.sandboxes.get(id);
    if (sandbox === undefined) {
      throw clientError(`sandbox ${id} not found`);
    }
    return sandbox.exitCode;
  },
  terminate: async () => {
    const sandbox = ensureRunning(fakeModal.sandboxes.get(id), id);
    fakeModal.terminated.push(id);
    sandbox.exitCode = 137;
    killAll(sandbox);
  },
});

const registryImage = (
  tag: string,
  commands: readonly string[] = [],
): FakeModalImage => ({
  tag,
  commands,
  dockerfileCommands: (more) => registryImage(tag, [...commands, ...more]),
});

/** What `new ModalClient(params)` gives. */
export const fakeModalClient = (params: unknown) => {
  fakeModal.clientParams.push(params);
  return {
    apps: {
      fromName: async (name: string, appParams: unknown) => {
        fakeModal.apps.push({ name, params: appParams });
        return { appId: `ap-${name}`, name };
      },
    },
    images: { fromRegistry: (tag: string) => registryImage(tag) },
    sandboxes: {
      create: async (
        _app: unknown,
        image: FakeModalImage,
        createParams: Record<string, unknown> = {},
      ) => {
        fakeModal.createCalls.push({ image, params: createParams });
        if (fakeModal.createError !== undefined) {
          throw fakeModal.createError;
        }
        const id = `sb-${fakeModal.createCalls.length}`;
        const root = path.join(fakeModal.root, id);
        const sandbox: FakeSandbox = {
          id,
          root,
          bin: path.join(root, "bin"),
          running: new Set(),
          exitCode: null,
        };
        await provision(sandbox, image);
        fakeModal.sandboxes.set(id, sandbox);
        return sdkSandbox(id);
      },
      fromId: async (id: string) => sdkSandbox(id),
    },
    close: () => {
      fakeModal.clientsClosed += 1;
    },
  };
};

/** Ends every fake sandbox still standing and removes the temp dir, for `afterEach`. */
export const destroyAllFakeModal = async (): Promise<void> => {
  for (const sandbox of fakeModal.sandboxes.values()) {
    sandbox.exitCode ??= 137;
    killAll(sandbox);
  }
  await rm(fakeModal.root, { recursive: true, force: true });
};
