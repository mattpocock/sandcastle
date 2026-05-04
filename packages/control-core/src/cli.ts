import { startServer } from "./server.js";

const parseArgs = (
  argv: readonly string[],
): { port?: number; token?: string; repo?: string } => {
  const options: { port?: number; token?: string; repo?: string } = {};
  for (const arg of argv) {
    if (arg.startsWith("--port="))
      options.port = Number(arg.slice("--port=".length));
    if (arg.startsWith("--token="))
      options.token = arg.slice("--token=".length);
    if (arg.startsWith("--repo=")) options.repo = arg.slice("--repo=".length);
  }
  return options;
};

const main = async (): Promise<void> => {
  const server = await startServer(parseArgs(process.argv.slice(2)));
  process.stdout.write(
    JSON.stringify({
      port: server.port,
      token: server.token,
      pid: server.pid,
    }) + "\n",
  );

  const shutdown = (): void => {
    void server.close().finally(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
