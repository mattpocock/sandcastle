import { runClient } from "./supervisorClient.js";
import { runDaemon } from "./supervisorDaemon.js";
import { runReplay } from "./fakeAgentReplay.js";

// The session supervisor: one self-contained file, copied into the sandbox
// at createSandbox and run there with Node.
//
//   node supervisor.mjs daemon             the supervisor, in its own directory
//   node supervisor.mjs call <file>        send it one request, print the replies
//   node supervisor.mjs replay <file> …    a fake agent, replaying a recorded stream

const [mode = "", file = "", ...rest] = process.argv.slice(2);

const main = async (): Promise<number> => {
  switch (mode) {
    case "daemon": {
      await runDaemon();
      return 0;
    }
    case "call": {
      return runClient(file);
    }
    case "replay": {
      return runReplay(file, rest);
    }
    default: {
      process.stderr.write(`supervisor: unknown mode "${mode}"\n`);
      return 2;
    }
  }
};

const code = await main();
if (mode === "daemon") {
  // Its sessions' process groups may still hold handles; it's done.
  process.exit(code);
}
process.exitCode = code;
