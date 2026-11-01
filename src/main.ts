#!/usr/bin/env node
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { cli } from "./cli.js";
import { ClackDisplay } from "./Display.js";
import { withFriendlyErrors } from "./ErrorHandler.js";
import { setupTerminalCleanup } from "./terminalCleanup.js";

// Restore terminal state on any exit.
// @clack/prompts' spinner/taskLog set stdin to raw mode and hide the cursor.
// If the process exits via a signal handler that calls process.exit() directly
// (e.g. the Ctrl-C handler in SandboxFactory), clack's own cleanup is
// bypassed, leaving the terminal broken. This exit hook fixes that.
setupTerminalCleanup();

const mainLayer = Layer.merge(NodeContext.layer, ClackDisplay.layer);

NodeRuntime.runMain(
  cli(process.argv).pipe(withFriendlyErrors, Effect.provide(mainLayer)),
);
