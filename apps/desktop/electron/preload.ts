import { contextBridge } from "electron";

const readArg = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg?.slice(prefix.length);
};

const port = Number(readArg("sandcastle-port"));
const token = readArg("sandcastle-token") ?? "";

contextBridge.exposeInMainWorld("sandcastle", {
  port,
  token,
});
