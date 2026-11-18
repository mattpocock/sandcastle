import path from "node:path";

// The env a host() command runs with. Nothing comes from the caller's own
// `process.env` but the host's PATH and, on Windows, the few system
// variables a Windows program needs to start: the same rule as
// fakeSandbox(). HOME and the temp dirs always point into the sandbox's
// folder, whatever the caller passed.

const isWindows = process.platform === "win32";

/** What a Windows program needs to start, from the host. `SystemRoot` is also how `taskkill` is found. */
const WINDOWS_SYSTEM = [
  "SystemRoot",
  "windir",
  "ComSpec",
  "PATHEXT",
  "SystemDrive",
] as const;

/** The host's own variables a command starts from: its PATH, and on Windows the system variables. */
export const hostBaseEnv = (): Readonly<Record<string, string>> => {
  // Windows' process.env is case-insensitive, so this also finds `Path`.
  const base: Record<string, string> = { PATH: process.env["PATH"] ?? "" };
  if (!isWindows) {
    return base;
  }
  for (const name of WINDOWS_SYSTEM) {
    const value = process.env[name];
    if (value !== undefined) {
      base[name] = value;
    }
  }
  return base;
};

/** HOME and the temp dirs, inside the sandbox's folder: on Windows, every variable a program reads them from. */
export const folderEnv = (
  folder: string,
  cwd: string,
): Readonly<Record<string, string>> => {
  const home = path.join(folder, "home");
  const temp = path.join(folder, "tmp");
  if (!isWindows) {
    // PWD names the directory as the sandbox does, so `pwd` agrees with
    // `workingDirectory` where the temp dir sits behind a symlink (macOS).
    return { HOME: home, TMPDIR: temp, PWD: cwd };
  }
  return {
    HOME: home,
    TMPDIR: temp,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    TEMP: temp,
    TMP: temp,
  };
};

/** A command's whole env: the host's base, then the sandbox's env, then its own, then the folder's. */
export const commandEnv = (options: {
  readonly folder: string;
  readonly cwd: string;
  readonly sandboxEnv: Readonly<Record<string, string>>;
  readonly env: Readonly<Record<string, string>> | undefined;
}): Readonly<Record<string, string>> => ({
  ...hostBaseEnv(),
  ...options.sandboxEnv,
  ...options.env,
  ...folderEnv(options.folder, options.cwd),
});
