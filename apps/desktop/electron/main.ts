import { app, BrowserWindow } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

interface ControlHandshake {
  readonly port: number;
  readonly token: string;
  readonly pid: number;
}

let controlProcess: ChildProcessWithoutNullStreams | undefined;
let mainWindow: BrowserWindow | undefined;

const here = __dirname;

const isControlHandshake = (value: unknown): value is ControlHandshake => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.port === "number" &&
    typeof candidate.token === "string" &&
    typeof candidate.pid === "number"
  );
};

const findRepoRoot = (): string => {
  if (process.env.SANDCASTLE_REPO) return resolve(process.env.SANDCASTLE_REPO);

  const starts = [process.cwd(), here, resolve(here, "../../..")];
  for (const start of starts) {
    let current = resolve(start);
    for (;;) {
      const pkgPath = join(current, "package.json");
      if (
        existsSync(pkgPath) &&
        existsSync(join(current, "packages/control-core"))
      ) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
            name?: string;
          };
          if (pkg.name === "@ai-hero/sandcastle") return current;
        } catch {
          return current;
        }
      }

      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  return resolve(process.cwd());
};

const startControlCore = async (
  repoRoot: string,
): Promise<ControlHandshake> => {
  const distCli = join(repoRoot, "packages/control-core/dist/cli.js");
  const tsxCli = join(repoRoot, "node_modules/tsx/dist/cli.mjs");
  const sourceCli = join(repoRoot, "packages/control-core/src/cli.ts");

  const command = process.env.SANDCASTLE_NODE ?? "node";
  const args = existsSync(distCli)
    ? [distCli, "--port=0", `--repo=${repoRoot}`]
    : [tsxCli, sourceCli, "--port=0", `--repo=${repoRoot}`];

  controlProcess = spawn(command, args, {
    cwd: repoRoot,
    env: { ...process.env },
    windowsHide: true,
  });

  controlProcess.stderr.on("data", (chunk: Buffer) => {
    console.error(`[sandcastle-control] ${chunk.toString("utf8").trimEnd()}`);
  });

  return await new Promise<ControlHandshake>((resolveHandshake, reject) => {
    const child = controlProcess;
    if (!child) {
      reject(new Error("Control process was not started"));
      return;
    }

    const rl = createInterface({ input: child.stdout });
    const fail = (error: Error): void => {
      rl.close();
      reject(error);
    };

    child.once("error", fail);
    child.once("exit", (code, signal) => {
      fail(
        new Error(
          `control-core exited before handshake (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
    });

    rl.once("line", (line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isControlHandshake(parsed)) {
          fail(new Error(`Invalid control-core handshake: ${line}`));
          return;
        }
        child.removeAllListeners("exit");
        child.removeListener("error", fail);
        resolveHandshake(parsed);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
};

const createWindow = async (handshake: ControlHandshake): Promise<void> => {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1100,
    minHeight: 760,
    backgroundColor: "#03060a",
    title: "Sandcastle Cockpit",
    show: false,
    webPreferences: {
      preload: join(here, "../preload/index.js"),
      additionalArguments: [
        `--sandcastle-port=${handshake.port}`,
        `--sandcastle-token=${handshake.token}`,
      ],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    await mainWindow.loadURL(rendererUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    await mainWindow.loadFile(join(here, "../renderer/index.html"));
  }
};

const stopControlCore = async (): Promise<void> => {
  const child = controlProcess;
  if (!child || child.killed) return;

  await new Promise<void>((resolveStop) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      controlProcess = undefined;
      resolveStop();
    }, 2_000);

    child.once("exit", () => {
      clearTimeout(timeout);
      controlProcess = undefined;
      resolveStop();
    });

    child.kill("SIGTERM");
  });
};

app.whenReady().then(async () => {
  const repoRoot = findRepoRoot();
  const handshake = await startControlCore(repoRoot);
  await createWindow(handshake);
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && mainWindow)
    mainWindow.show();
});

app.on("before-quit", (event) => {
  if (!controlProcess || controlProcess.killed) return;
  event.preventDefault();
  void stopControlCore().finally(() => app.quit());
});
