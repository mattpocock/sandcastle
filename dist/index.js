import { createRequire } from 'node:module';
import { NodeContext_exports, NodeFileSystem_exports, formatErrorMessage } from './chunk-DJRHWPEH.js';
import { Context_exports, CwdError, Effect_exports, resolveCwd, getCurrentBranch, generateTempBranchName, Layer_exports, FileDisplay, ClackDisplay, WorktreeDockerSandboxFactory, SandboxConfig, Display, pruneStale, create, copyToWorktree, runHostHooks, startSandbox, resolveGitMounts, patchGitMountsForWindows, SANDBOX_REPO_DIR, remove, makeSandboxFromHandle, syncOut, withSandboxLifecycle, hasUncommittedChanges, registerShutdown, SandboxFactory, PromptError, FileSystem_exports, SessionCaptureError, Clock_exports, Duration_exports, Option_exports, PromptExpansionTimeoutError, Deferred_exports, AgentError, Ref_exports, SilentDisplay, AgentIdleTimeoutError, Fiber_exports } from './chunk-VOG34SRF.js';
export { createBindMountSandboxProvider, createIsolatedSandboxProvider } from './chunk-BIWNFKGV.js';
import { noSandbox } from './chunk-62WN33RK.js';
import './chunk-NGBM7T3E.js';
import { mkdirSync, appendFileSync } from 'fs';
import path, { join, posix, dirname, relative } from 'path';
import { styleText } from 'util';
import * as clack from '@clack/prompts';
import { readdir, access, readFile, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';

createRequire(import.meta.url);

// src/resumePrecheck.ts
var assertResumeSessionExists = async (params) => {
  const { provider, sandboxTag, hostRepoDir, resumeSession } = params;
  if (!provider.sessionStorage) {
    throw new Error(`${provider.name} does not support resumeSession`);
  }
  if (sandboxTag === "none") {
    const found = await provider.sessionStorage.findByIdOnHost(resumeSession);
    if (!found.path) {
      throw new Error(
        `resumeSession "${resumeSession}" not found under ${found.searchedRoot}`
      );
    }
    return;
  }
  const exists = await provider.sessionStorage.existsOnHost(
    hostRepoDir,
    resumeSession
  );
  if (!exists) {
    const sessionPath = provider.sessionStorage.hostSessionFilePath(
      hostRepoDir,
      resumeSession
    );
    throw new Error(
      sessionPath ? `resumeSession "${resumeSession}" not found: expected session file at ${sessionPath}` : `resumeSession "${resumeSession}" not found`
    );
  }
};

// src/AgentStreamEmitter.ts
var AgentStreamEmitter = class extends Context_exports.Tag("AgentStreamEmitter")() {
};
var agentStreamEmitterLayer = (onEvent) => Layer_exports.succeed(AgentStreamEmitter, {
  emit: onEvent ? (event) => Effect_exports.sync(() => {
    try {
      onEvent(event);
    } catch {
    }
  }) : () => Effect_exports.void
});

// src/PromptPreprocessor.ts
var PROMPT_EXPANSION_TIMEOUT_MS = 3e4;
var SHELL_BLOCK_MARKER = "";
var MARKED_SHELL_BLOCK_PATTERN = new RegExp(
  `!${SHELL_BLOCK_MARKER}\`([^\`]+)\``,
  "g"
);
var preprocessPrompt = (prompt, sandbox, cwd) => {
  const matches = [...prompt.matchAll(MARKED_SHELL_BLOCK_PATTERN)];
  if (matches.length === 0) {
    return Effect_exports.succeed(prompt.replaceAll(SHELL_BLOCK_MARKER, ""));
  }
  return Effect_exports.gen(function* () {
    const display = yield* Display;
    return yield* display.taskLog(
      "Expanding shell expressions",
      (message) => Effect_exports.gen(function* () {
        const results = yield* Effect_exports.all(
          matches.map((match) => {
            const command = match[1];
            return Effect_exports.gen(function* () {
              const start = yield* Clock_exports.currentTimeMillis;
              const maybeResult = yield* sandbox.exec(command, { cwd }).pipe(
                Effect_exports.timeoutOption(
                  Duration_exports.millis(PROMPT_EXPANSION_TIMEOUT_MS)
                )
              );
              if (Option_exports.isNone(maybeResult)) {
                const elapsedMs = (yield* Clock_exports.currentTimeMillis) - start;
                return yield* Effect_exports.fail(
                  new PromptExpansionTimeoutError({
                    message: `Shell expression \`${command}\` timed out after ${elapsedMs}ms`,
                    timeoutMs: PROMPT_EXPANSION_TIMEOUT_MS,
                    expression: command,
                    elapsedMs
                  })
                );
              }
              const execResult = maybeResult.value;
              if (execResult.exitCode !== 0) {
                return yield* Effect_exports.fail(
                  new PromptError({
                    message: `Command \`${command}\` exited with code ${execResult.exitCode}: ${execResult.stderr}`,
                    exitCode: execResult.exitCode
                  })
                );
              }
              return execResult.stdout.trimEnd();
            });
          }),
          { concurrency: "unbounded" }
        );
        for (let i = 0; i < matches.length; i++) {
          const command = matches[i][1];
          const tokens = Math.ceil(results[i].length / 4);
          message(`${command} \u2192 ~${tokens} tokens`);
        }
        let result = prompt;
        for (let i = matches.length - 1; i >= 0; i--) {
          const match = matches[i];
          const index = match.index;
          result = result.slice(0, index) + results[i] + result.slice(index + match[0].length);
        }
        return result.replaceAll(SHELL_BLOCK_MARKER, "");
      })
    );
  });
};

// src/TextDeltaBuffer.ts
var LENGTH_THRESHOLD = 80;
var DEBOUNCE_MS = 50;
var SENTENCE_BOUNDARY_RE = /[.!?] $/;
var TextDeltaBuffer = class {
  buffer = "";
  timer = null;
  onFlush;
  constructor(onFlush) {
    this.onFlush = onFlush;
  }
  write(text2) {
    if (text2.length === 0) return;
    this.buffer += text2;
    this.clearTimer();
    if (this.shouldFlush()) {
      this.doFlush();
      return;
    }
    this.timer = setTimeout(() => {
      this.doFlush();
    }, DEBOUNCE_MS);
  }
  /** Force-flush any buffered text. */
  flush() {
    this.clearTimer();
    this.doFlush();
  }
  /** Flush remaining buffer and clean up. */
  dispose() {
    this.flush();
  }
  shouldFlush() {
    if (this.buffer.includes("\n")) return true;
    if (SENTENCE_BOUNDARY_RE.test(this.buffer)) return true;
    if (this.buffer.length >= LENGTH_THRESHOLD) return true;
    return false;
  }
  doFlush() {
    if (this.buffer.length === 0) return;
    const text2 = this.buffer;
    this.buffer = "";
    this.onFlush(text2);
  }
  clearTimer() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
};

// src/Orchestrator.ts
var IDLE_WARNING_INTERVAL_MS = 6e4;
var invokeAgent = (sandbox, sandboxRepoDir, prompt, provider, idleTimeoutMs, completionTimeoutMs, completionSignals, onText, onToolCall, onRawLine, onIdleWarning, onCompletionTimeout, idleWarningIntervalMs = IDLE_WARNING_INTERVAL_MS, resumeSession, forkSession, signal) => Effect_exports.gen(function* () {
  let resultText = "";
  let sessionId;
  let usage;
  let accumulatedOutput = "";
  const timeoutSignal = yield* Deferred_exports.make();
  const completionTimeoutDeferred = yield* Deferred_exports.make();
  let timeoutFiber = null;
  let completionDetected = false;
  let warningFiber = null;
  let idleMinuteCounter = 0;
  const interruptFiber = (fiber) => {
    if (fiber !== null) Effect_exports.runFork(Fiber_exports.interrupt(fiber));
  };
  const startWarningInterval = () => {
    interruptFiber(warningFiber);
    idleMinuteCounter = 0;
    warningFiber = Effect_exports.runFork(
      Effect_exports.gen(function* () {
        while (true) {
          yield* Effect_exports.sleep(Duration_exports.millis(idleWarningIntervalMs));
          idleMinuteCounter++;
          onIdleWarning(idleMinuteCounter);
        }
      })
    );
  };
  const resetTimer = () => {
    interruptFiber(timeoutFiber);
    if (completionDetected) {
      timeoutFiber = Effect_exports.runFork(
        Effect_exports.gen(function* () {
          yield* Effect_exports.sleep(Duration_exports.millis(completionTimeoutMs));
          onCompletionTimeout(completionTimeoutMs);
          yield* Deferred_exports.succeed(completionTimeoutDeferred, {
            result: resultText || accumulatedOutput,
            sessionId,
            usage
          });
        })
      );
    } else {
      timeoutFiber = Effect_exports.runFork(
        Effect_exports.gen(function* () {
          yield* Effect_exports.sleep(Duration_exports.millis(idleTimeoutMs));
          yield* Deferred_exports.fail(
            timeoutSignal,
            new AgentIdleTimeoutError({
              message: `Agent idle for ${idleTimeoutMs / 1e3} seconds \u2014 no output received. Consider increasing the idle timeout with --idle-timeout.`,
              timeoutMs: idleTimeoutMs
            })
          );
        })
      );
      startWarningInterval();
    }
  };
  const abortDeferred = yield* Deferred_exports.make();
  let abortCleanup = null;
  if (signal) {
    if (signal.aborted) {
      return yield* Effect_exports.die(signal.reason);
    }
    const onAbort = () => {
      Effect_exports.runFork(Deferred_exports.die(abortDeferred, signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    abortCleanup = () => signal.removeEventListener("abort", onAbort);
  }
  resetTimer();
  const execEffect = Effect_exports.gen(function* () {
    const printCmd = provider.buildPrintCommand({
      prompt,
      dangerouslySkipPermissions: true,
      resumeSession,
      forkSession
    });
    const execResult = yield* sandbox.exec(printCmd.command, {
      onLine: (line) => {
        try {
          onRawLine(line);
        } catch {
        }
        for (const parsed of provider.parseStreamLine(line)) {
          if (parsed.type === "text") {
            onText(parsed.text);
            accumulatedOutput += parsed.text;
          } else if (parsed.type === "result") {
            resultText = parsed.result;
            accumulatedOutput += parsed.result;
          } else if (parsed.type === "tool_call") {
            onToolCall(parsed.name, parsed.args);
          } else if (parsed.type === "session_id") {
            sessionId = parsed.sessionId;
          } else if (parsed.type === "usage") {
            usage = parsed.usage;
          }
        }
        if (!completionDetected && completionSignals.some((sig) => accumulatedOutput.includes(sig))) {
          completionDetected = true;
          interruptFiber(warningFiber);
          warningFiber = null;
        }
        resetTimer();
      },
      cwd: sandboxRepoDir,
      stdin: printCmd.stdin
    });
    if (execResult.exitCode !== 0) {
      let errorDetail = execResult.stderr;
      if (!errorDetail.trim()) {
        errorDetail = resultText;
      }
      if (!errorDetail.trim()) {
        const lines = execResult.stdout.split("\n").filter((l) => l.trim());
        errorDetail = lines.slice(-20).join("\n");
      }
      return yield* Effect_exports.fail(
        new AgentError({
          message: `${provider.name} exited with code ${execResult.exitCode}:
${errorDetail}`
        })
      );
    }
    return { result: resultText || execResult.stdout, sessionId, usage };
  }).pipe(
    Effect_exports.ensuring(
      Effect_exports.sync(() => {
        interruptFiber(timeoutFiber);
        timeoutFiber = null;
        interruptFiber(warningFiber);
        warningFiber = null;
      })
    )
  );
  let raced = Effect_exports.raceFirst(execEffect, Deferred_exports.await(timeoutSignal));
  raced = Effect_exports.raceFirst(raced, Deferred_exports.await(completionTimeoutDeferred));
  if (signal) {
    raced = Effect_exports.raceFirst(
      raced,
      Deferred_exports.await(abortDeferred)
    );
  }
  return yield* raced.pipe(
    Effect_exports.ensuring(
      Effect_exports.sync(() => {
        abortCleanup?.();
        interruptFiber(timeoutFiber);
        timeoutFiber = null;
        interruptFiber(warningFiber);
        warningFiber = null;
      })
    )
  );
});
var DEFAULT_COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";
var DEFAULT_IDLE_TIMEOUT_SECONDS = 10 * 60;
var DEFAULT_COMPLETION_TIMEOUT_SECONDS = 60;
var orchestrate = (options) => {
  const idleTimeoutMs = (options.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS) * 1e3;
  const completionTimeoutMs = (options.completionTimeoutSeconds ?? DEFAULT_COMPLETION_TIMEOUT_SECONDS) * 1e3;
  return Effect_exports.gen(function* () {
    const factory = yield* SandboxFactory;
    const display = yield* Display;
    const streamEmitter = yield* AgentStreamEmitter;
    const { hostRepoDir, iterations, hooks, prompt, branch, provider } = options;
    let completionSignals;
    if (options.completionSignal === void 0) {
      completionSignals = [DEFAULT_COMPLETION_SIGNAL];
    } else if (Array.isArray(options.completionSignal)) {
      completionSignals = options.completionSignal;
    } else {
      completionSignals = [options.completionSignal];
    }
    const label = (msg) => options.name ? `[${options.name}] ${msg}` : msg;
    const allCommits = [];
    const allIterations = [];
    let allStdout = "";
    let resolvedBranch = "";
    let iterationPreservedPath;
    const checkAbort = () => options.signal?.aborted ? Effect_exports.die(options.signal.reason) : Effect_exports.void;
    for (let i = 1; i <= iterations; i++) {
      yield* checkAbort();
      yield* display.status(label(`Iteration ${i}/${iterations}`), "info");
      const sandboxResult = yield* factory.withSandbox(
        ({ hostWorktreePath, sandboxRepoPath, applyToHost, bindMountHandle }, sandbox) => withSandboxLifecycle(
          {
            hostRepoDir,
            sandboxRepoDir: sandboxRepoPath,
            hooks,
            branch,
            hostWorktreePath,
            applyToHost,
            signal: options.signal,
            timeouts: options.timeouts,
            keepSourceBranch: options.keepSourceBranch
          },
          sandbox,
          (ctx) => Effect_exports.gen(function* () {
            const iterationResumeSession = i === 1 ? options.resumeSession : void 0;
            const iterationForkSession = i === 1 ? options.forkSession : void 0;
            if (iterationResumeSession && bindMountHandle && provider.sessionStorage) {
              yield* display.status(label("Resuming session"), "info");
              yield* Effect_exports.tryPromise({
                try: () => provider.sessionStorage.resumeIntoSandbox({
                  hostCwd: hostRepoDir,
                  sandboxCwd: ctx.sandboxRepoDir,
                  sessionId: iterationResumeSession,
                  handle: bindMountHandle
                }),
                catch: (e) => new SessionCaptureError({
                  message: `Session resume failed: ${e instanceof Error ? e.message : String(e)}`,
                  sessionId: iterationResumeSession
                })
              });
            }
            const fullPrompt = options.skipPromptExpansion ? prompt : yield* preprocessPrompt(
              prompt,
              ctx.sandbox,
              ctx.sandboxRepoDir
            );
            yield* display.status(label("Agent started"), "success");
            const textBuffer = new TextDeltaBuffer((chunk) => {
              Effect_exports.runPromise(display.textChunk(chunk));
              Effect_exports.runPromise(
                streamEmitter.emit({
                  type: "text",
                  message: chunk,
                  iteration: i,
                  timestamp: /* @__PURE__ */ new Date()
                })
              );
            });
            const onText = (text2) => {
              textBuffer.write(text2);
            };
            const onToolCall = (name, formattedArgs) => {
              textBuffer.flush();
              Effect_exports.runPromise(display.toolCall(name, formattedArgs));
              Effect_exports.runPromise(
                streamEmitter.emit({
                  type: "toolCall",
                  name,
                  formattedArgs,
                  iteration: i,
                  timestamp: /* @__PURE__ */ new Date()
                })
              );
            };
            const onRawLine = (line) => {
              Effect_exports.runPromise(
                streamEmitter.emit({
                  type: "raw",
                  line,
                  iteration: i,
                  timestamp: /* @__PURE__ */ new Date()
                })
              );
            };
            const onIdleWarning = (minutes) => {
              const msg = minutes === 1 ? "Agent idle for 1 minute" : `Agent idle for ${minutes} minutes`;
              Effect_exports.runPromise(display.status(label(msg), "warn"));
            };
            const onCompletionTimeout = (timeoutMs) => {
              Effect_exports.runPromise(
                display.status(
                  label(
                    `Completion signal seen but agent process is hanging \u2014 force-completing after ${timeoutMs / 1e3}s grace window.`
                  ),
                  "warn"
                )
              );
            };
            const {
              result: agentOutput,
              sessionId,
              usage: streamUsage
            } = yield* invokeAgent(
              ctx.sandbox,
              ctx.sandboxRepoDir,
              fullPrompt,
              provider,
              idleTimeoutMs,
              completionTimeoutMs,
              completionSignals,
              onText,
              onToolCall,
              onRawLine,
              onIdleWarning,
              onCompletionTimeout,
              options._idleWarningIntervalMs,
              iterationResumeSession,
              iterationForkSession,
              options.signal
            );
            textBuffer.dispose();
            yield* display.status(label("Agent stopped"), "info");
            let sessionFilePath;
            let usage = streamUsage;
            if (provider.captureSessions && provider.sessionStorage && sessionId && bindMountHandle) {
              yield* display.status(label("Capturing session"), "info");
              yield* Effect_exports.tryPromise({
                try: () => provider.sessionStorage.captureToHost({
                  hostCwd: hostRepoDir,
                  sandboxCwd: ctx.sandboxRepoDir,
                  sessionId,
                  handle: bindMountHandle
                }),
                catch: (e) => new SessionCaptureError({
                  message: `Session capture failed: ${e instanceof Error ? e.message : String(e)}`,
                  sessionId
                })
              });
              sessionFilePath = provider.sessionStorage.hostSessionFilePath(
                hostRepoDir,
                sessionId
              );
              if (provider.parseSessionUsage) {
                const content = yield* Effect_exports.promise(
                  () => provider.sessionStorage.readHostSession(hostRepoDir, sessionId).catch(() => void 0)
                );
                if (content) {
                  const parsedUsage = provider.parseSessionUsage(content);
                  if (parsedUsage) usage = parsedUsage;
                }
              }
            }
            const matchedSignal = completionSignals.find(
              (sig) => agentOutput.includes(sig)
            );
            return {
              completionSignal: matchedSignal,
              stdout: agentOutput,
              sessionId,
              sessionFilePath,
              usage
            };
          })
        )
      );
      const lifecycleResult = sandboxResult.value;
      iterationPreservedPath = sandboxResult.preservedWorktreePath;
      allCommits.push(...lifecycleResult.commits);
      allStdout += lifecycleResult.result.stdout;
      resolvedBranch = lifecycleResult.branch;
      allIterations.push({
        sessionId: lifecycleResult.result.sessionId,
        sessionFilePath: lifecycleResult.result.sessionFilePath,
        usage: lifecycleResult.result.usage
      });
      if (lifecycleResult.result.completionSignal !== void 0) {
        yield* display.status(
          label(`Agent signaled completion after ${i} iteration(s).`),
          "success"
        );
        return {
          iterations: allIterations,
          completionSignal: lifecycleResult.result.completionSignal,
          stdout: allStdout,
          commits: allCommits,
          branch: resolvedBranch,
          preservedWorktreePath: iterationPreservedPath
        };
      }
    }
    yield* display.status(
      label(`Reached max iterations (${iterations}).`),
      "info"
    );
    return {
      iterations: allIterations,
      completionSignal: void 0,
      stdout: allStdout,
      commits: allCommits,
      branch: resolvedBranch,
      preservedWorktreePath: iterationPreservedPath
    };
  });
};

// src/PromptResolver.ts
var resolvePrompt = (options) => {
  const { prompt, promptFile } = options;
  if (prompt !== void 0 && promptFile !== void 0) {
    return Effect_exports.fail(
      new PromptError({
        message: "Cannot provide both --prompt and --prompt-file"
      })
    );
  }
  if (prompt !== void 0) {
    return Effect_exports.succeed({ text: prompt, source: "inline" });
  }
  if (promptFile === void 0) {
    return Effect_exports.fail(
      new PromptError({
        message: "Must provide either prompt or promptFile. Pass prompt: '...' or promptFile: './.sandcastle/prompt.md' to run()."
      })
    );
  }
  return Effect_exports.gen(function* () {
    const fs = yield* FileSystem_exports.FileSystem;
    const text2 = yield* fs.readFileString(promptFile).pipe(
      Effect_exports.catchAll(
        (e) => Effect_exports.fail(
          new PromptError({
            message: `Failed to read prompt from ${promptFile}: ${e}`
          })
        )
      )
    );
    return { text: text2, source: "template" };
  });
};
var parseEnvFile = (filePath) => Effect_exports.gen(function* () {
  const fs = yield* FileSystem_exports.FileSystem;
  const content = yield* fs.readFileString(filePath).pipe(Effect_exports.catchAll(() => Effect_exports.succeed(null)));
  if (content === null) return {};
  const vars = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    const isDoubleQuoted = value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"';
    const isSingleQuoted = value.length >= 2 && value[0] === "'" && value[value.length - 1] === "'";
    if (isDoubleQuoted || isSingleQuoted) {
      value = value.slice(1, -1);
    }
    if (isDoubleQuoted) {
      value = value.replace(/\\([nrt\\])/g, (_, ch) => {
        const escapes = {
          n: "\n",
          r: "\r",
          t: "	",
          "\\": "\\"
        };
        return escapes[ch] ?? ch;
      });
    }
    vars[key] = value;
  }
  return vars;
});
var resolveEnv = (repoDir) => Effect_exports.gen(function* () {
  const sandcastleEnv = yield* parseEnvFile(
    join(repoDir, ".sandcastle", ".env")
  );
  const result = {};
  for (const key of Object.keys(sandcastleEnv)) {
    const value = sandcastleEnv[key] || process.env[key];
    if (value) {
      result[key] = value;
    }
  }
  return result;
});

// src/mergeProviderEnv.ts
var mergeProviderEnv = (options) => {
  const { resolvedEnv, agentProviderEnv, sandboxProviderEnv } = options;
  const agentKeys = Object.keys(agentProviderEnv);
  const sandboxKeys = new Set(Object.keys(sandboxProviderEnv));
  const overlapping = agentKeys.filter((k) => sandboxKeys.has(k));
  if (overlapping.length > 0) {
    throw new Error(
      `Overlapping env keys between agent provider and sandbox provider: ${overlapping.join(", ")}`
    );
  }
  return {
    ...resolvedEnv,
    ...sandboxProviderEnv,
    ...agentProviderEnv
  };
};

// src/PromptArgumentSubstitution.ts
var SHELL_BLOCK_PATTERN = /!`([^`]+)`/g;
var BUILT_IN_PROMPT_ARG_KEYS = [
  "SOURCE_BRANCH",
  "TARGET_BRANCH"
];
var PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
var validateNoArgsWithInlinePrompt = (args) => {
  if (Object.keys(args).length === 0) return Effect_exports.void;
  return Effect_exports.fail(
    new PromptError({
      message: 'promptArgs is only supported with promptFile. Inline prompts (prompt: "...") are passed to the agent as-is \u2014 interpolate values directly in JavaScript, or switch to promptFile to use {{KEY}} substitution.'
    })
  );
};
var validateNoBuiltInArgOverride = (args) => {
  for (const key of BUILT_IN_PROMPT_ARG_KEYS) {
    if (key in args) {
      return Effect_exports.fail(
        new PromptError({
          message: `"${key}" is a built-in prompt argument and cannot be overridden via promptArgs`
        })
      );
    }
  }
  return Effect_exports.void;
};
var findMissingPromptArgKeys = (prompt, providedArgs) => {
  const matches = [...prompt.matchAll(PLACEHOLDER_PATTERN)];
  const builtInSet = new Set(BUILT_IN_PROMPT_ARG_KEYS);
  const seen = /* @__PURE__ */ new Set();
  const missing = [];
  for (const m of matches) {
    const key = m[1];
    if (seen.has(key)) continue;
    seen.add(key);
    if (builtInSet.has(key)) continue;
    if (key in providedArgs && providedArgs[key] != null) continue;
    missing.push(key);
  }
  return missing;
};
var substitutePromptArgs = (prompt, args, silentKeys) => {
  const markedPrompt = prompt.replaceAll(SHELL_BLOCK_MARKER, "").replace(SHELL_BLOCK_PATTERN, `!${SHELL_BLOCK_MARKER}\`$1\``);
  const sanitizedArgs = Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      typeof value === "string" ? value.replaceAll(SHELL_BLOCK_MARKER, "") : value
    ])
  );
  const matches = [...markedPrompt.matchAll(PLACEHOLDER_PATTERN)];
  if (matches.length === 0 && Object.keys(sanitizedArgs).length === 0) {
    return Effect_exports.succeed(markedPrompt);
  }
  return Effect_exports.gen(function* () {
    const display = yield* Display;
    const referencedKeys = new Set(matches.map((m) => m[1]));
    for (const key of referencedKeys) {
      if (!(key in sanitizedArgs)) {
        return yield* Effect_exports.fail(
          new PromptError({
            message: `Prompt argument "{{${key}}}" has no matching value in promptArgs`
          })
        );
      }
      const value = sanitizedArgs[key];
      if (value == null) {
        return yield* Effect_exports.fail(
          new PromptError({
            message: `Prompt argument "{{${key}}}" has value ${value === null ? "null" : "undefined"} in promptArgs`
          })
        );
      }
    }
    for (const key of Object.keys(sanitizedArgs)) {
      if (!referencedKeys.has(key) && !silentKeys?.has(key)) {
        yield* display.status(
          `Prompt argument "${key}" was provided but not referenced in the prompt`,
          "warn"
        );
      }
    }
    const result = markedPrompt.replace(
      PLACEHOLDER_PATTERN,
      (_match, key) => sanitizedArgs[key].toString()
    );
    return result;
  });
};

// src/Output.ts
var Output = {
  /**
   * Declare an object-typed structured output extracted from an XML tag in
   * the agent's stdout. The tag contents are JSON-parsed (with fence-aware
   * unwrapping) and validated against the provided Standard Schema validator.
   *
   * Set `maxRetries` to have `run()` automatically resume the failed session
   * and ask the agent to re-emit corrected output when extraction or
   * validation fails. Default: `0` (no retries).
   */
  object: (opts) => ({
    _tag: "object",
    tag: opts.tag,
    schema: opts.schema,
    maxRetries: opts.maxRetries
  }),
  /**
   * Declare a string-typed structured output extracted from an XML tag in
   * the agent's stdout. The tag contents are whitespace-trimmed and returned
   * as a plain string — no JSON parsing, no schema validation.
   *
   * Set `maxRetries` to have `run()` automatically resume the failed session
   * and ask the agent to re-emit corrected output when extraction fails.
   * Default: `0` (no retries).
   */
  string: (opts) => ({
    _tag: "string",
    tag: opts.tag,
    maxRetries: opts.maxRetries
  })
};
var StructuredOutputError = class extends Error {
  tag;
  rawMatched;
  cause;
  commits;
  branch;
  preservedWorktreePath;
  /** Session ID of the iteration that produced the bad output, when available. */
  sessionId;
  /** Host path to the captured session JSONL, when the session was captured. */
  sessionFilePath;
  constructor(message, options) {
    super(message);
    this.name = "StructuredOutputError";
    this.tag = options.tag;
    this.rawMatched = options.rawMatched;
    this.cause = options.cause;
    this.commits = options.commits;
    this.branch = options.branch;
    this.preservedWorktreePath = options.preservedWorktreePath;
    this.sessionId = options.sessionId;
    this.sessionFilePath = options.sessionFilePath;
  }
};

// src/extractStructuredOutput.ts
var extractStructuredOutput = async (stdout, definition, context) => {
  if (definition._tag === "object") {
    return extractObject(
      stdout,
      definition,
      context
    );
  }
  return extractString(stdout, definition, context);
};
var extractObject = async (stdout, definition, context) => {
  const raw = findLastTagContent(stdout, definition.tag);
  if (raw === void 0) {
    throw new StructuredOutputError(
      `Structured output tag <${definition.tag}> not found in agent output`,
      { tag: definition.tag, rawMatched: void 0, ...context }
    );
  }
  const unwrapped = unwrapFences(raw.trim());
  let parsed;
  try {
    parsed = JSON.parse(unwrapped);
  } catch (cause) {
    throw new StructuredOutputError(
      `Structured output tag <${definition.tag}> contains invalid JSON`,
      { tag: definition.tag, rawMatched: raw, cause, ...context }
    );
  }
  const result = await definition.schema["~standard"].validate(parsed);
  if (result.issues) {
    throw new StructuredOutputError(
      `Structured output tag <${definition.tag}> failed schema validation`,
      {
        tag: definition.tag,
        rawMatched: raw,
        cause: result.issues,
        ...context
      }
    );
  }
  return result.value;
};
var extractString = (stdout, definition, context) => {
  const raw = findLastTagContent(stdout, definition.tag);
  if (raw === void 0) {
    throw new StructuredOutputError(
      `Structured output tag <${definition.tag}> not found in agent output`,
      { tag: definition.tag, rawMatched: void 0, ...context }
    );
  }
  return raw.trim();
};
var findLastTagContent = (text2, tag) => {
  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;
  let lastContent;
  let searchFrom = 0;
  while (true) {
    const openIdx = text2.indexOf(openTag, searchFrom);
    if (openIdx === -1) break;
    const contentStart = openIdx + openTag.length;
    const closeIdx = text2.indexOf(closeTag, contentStart);
    if (closeIdx === -1) break;
    lastContent = text2.slice(contentStart, closeIdx);
    searchFrom = closeIdx + closeTag.length;
  }
  return lastContent;
};
var unwrapFences = (text2) => {
  const fenceMatch = text2.match(/^```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return text2;
};

// src/run.ts
var buildStructuredOutputRetryFeedback = (error, retriesRemaining) => {
  const raw = error.rawMatched === void 0 ? "(no matching tag was emitted)" : error.rawMatched;
  const cause = error.cause === void 0 ? "(no parser detail)" : typeof error.cause === "string" ? error.cause : JSON.stringify(error.cause, null, 2);
  return `Your previous response did not produce valid structured output.

Retries remaining after this attempt: ${retriesRemaining}.

Problem:
${error.message}

Parser detail:
${cause}

Previous matched output:
${raw}

Emit only a corrected <${error.tag}> block. Do not change files or run commands.`;
};
var DEFAULT_MAX_ITERATIONS = 1;
var sanitizeBranchForFilename = (branch) => branch.replace(/[/\\:*?"<>|]/g, "-");
var printFileDisplayStartup = (options) => {
  const name = options.agentName ?? "Agent";
  const label = styleText("bold", `[${name}]`);
  const branchPart = options.branch ? ` on branch ${options.branch}` : "";
  const hostRepoDir = options.hostRepoDir ?? process.cwd();
  const displayLogPath = hostRepoDir === process.cwd() ? path.relative(process.cwd(), options.logPath) : options.logPath;
  console.log(`${label} Started${branchPart}`);
  console.log(styleText("dim", `  tail -f ${displayLogPath}`));
};
var buildLogFilename = (resolvedBranch, targetBranch, name) => {
  const sanitized = sanitizeBranchForFilename(resolvedBranch);
  const nameSuffix = name ? `-${name.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}` : "";
  if (targetBranch) {
    return `${sanitizeBranchForFilename(targetBranch)}-${sanitized}${nameSuffix}.log`;
  }
  return `${sanitized}${nameSuffix}.log`;
};
var buildRunSummaryRows = (options) => ({
  Agent: options.name ?? options.agentName,
  Sandbox: options.sandboxName,
  "Max iterations": String(options.maxIterations),
  Branch: options.branch
});
var buildCompletionMessage = (completionSignal, iterationsRun) => {
  if (completionSignal !== void 0) {
    return {
      message: `Run complete: agent finished after ${iterationsRun} iteration(s).`,
      severity: "success"
    };
  }
  return {
    message: `Run complete: reached ${iterationsRun} iteration(s) without completion signal.`,
    severity: "warn"
  };
};
var formatContextWindowSize = (usage) => {
  const total = usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
  return `${Math.ceil(total / 1e3)}k`;
};
var buildContextWindowLines = (iterations) => iterations.filter((it) => it.usage !== void 0).map((it) => `Context window: ${formatContextWindowSize(it.usage)}`);
var buildAgentStreamHandler = (logging) => {
  const userHandler = logging.type === "file" ? logging.onAgentStreamEvent : void 0;
  const verboseSink = logging.verbose ? buildVerboseRawLineSink(logging) : void 0;
  if (!userHandler && !verboseSink) return void 0;
  return (event) => {
    if (userHandler) {
      try {
        userHandler(event);
      } catch {
      }
    }
    if (verboseSink && event.type === "raw") {
      verboseSink(event.line);
    }
  };
};
var buildVerboseRawLineSink = (logging) => {
  if (logging.type === "file") {
    const logPath = logging.path;
    try {
      mkdirSync(path.dirname(logPath), { recursive: true });
    } catch {
    }
    return (line) => {
      try {
        appendFileSync(logPath, line + "\n");
      } catch {
      }
    };
  }
  return (line) => {
    process.stdout.write(line + "\n");
  };
};
async function run(options) {
  options.signal?.throwIfAborted();
  const {
    prompt,
    promptFile,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    hooks,
    agent: provider
  } = options;
  const branchStrategy = options.branchStrategy ?? (options.sandbox.tag === "isolated" ? { type: "merge-to-head" } : { type: "head" });
  const effectiveBranchType = branchStrategy.type;
  if (effectiveBranchType === "head" && options.sandbox.tag === "isolated") {
    throw new Error(
      "head branch strategy is not supported with isolated providers"
    );
  }
  if (effectiveBranchType === "head" && options.copyToWorktree && options.copyToWorktree.length > 0) {
    throw new Error(
      "copyToWorktree is not supported with head branch strategy. In head mode the host working directory is bind-mounted directly."
    );
  }
  if (options.resumeSession && maxIterations > 1) {
    throw new Error(
      "resumeSession cannot be combined with maxIterations > 1. Resume applies to iteration 1 only; multi-iteration resume semantics are not supported."
    );
  }
  if (options.forkSession && !options.resumeSession) {
    throw new Error(
      "forkSession requires resumeSession. Use RunResult.fork(prompt) to fork the last captured session."
    );
  }
  if (options.output && maxIterations !== 1) {
    throw new Error(
      "output requires maxIterations to be 1. Structured output is only supported for single-iteration runs."
    );
  }
  const outputMaxRetries = options.output?.maxRetries ?? 0;
  if (outputMaxRetries < 0 || !Number.isInteger(outputMaxRetries)) {
    throw new Error(
      `output.maxRetries must be a non-negative integer. Received: ${outputMaxRetries}`
    );
  }
  if (outputMaxRetries > 0 && !provider.sessionStorage) {
    throw new Error(
      `output.maxRetries requires an agent provider that supports session resumption. The "${provider.name}" provider does not. Use claudeCode, codex, or pi, or set maxRetries to 0.`
    );
  }
  const branch = branchStrategy.type === "branch" ? branchStrategy.branch : void 0;
  const hostRepoDir = await Effect_exports.runPromise(
    resolveCwd(options.cwd).pipe(Effect_exports.provide(NodeContext_exports.layer))
  );
  if (options.resumeSession) {
    await assertResumeSessionExists({
      provider,
      sandboxTag: options.sandbox.tag,
      hostRepoDir,
      resumeSession: options.resumeSession
    });
  }
  const resolved = await Effect_exports.runPromise(
    resolvePrompt({ prompt, promptFile }).pipe(
      Effect_exports.provide(NodeContext_exports.layer)
    )
  );
  const rawPrompt = resolved.text;
  const isInlinePrompt = resolved.source === "inline";
  if (options.output) {
    const openTag = `<${options.output.tag}>`;
    if (!rawPrompt.includes(openTag)) {
      throw new Error(
        `output tag <${options.output.tag}> not found in the resolved prompt. The caller must instruct the agent to emit the configured tag.`
      );
    }
  }
  const agentName = provider.name;
  const resolvedEnv = await Effect_exports.runPromise(
    resolveEnv(hostRepoDir).pipe(Effect_exports.provide(NodeContext_exports.layer))
  );
  const env = mergeProviderEnv({
    resolvedEnv,
    agentProviderEnv: provider.env,
    sandboxProviderEnv: options.sandbox.env
  });
  const currentHostBranch = await Effect_exports.runPromise(
    getCurrentBranch(hostRepoDir)
  );
  const resolvedBranch = effectiveBranchType === "head" ? currentHostBranch : branch ?? generateTempBranchName(options.name);
  const targetBranch = effectiveBranchType === "merge-to-head" ? currentHostBranch : void 0;
  const resolvedLogging = options.logging ?? {
    type: "file",
    path: join(
      hostRepoDir,
      ".sandcastle",
      "logs",
      buildLogFilename(resolvedBranch, targetBranch, options.name)
    )
  };
  const displayLayer = resolvedLogging.type === "file" ? (() => {
    printFileDisplayStartup({
      logPath: resolvedLogging.path,
      agentName: options.name,
      branch: resolvedBranch,
      hostRepoDir
    });
    return Layer_exports.provide(
      FileDisplay.layer(resolvedLogging.path),
      NodeFileSystem_exports.layer
    );
  })() : ClackDisplay.layer;
  const factoryLayer = Layer_exports.provide(
    WorktreeDockerSandboxFactory.layer,
    Layer_exports.mergeAll(
      Layer_exports.succeed(SandboxConfig, {
        env,
        hostRepoDir,
        copyToWorktree: options.copyToWorktree,
        name: options.name,
        sandboxProvider: options.sandbox,
        branchStrategy,
        hooks,
        signal: options.signal,
        timeouts: options.timeouts
      }),
      NodeFileSystem_exports.layer,
      displayLayer
    )
  );
  const streamEmitterLayer = agentStreamEmitterLayer(
    buildAgentStreamHandler(resolvedLogging)
  );
  const runLayer = Layer_exports.mergeAll(
    factoryLayer,
    displayLayer,
    streamEmitterLayer
  );
  const baseEffect = Effect_exports.gen(function* () {
    const d = yield* Display;
    yield* d.intro(options.name ?? "sandcastle");
    const rows = buildRunSummaryRows({
      name: options.name,
      agentName,
      sandboxName: options.sandbox.name,
      maxIterations,
      branch: resolvedBranch
    });
    yield* d.summary("Sandcastle Run", rows);
    const userArgs = options.promptArgs ?? {};
    let resolvedPrompt;
    if (isInlinePrompt) {
      yield* validateNoArgsWithInlinePrompt(userArgs);
      resolvedPrompt = rawPrompt;
    } else {
      yield* validateNoBuiltInArgOverride(userArgs);
      const effectiveArgs = {
        SOURCE_BRANCH: resolvedBranch,
        TARGET_BRANCH: currentHostBranch,
        ...userArgs
      };
      const builtInArgKeysSet = new Set(BUILT_IN_PROMPT_ARG_KEYS);
      resolvedPrompt = yield* substitutePromptArgs(
        rawPrompt,
        effectiveArgs,
        builtInArgKeysSet
      );
    }
    const orchestrateBranch = effectiveBranchType === "head" ? currentHostBranch : branch;
    const orchestrateResult = yield* orchestrate({
      hostRepoDir,
      iterations: maxIterations,
      hooks,
      prompt: resolvedPrompt,
      branch: orchestrateBranch,
      provider,
      completionSignal: options.completionSignal,
      idleTimeoutSeconds: options.idleTimeoutSeconds,
      completionTimeoutSeconds: options.completionTimeoutSeconds,
      name: options.name,
      resumeSession: options.resumeSession,
      forkSession: options.forkSession,
      signal: options.signal,
      skipPromptExpansion: isInlinePrompt,
      timeouts: options.timeouts
    });
    const completion = buildCompletionMessage(
      orchestrateResult.completionSignal,
      orchestrateResult.iterations.length
    );
    yield* d.status(completion.message, completion.severity);
    for (const line of buildContextWindowLines(orchestrateResult.iterations)) {
      yield* d.text(line);
    }
    return orchestrateResult;
  });
  const withErrorLog = resolvedLogging.type === "file" ? baseEffect.pipe(
    Effect_exports.tapError(
      (error) => Effect_exports.gen(function* () {
        const d = yield* Display;
        yield* d.status(
          formatErrorMessage(error),
          "error"
        );
      })
    )
  ) : baseEffect;
  let result;
  try {
    result = await Effect_exports.runPromise(
      withErrorLog.pipe(Effect_exports.provide(runLayer))
    );
  } catch (error) {
    options.signal?.throwIfAborted();
    throw error;
  }
  const baseResult = {
    ...result,
    logFilePath: resolvedLogging.type === "file" ? resolvedLogging.path : void 0,
    resume: async (prompt2, resumeOptions) => {
      const lastIteration = result.iterations.at(-1);
      if (!lastIteration?.sessionId) {
        throw new Error("Cannot resume: no sessionId was captured");
      }
      return run({
        ...options,
        ...resumeOptions,
        prompt: prompt2,
        promptFile: void 0,
        maxIterations: 1,
        resumeSession: lastIteration.sessionId
      });
    },
    fork: async (prompt2, forkOptions) => {
      const lastIteration = result.iterations.at(-1);
      if (!lastIteration?.sessionId) {
        throw new Error("Cannot fork: no sessionId was captured");
      }
      return run({
        ...options,
        ...forkOptions,
        prompt: prompt2,
        promptFile: void 0,
        maxIterations: 1,
        resumeSession: lastIteration.sessionId,
        forkSession: true
      });
    }
  };
  if (options.output) {
    const lastIteration = baseResult.iterations.at(-1);
    try {
      const output = await extractStructuredOutput(
        baseResult.stdout,
        options.output,
        {
          commits: baseResult.commits,
          branch: baseResult.branch,
          preservedWorktreePath: baseResult.preservedWorktreePath,
          sessionId: lastIteration?.sessionId,
          sessionFilePath: lastIteration?.sessionFilePath
        }
      );
      return { ...baseResult, output };
    } catch (error) {
      if (error instanceof StructuredOutputError && outputMaxRetries > 0 && error.sessionId !== void 0) {
        const retriesRemainingAfter = outputMaxRetries - 1;
        const retryOutput = {
          ...options.output,
          maxRetries: retriesRemainingAfter
        };
        return run({
          ...options,
          prompt: buildStructuredOutputRetryFeedback(
            error,
            retriesRemainingAfter
          ),
          promptFile: void 0,
          promptArgs: void 0,
          resumeSession: error.sessionId,
          forkSession: false,
          output: retryOutput
        });
      }
      throw error;
    }
  }
  return baseResult;
}

// src/raceAbortSignal.ts
var raceAbortSignal = (effect, signal) => {
  if (!signal) return effect;
  return Effect_exports.gen(function* () {
    if (signal.aborted) {
      return yield* Effect_exports.die(signal.reason);
    }
    const abortDeferred = yield* Deferred_exports.make();
    const onAbort = () => {
      Effect_exports.runPromise(Deferred_exports.die(abortDeferred, signal.reason)).catch(
        () => {
        }
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    return yield* Effect_exports.raceFirst(
      effect,
      Deferred_exports.await(abortDeferred)
    ).pipe(
      Effect_exports.ensuring(
        Effect_exports.sync(() => signal.removeEventListener("abort", onAbort))
      )
    );
  });
};

// src/interactive.ts
var interactive = async (options) => {
  options.signal?.throwIfAborted();
  const { prompt, promptFile, hooks, agent: provider } = options;
  const resolvedSandbox = options.sandbox ?? noSandbox();
  const branchStrategy = options.branchStrategy ?? (resolvedSandbox.tag === "isolated" ? { type: "merge-to-head" } : { type: "head" });
  if (branchStrategy.type === "head" && resolvedSandbox.tag === "isolated") {
    throw new Error(
      "head branch strategy is not supported with isolated providers"
    );
  }
  if (branchStrategy.type === "head" && options.copyToWorktree && options.copyToWorktree.length > 0) {
    throw new Error(
      "copyToWorktree is not supported with head branch strategy. In head mode the host working directory is bind-mounted directly."
    );
  }
  if (!provider.buildInteractiveArgs) {
    throw new Error(
      `Agent provider "${provider.name}" does not support buildInteractiveArgs, required for interactive sessions.`
    );
  }
  const branch = branchStrategy.type === "branch" ? branchStrategy.branch : void 0;
  const isHeadMode = branchStrategy.type === "head";
  const sandboxProvider = resolvedSandbox;
  const inner = Effect_exports.gen(function* () {
    const hostRepoDir = yield* resolveCwd(options.cwd);
    const d = yield* Display;
    const hasPromptSource = prompt !== void 0 || promptFile !== void 0;
    const resolved = hasPromptSource ? yield* resolvePrompt({ prompt, promptFile }) : void 0;
    const rawPrompt = resolved?.text ?? "";
    const isInlinePrompt = resolved?.source === "inline";
    const resolvedEnv = yield* resolveEnv(hostRepoDir);
    const env = mergeProviderEnv({
      resolvedEnv,
      agentProviderEnv: provider.env,
      sandboxProviderEnv: sandboxProvider.env
    });
    const effectiveEnv = { ...env, ...options.env ?? {} };
    const currentHostBranch = yield* getCurrentBranch(hostRepoDir);
    const resolvedBranch = branchStrategy.type === "head" ? currentHostBranch : branch ?? generateTempBranchName(options.name);
    let substitutedPrompt = rawPrompt;
    if (hasPromptSource && !isInlinePrompt) {
      const userArgs = options.promptArgs ?? {};
      yield* validateNoBuiltInArgOverride(userArgs);
      const missingKeys = findMissingPromptArgKeys(rawPrompt, userArgs);
      const collectedArgs = {};
      for (const key of missingKeys) {
        const value = yield* Effect_exports.promise(
          () => clack.text({
            message: `Enter value for {{${key}}}`,
            validate: (v) => {
              if (!v) return `A value is required for {{${key}}}`;
            }
          })
        );
        if (clack.isCancel(value)) {
          clack.cancel("Prompt arg collection cancelled.");
          return yield* Effect_exports.fail(
            new Error("User cancelled prompt arg collection")
          );
        }
        collectedArgs[key] = value;
      }
      const mergedUserArgs = { ...userArgs, ...collectedArgs };
      const effectiveArgs = {
        SOURCE_BRANCH: resolvedBranch,
        TARGET_BRANCH: currentHostBranch,
        ...mergedUserArgs
      };
      const builtInArgKeysSet = new Set(BUILT_IN_PROMPT_ARG_KEYS);
      substitutedPrompt = yield* substitutePromptArgs(
        rawPrompt,
        effectiveArgs,
        builtInArgKeysSet
      );
    } else if (isInlinePrompt) {
      const userArgs = options.promptArgs ?? {};
      yield* validateNoArgsWithInlinePrompt(userArgs);
    }
    const lifecycleBranch = isHeadMode ? currentHostBranch : branch;
    yield* d.intro(options.name ?? "sandcastle interactive");
    yield* d.summary("Interactive Session", {
      Agent: options.name ?? provider.name,
      Sandbox: sandboxProvider.name,
      Branch: resolvedBranch
    });
    let worktreeInfo;
    if (!isHeadMode) {
      worktreeInfo = yield* d.taskLog(
        "Creating worktree",
        () => pruneStale(hostRepoDir).pipe(
          Effect_exports.catchAll(() => Effect_exports.void),
          Effect_exports.andThen(
            branch ? create(hostRepoDir, { branch }) : create(hostRepoDir, { name: options.name })
          )
        )
      );
    }
    const handle = yield* Effect_exports.gen(function* () {
      if (!isHeadMode) {
        if ((sandboxProvider.tag === "bind-mount" || sandboxProvider.tag === "none") && options.copyToWorktree && options.copyToWorktree.length > 0) {
          yield* d.taskLog(
            "Copying files to worktree",
            () => copyToWorktree(
              options.copyToWorktree,
              hostRepoDir,
              worktreeInfo.path,
              options.timeouts?.copyToWorktreeMs
            )
          );
        }
        if (hooks?.host?.onWorktreeReady?.length) {
          yield* runHostHooks(hooks.host.onWorktreeReady, worktreeInfo.path);
        }
      } else if (hooks?.host?.onWorktreeReady?.length) {
        yield* runHostHooks(hooks.host.onWorktreeReady, hostRepoDir);
      }
      if (sandboxProvider.tag === "none") {
        const worktreePath = isHeadMode ? hostRepoDir : worktreeInfo.path;
        return yield* Effect_exports.promise(
          () => sandboxProvider.create({
            worktreePath,
            env: effectiveEnv
          })
        );
      } else if (sandboxProvider.tag === "isolated") {
        const startResult = yield* d.taskLog(
          "Starting sandbox",
          () => startSandbox({
            provider: sandboxProvider,
            hostRepoDir: worktreeInfo.path,
            env: effectiveEnv,
            copyPaths: options.copyToWorktree
          })
        );
        return startResult.handle;
      } else {
        const gitPath = join(hostRepoDir, ".git");
        const rawGitMounts = yield* resolveGitMounts(gitPath);
        const worktreeOrRepoPath = isHeadMode ? hostRepoDir : worktreeInfo.path;
        const gitMounts = yield* patchGitMountsForWindows(
          rawGitMounts,
          worktreeOrRepoPath,
          SANDBOX_REPO_DIR
        );
        const startResult = yield* d.taskLog(
          "Starting sandbox",
          () => startSandbox({
            provider: sandboxProvider,
            hostRepoDir,
            env: effectiveEnv,
            worktreeOrRepoPath,
            gitMounts,
            repoDir: SANDBOX_REPO_DIR
          })
        );
        return startResult.handle;
      }
    }).pipe(
      Effect_exports.tapError(
        () => worktreeInfo ? remove(worktreeInfo.path).pipe(
          Effect_exports.catchAll(() => Effect_exports.void)
        ) : Effect_exports.void
      )
    );
    return yield* Effect_exports.gen(function* () {
      if (!handle.interactiveExec) {
        throw new Error(
          `Sandbox provider does not support interactiveExec. The provider must implement the optional interactiveExec method to use interactive().`
        );
      }
      const interactiveExecFn = handle.interactiveExec.bind(handle);
      const sandbox = makeSandboxFromHandle(handle);
      const worktreePath = handle.worktreePath;
      const applyToHost = sandboxProvider.tag === "isolated" && worktreeInfo ? () => syncOut(worktreeInfo.path, handle) : () => Effect_exports.void;
      const lifecycleEffect = withSandboxLifecycle(
        {
          hostRepoDir,
          sandboxRepoDir: worktreePath,
          hooks,
          branch: lifecycleBranch,
          hostWorktreePath: isHeadMode ? hostRepoDir : worktreeInfo?.path,
          applyToHost,
          timeouts: options.timeouts
        },
        sandbox,
        (ctx) => Effect_exports.gen(function* () {
          const fullPrompt = !hasPromptSource || isInlinePrompt ? substitutedPrompt : yield* preprocessPrompt(
            substitutedPrompt,
            ctx.sandbox,
            ctx.sandboxRepoDir
          );
          const interactiveArgs = provider.buildInteractiveArgs({
            prompt: fullPrompt,
            dangerouslySkipPermissions: sandboxProvider.tag !== "none"
          });
          const result2 = yield* raceAbortSignal(
            Effect_exports.promise(
              () => interactiveExecFn(interactiveArgs, {
                stdin: process.stdin,
                stdout: process.stdout,
                stderr: process.stderr,
                cwd: worktreePath
              })
            ),
            options.signal
          );
          return result2.exitCode;
        })
      );
      const lifecycleResult = yield* lifecycleEffect;
      const exitCode = lifecycleResult.result;
      let preservedWorktreePath;
      if (worktreeInfo) {
        const hasUncommitted = yield* hasUncommittedChanges(
          worktreeInfo.path
        ).pipe(Effect_exports.catchAll(() => Effect_exports.succeed(false)));
        if (hasUncommitted) {
          preservedWorktreePath = worktreeInfo.path;
        }
      }
      if (worktreeInfo && !preservedWorktreePath) {
        yield* remove(worktreeInfo.path).pipe(
          Effect_exports.catchAll(() => Effect_exports.void)
        );
      }
      yield* d.summary("Session Complete", {
        Commits: String(lifecycleResult.commits.length),
        Branch: lifecycleResult.branch,
        "Exit code": String(exitCode),
        ...preservedWorktreePath ? { "Preserved worktree": preservedWorktreePath } : {}
      });
      return {
        commits: lifecycleResult.commits,
        branch: lifecycleResult.branch,
        preservedWorktreePath,
        exitCode
      };
    }).pipe(
      // On error, always clean up worktree (on success, handled above with preserve check)
      Effect_exports.tapError(
        () => worktreeInfo ? remove(worktreeInfo.path).pipe(
          Effect_exports.catchAll(() => Effect_exports.void)
        ) : Effect_exports.void
      ),
      // Always close sandbox handle
      Effect_exports.ensuring(Effect_exports.promise(() => handle.close().catch(() => {
      })))
    );
  });
  let result;
  try {
    result = await Effect_exports.runPromise(
      inner.pipe(
        Effect_exports.provide(ClackDisplay.layer),
        Effect_exports.provide(NodeContext_exports.layer),
        Effect_exports.provide(NodeFileSystem_exports.layer)
      )
    );
  } catch (error) {
    options.signal?.throwIfAborted();
    throw error;
  }
  return result;
};
var buildSandboxHandle = (ctx, close) => {
  const {
    branch,
    worktreePath,
    hostRepoDir,
    sandboxRepoDir,
    sandbox,
    providerHandle,
    bindMountHandle,
    applyToHost,
    timeouts,
    branchStrategy
  } = ctx;
  const mergeToHead = branchStrategy?.type === "merge-to-head";
  const sandboxHandle = {
    branch,
    worktreePath,
    run: async (runOptions) => {
      runOptions.signal?.throwIfAborted();
      const {
        agent: provider,
        prompt,
        promptFile,
        maxIterations = 1
      } = runOptions;
      if (runOptions.resumeSession && maxIterations > 1) {
        throw new Error(
          "resumeSession cannot be combined with maxIterations > 1. Resume applies to iteration 1 only; multi-iteration resume semantics are not supported."
        );
      }
      if (runOptions.forkSession && !runOptions.resumeSession) {
        throw new Error(
          "forkSession requires resumeSession. Use sandboxRunResult.fork(prompt) to fork the most recent captured session."
        );
      }
      if (runOptions.resumeSession) {
        await assertResumeSessionExists({
          provider,
          sandboxTag: ctx.providerTag,
          hostRepoDir,
          resumeSession: runOptions.resumeSession
        });
      }
      const resolved = await Effect_exports.runPromise(
        resolvePrompt({ prompt, promptFile }).pipe(
          Effect_exports.provide(NodeContext_exports.layer)
        )
      );
      const rawPrompt = resolved.text;
      const isInlinePrompt = resolved.source === "inline";
      const userArgs = runOptions.promptArgs ?? {};
      const currentHostBranch = await Effect_exports.runPromise(
        getCurrentBranch(hostRepoDir)
      );
      const displayRef = Ref_exports.unsafeMake([]);
      const silentDisplayLayer = SilentDisplay.layer(displayRef);
      const resolvedPrompt = await Effect_exports.runPromise(
        Effect_exports.gen(function* () {
          if (isInlinePrompt) {
            yield* validateNoArgsWithInlinePrompt(userArgs);
            return rawPrompt;
          }
          yield* validateNoBuiltInArgOverride(userArgs);
          const effectiveArgs = {
            SOURCE_BRANCH: branch,
            TARGET_BRANCH: currentHostBranch,
            ...userArgs
          };
          const builtInArgKeysSet = new Set(BUILT_IN_PROMPT_ARG_KEYS);
          return yield* substitutePromptArgs(
            rawPrompt,
            effectiveArgs,
            builtInArgKeysSet
          );
        }).pipe(Effect_exports.provide(silentDisplayLayer))
      );
      const resolvedLogging = runOptions.logging ?? {
        type: "file",
        path: join(
          hostRepoDir,
          ".sandcastle",
          "logs",
          buildLogFilename(branch, void 0, runOptions.name)
        )
      };
      const runDisplayLayer = resolvedLogging.type === "file" ? (() => {
        printFileDisplayStartup({
          logPath: resolvedLogging.path,
          agentName: runOptions.name,
          branch
        });
        return Layer_exports.provide(
          FileDisplay.layer(resolvedLogging.path),
          NodeFileSystem_exports.layer
        );
      })() : silentDisplayLayer;
      const reuseFactoryLayer = Layer_exports.succeed(SandboxFactory, {
        withSandbox: (makeEffect) => makeEffect(
          {
            hostWorktreePath: worktreePath,
            sandboxRepoPath: sandboxRepoDir,
            applyToHost,
            bindMountHandle
          },
          sandbox
        ).pipe(
          Effect_exports.map((value) => ({
            value,
            preservedWorktreePath: void 0
          }))
        )
      });
      const streamEmitterLayer = agentStreamEmitterLayer(
        buildAgentStreamHandler(resolvedLogging)
      );
      const runLayer = Layer_exports.mergeAll(
        reuseFactoryLayer,
        runDisplayLayer,
        streamEmitterLayer
      );
      let result;
      try {
        result = await Effect_exports.runPromise(
          Effect_exports.gen(function* () {
            const display = yield* Display;
            yield* display.intro(runOptions.name ?? "sandcastle");
            const orchestrateResult = yield* orchestrate({
              hostRepoDir,
              iterations: maxIterations,
              prompt: resolvedPrompt,
              branch: mergeToHead ? void 0 : branch,
              provider,
              completionSignal: runOptions.completionSignal,
              idleTimeoutSeconds: runOptions.idleTimeoutSeconds,
              completionTimeoutSeconds: runOptions.completionTimeoutSeconds,
              name: runOptions.name,
              resumeSession: runOptions.resumeSession,
              forkSession: runOptions.forkSession,
              signal: runOptions.signal,
              skipPromptExpansion: isInlinePrompt,
              timeouts,
              keepSourceBranch: mergeToHead
            });
            const completion = buildCompletionMessage(
              orchestrateResult.completionSignal,
              orchestrateResult.iterations.length
            );
            yield* display.status(completion.message, completion.severity);
            for (const line of buildContextWindowLines(
              orchestrateResult.iterations
            )) {
              yield* display.text(line);
            }
            return orchestrateResult;
          }).pipe(Effect_exports.provide(runLayer))
        );
      } catch (error) {
        runOptions.signal?.throwIfAborted();
        throw error;
      }
      const baseResult = {
        iterations: result.iterations,
        completionSignal: result.completionSignal,
        stdout: result.stdout,
        commits: result.commits,
        logFilePath: resolvedLogging.type === "file" ? resolvedLogging.path : void 0
      };
      const lastIteration = result.iterations.at(-1);
      if (provider.sessionStorage && lastIteration?.sessionId) {
        const capturedSessionId = lastIteration.sessionId;
        return {
          ...baseResult,
          resume: (nextPrompt, resumeOptions) => sandboxHandle.run({
            ...runOptions,
            ...resumeOptions,
            prompt: nextPrompt,
            promptFile: void 0,
            maxIterations: 1,
            resumeSession: capturedSessionId
          }),
          fork: (nextPrompt, forkOptions) => sandboxHandle.run({
            ...runOptions,
            ...forkOptions,
            prompt: nextPrompt,
            promptFile: void 0,
            maxIterations: 1,
            resumeSession: capturedSessionId,
            forkSession: true
          })
        };
      }
      return baseResult;
    },
    interactive: async (interactiveOptions) => {
      interactiveOptions.signal?.throwIfAborted();
      const { agent: provider, prompt, promptFile } = interactiveOptions;
      if (!provider.buildInteractiveArgs) {
        throw new Error(
          `Agent provider "${provider.name}" does not support buildInteractiveArgs, required for interactive sessions.`
        );
      }
      if (!providerHandle?.interactiveExec) {
        throw new Error(
          `Sandbox provider does not support interactiveExec. The provider must implement the optional interactiveExec method to use interactive().`
        );
      }
      const interactiveExecFn = providerHandle.interactiveExec.bind(providerHandle);
      let lifecycleResult;
      try {
        lifecycleResult = await Effect_exports.runPromise(
          Effect_exports.gen(function* () {
            const resolved = yield* resolvePrompt({ prompt, promptFile });
            const rawPrompt = resolved.text;
            const isInlinePrompt = resolved.source === "inline";
            const userArgs = interactiveOptions.promptArgs ?? {};
            const currentHostBranch = yield* getCurrentBranch(hostRepoDir);
            let resolvedPrompt;
            if (isInlinePrompt) {
              yield* validateNoArgsWithInlinePrompt(userArgs);
              resolvedPrompt = rawPrompt;
            } else {
              yield* validateNoBuiltInArgOverride(userArgs);
              const effectiveArgs = {
                SOURCE_BRANCH: branch,
                TARGET_BRANCH: currentHostBranch,
                ...userArgs
              };
              const builtInArgKeysSet = new Set(
                BUILT_IN_PROMPT_ARG_KEYS
              );
              resolvedPrompt = yield* substitutePromptArgs(
                rawPrompt,
                effectiveArgs,
                builtInArgKeysSet
              );
            }
            return yield* withSandboxLifecycle(
              {
                hostRepoDir,
                sandboxRepoDir,
                branch: mergeToHead ? void 0 : branch,
                hostWorktreePath: worktreePath,
                applyToHost,
                timeouts,
                keepSourceBranch: mergeToHead
              },
              sandbox,
              (ctx2) => Effect_exports.gen(function* () {
                const fullPrompt = isInlinePrompt ? resolvedPrompt : yield* preprocessPrompt(
                  resolvedPrompt,
                  ctx2.sandbox,
                  ctx2.sandboxRepoDir
                );
                const interactiveArgs = provider.buildInteractiveArgs({
                  prompt: fullPrompt,
                  dangerouslySkipPermissions: true
                });
                const execPromise = interactiveExecFn(interactiveArgs, {
                  stdin: process.stdin,
                  stdout: process.stdout,
                  stderr: process.stderr,
                  cwd: sandboxRepoDir
                });
                const signal = interactiveOptions.signal;
                const result = yield* Effect_exports.promise(() => {
                  if (!signal) return execPromise;
                  if (signal.aborted) return Promise.reject(signal.reason);
                  return new Promise(
                    (resolve, reject) => {
                      const onAbort = () => reject(signal.reason);
                      signal.addEventListener("abort", onAbort, {
                        once: true
                      });
                      execPromise.then(
                        (r) => {
                          signal.removeEventListener("abort", onAbort);
                          resolve(r);
                        },
                        (e) => {
                          signal.removeEventListener("abort", onAbort);
                          reject(e);
                        }
                      );
                    }
                  );
                });
                return result.exitCode;
              })
            );
          }).pipe(
            Effect_exports.provide(ClackDisplay.layer),
            Effect_exports.provide(NodeContext_exports.layer)
          )
        );
      } catch (error) {
        interactiveOptions.signal?.throwIfAborted();
        throw error;
      }
      return {
        commits: lifecycleResult.commits,
        exitCode: lifecycleResult.result
      };
    },
    exec: async (command, options) => {
      const mergedOptions = { cwd: sandboxRepoDir, ...options };
      if (providerHandle) {
        return providerHandle.exec(command, mergedOptions);
      }
      return Effect_exports.runPromise(sandbox.exec(command, mergedOptions));
    },
    close: async () => close(),
    [Symbol.asyncDispose]: async () => {
      await sandboxHandle.close();
    }
  };
  return sandboxHandle;
};
var createSandboxFromWorktree = async (options) => {
  const { branch, worktreePath, hostRepoDir } = options;
  const isTestMode = !!options._test?.buildSandbox;
  if (options.copyToWorktree && options.copyToWorktree.length > 0 && options.sandbox.tag !== "isolated") {
    await Effect_exports.runPromise(
      copyToWorktree(
        options.copyToWorktree,
        hostRepoDir,
        worktreePath,
        options.timeouts?.copyToWorktreeMs
      )
    );
  }
  let providerHandle;
  let sandbox;
  let sandboxRepoDir;
  const isIsolated = options.sandbox.tag === "isolated";
  if (isTestMode) {
    sandbox = options._test.buildSandbox(worktreePath);
    sandboxRepoDir = worktreePath;
    providerHandle = options._test.bindMountHandle;
  } else {
    const resolvedEnv = await Effect_exports.runPromise(
      resolveEnv(hostRepoDir).pipe(Effect_exports.provide(NodeContext_exports.layer))
    );
    const env = mergeProviderEnv({
      resolvedEnv,
      agentProviderEnv: {},
      sandboxProviderEnv: options.sandbox.env
    });
    const provider = options.sandbox;
    let startEffect;
    if (provider.tag === "isolated") {
      startEffect = startSandbox({
        provider,
        hostRepoDir: worktreePath,
        env,
        copyPaths: options.copyToWorktree
      });
    } else if (provider.tag === "none") {
      startEffect = startSandbox({
        provider,
        hostRepoDir,
        env,
        worktreeOrRepoPath: worktreePath
      });
    } else {
      startEffect = resolveGitMounts(join(hostRepoDir, ".git")).pipe(
        Effect_exports.provide(NodeFileSystem_exports.layer),
        Effect_exports.catchAll(() => Effect_exports.succeed([])),
        // Patch git mounts for Windows worktree compatibility (ADR-0006)
        Effect_exports.flatMap(
          (gitMounts) => patchGitMountsForWindows(gitMounts, worktreePath, SANDBOX_REPO_DIR)
        ),
        Effect_exports.flatMap(
          (gitMounts) => startSandbox({
            provider,
            hostRepoDir,
            env,
            worktreeOrRepoPath: worktreePath,
            gitMounts,
            repoDir: SANDBOX_REPO_DIR
          })
        )
      );
    }
    const startResult = await Effect_exports.runPromise(startEffect);
    providerHandle = startResult.handle;
    sandbox = startResult.sandbox;
    sandboxRepoDir = startResult.worktreePath;
  }
  const sandboxOnReady = options.hooks?.sandbox?.onSandboxReady;
  const hostOnReady = options.hooks?.host?.onSandboxReady;
  if (sandboxOnReady?.length || hostOnReady?.length) {
    await Effect_exports.runPromise(
      Effect_exports.gen(function* () {
        yield* sandbox.exec(
          `git config --global --add safe.directory "${sandboxRepoDir}"`
        );
        const sandboxEffects = (sandboxOnReady ?? []).map(
          (hook) => sandbox.exec(hook.command, {
            cwd: sandboxRepoDir,
            sudo: hook.sudo
          })
        );
        const allEffects = [...sandboxEffects];
        if (hostOnReady?.length) {
          allEffects.push(runHostHooks(hostOnReady, worktreePath));
        }
        yield* Effect_exports.all(allEffects, {
          concurrency: "unbounded"
        });
      })
    );
  }
  const applyToHost = isIsolated && providerHandle ? () => syncOut(worktreePath, providerHandle) : () => Effect_exports.void;
  let closed = false;
  const bindMountHandle = options.sandbox.tag === "bind-mount" ? providerHandle : void 0;
  return buildSandboxHandle(
    {
      branch,
      worktreePath,
      hostRepoDir,
      sandboxRepoDir,
      sandbox,
      providerHandle,
      bindMountHandle,
      providerTag: options.sandbox.tag,
      applyToHost,
      timeouts: options.timeouts,
      branchStrategy: options.branchStrategy
    },
    async () => {
      if (closed) return { preservedWorktreePath: void 0 };
      closed = true;
      if (providerHandle) await providerHandle.close();
      return { preservedWorktreePath: void 0 };
    }
  );
};
var createSandbox = async (options) => {
  const { branch } = options;
  const isTestMode = !!options._test?.buildSandbox;
  const isIsolated = options.sandbox.tag === "isolated";
  const { hostRepoDir, worktreePath, providerHandle, sandbox, sandboxRepoDir } = await Effect_exports.runPromise(
    Effect_exports.gen(function* () {
      const hostRepoDir2 = yield* resolveCwd(options.cwd);
      yield* pruneStale(hostRepoDir2).pipe(
        Effect_exports.catchAll(() => Effect_exports.void)
      );
      const { path: worktreePath2 } = yield* create(
        hostRepoDir2,
        { branch, baseBranch: options.baseBranch }
      );
      const prepared = yield* Effect_exports.gen(function* () {
        if (options.copyToWorktree && options.copyToWorktree.length > 0 && options.sandbox.tag !== "isolated") {
          yield* copyToWorktree(
            options.copyToWorktree,
            hostRepoDir2,
            worktreePath2,
            options.timeouts?.copyToWorktreeMs
          );
        }
        if (options.hooks?.host?.onWorktreeReady?.length) {
          yield* runHostHooks(
            options.hooks.host.onWorktreeReady,
            worktreePath2
          );
        }
        let providerHandle2;
        let sandbox2;
        let sandboxRepoDir2;
        if (isTestMode) {
          sandbox2 = options._test.buildSandbox(worktreePath2);
          sandboxRepoDir2 = worktreePath2;
          providerHandle2 = options._test.bindMountHandle;
        } else {
          const resolvedEnv = yield* resolveEnv(hostRepoDir2);
          const env = mergeProviderEnv({
            resolvedEnv,
            agentProviderEnv: {},
            sandboxProviderEnv: options.sandbox.env
          });
          const provider = options.sandbox;
          const startResult = yield* provider.tag === "isolated" ? startSandbox({
            provider,
            hostRepoDir: worktreePath2,
            env,
            copyPaths: options.copyToWorktree
          }) : provider.tag === "none" ? startSandbox({
            provider,
            hostRepoDir: hostRepoDir2,
            env,
            worktreeOrRepoPath: worktreePath2
          }) : resolveGitMounts(join(hostRepoDir2, ".git")).pipe(
            Effect_exports.provide(NodeFileSystem_exports.layer),
            Effect_exports.catchAll(() => Effect_exports.succeed([])),
            // Patch git mounts for Windows worktree compatibility (ADR-0006)
            Effect_exports.flatMap(
              (gitMounts) => patchGitMountsForWindows(
                gitMounts,
                worktreePath2,
                SANDBOX_REPO_DIR
              )
            ),
            Effect_exports.flatMap(
              (gitMounts) => startSandbox({
                provider,
                hostRepoDir: hostRepoDir2,
                env,
                worktreeOrRepoPath: worktreePath2,
                gitMounts,
                repoDir: SANDBOX_REPO_DIR
              })
            )
          );
          providerHandle2 = startResult.handle;
          sandbox2 = startResult.sandbox;
          sandboxRepoDir2 = startResult.worktreePath;
        }
        const sandboxOnReady = options.hooks?.sandbox?.onSandboxReady;
        const hostOnReady = options.hooks?.host?.onSandboxReady;
        if (sandboxOnReady?.length || hostOnReady?.length) {
          yield* Effect_exports.gen(function* () {
            yield* sandbox2.exec(
              `git config --global --add safe.directory "${sandboxRepoDir2}"`
            );
            const sandboxEffects = (sandboxOnReady ?? []).map(
              (hook) => sandbox2.exec(hook.command, {
                cwd: sandboxRepoDir2,
                sudo: hook.sudo
              })
            );
            const allEffects = [...sandboxEffects];
            if (hostOnReady?.length) {
              allEffects.push(runHostHooks(hostOnReady, worktreePath2));
            }
            yield* Effect_exports.all(allEffects, { concurrency: "unbounded" });
          }).pipe(
            Effect_exports.onError(
              () => providerHandle2 ? Effect_exports.promise(
                () => providerHandle2.close().catch(() => {
                })
              ) : Effect_exports.void
            )
          );
        }
        return { providerHandle: providerHandle2, sandbox: sandbox2, sandboxRepoDir: sandboxRepoDir2 };
      }).pipe(
        Effect_exports.onError(
          () => remove(worktreePath2).pipe(
            Effect_exports.catchAll(() => Effect_exports.void)
          )
        )
      );
      return { hostRepoDir: hostRepoDir2, worktreePath: worktreePath2, ...prepared };
    }).pipe(Effect_exports.provide(NodeContext_exports.layer))
  );
  const applyToHost = isIsolated && providerHandle ? () => syncOut(worktreePath, providerHandle) : () => Effect_exports.void;
  let closed = false;
  const forceCleanup = () => {
    console.error(`
Worktree preserved at ${worktreePath}`);
    console.error(`  To review: cd ${worktreePath}`);
    console.error(`  To clean up: git worktree remove --force ${worktreePath}`);
  };
  const unregisterShutdown = registerShutdown(forceCleanup);
  const doClose = async () => {
    if (closed) return { preservedWorktreePath: void 0 };
    closed = true;
    return Effect_exports.runPromise(
      Effect_exports.gen(function* () {
        if (providerHandle) {
          yield* Effect_exports.promise(() => providerHandle.close());
        }
        const isDirty = yield* hasUncommittedChanges(
          worktreePath
        ).pipe(Effect_exports.catchAll(() => Effect_exports.succeed(false)));
        if (isDirty) {
          return { preservedWorktreePath: worktreePath };
        }
        yield* remove(worktreePath).pipe(
          Effect_exports.catchAll(() => Effect_exports.void)
        );
        return { preservedWorktreePath: void 0 };
      })
    );
  };
  const bindMountHandle = options.sandbox.tag === "bind-mount" ? providerHandle : void 0;
  return buildSandboxHandle(
    {
      branch,
      worktreePath,
      hostRepoDir,
      sandboxRepoDir,
      sandbox,
      providerHandle,
      bindMountHandle,
      providerTag: options.sandbox.tag,
      applyToHost,
      timeouts: options.timeouts
    },
    async () => {
      unregisterShutdown();
      return doClose();
    }
  );
};
var createWorktree = async (options) => {
  const branch = options.branchStrategy.type === "branch" ? options.branchStrategy.branch : void 0;
  const baseBranch = options.branchStrategy.type === "branch" ? options.branchStrategy.baseBranch : void 0;
  const isMergeToHead = options.branchStrategy.type === "merge-to-head";
  const { hostRepoDir, worktreeInfo } = await Effect_exports.gen(function* () {
    const hostRepoDir2 = yield* resolveCwd(options.cwd);
    yield* pruneStale(hostRepoDir2).pipe(
      Effect_exports.catchAll(() => Effect_exports.void)
    );
    const info = yield* create(hostRepoDir2, {
      branch,
      baseBranch
    });
    if (options.copyToWorktree && options.copyToWorktree.length > 0) {
      yield* copyToWorktree(
        options.copyToWorktree,
        hostRepoDir2,
        info.path,
        options.timeouts?.copyToWorktreeMs
      );
    }
    if (options.hooks?.host?.onWorktreeReady?.length) {
      yield* runHostHooks(options.hooks.host.onWorktreeReady, info.path);
    }
    return { hostRepoDir: hostRepoDir2, worktreeInfo: info };
  }).pipe(Effect_exports.provide(NodeContext_exports.layer), Effect_exports.runPromise);
  let closed = false;
  const close = async () => {
    if (closed) return { preservedWorktreePath: void 0 };
    closed = true;
    return Effect_exports.gen(function* () {
      const isDirty = yield* hasUncommittedChanges(
        worktreeInfo.path
      ).pipe(Effect_exports.catchAll(() => Effect_exports.succeed(false)));
      if (isDirty) {
        return { preservedWorktreePath: worktreeInfo.path };
      }
      yield* remove(worktreeInfo.path).pipe(
        Effect_exports.catchAll(() => Effect_exports.void)
      );
      return { preservedWorktreePath: void 0 };
    }).pipe(Effect_exports.runPromise);
  };
  const worktreeInteractive = async (opts) => {
    opts.signal?.throwIfAborted();
    const { prompt, promptFile, hooks, agent: provider } = opts;
    const resolvedSandbox = opts.sandbox ?? noSandbox();
    if (!provider.buildInteractiveArgs) {
      throw new Error(
        `Agent provider "${provider.name}" does not support buildInteractiveArgs, required for interactive sessions.`
      );
    }
    const inner = Effect_exports.gen(function* () {
      const d = yield* Display;
      const hasPromptSource = prompt !== void 0 || promptFile !== void 0;
      const resolved = hasPromptSource ? yield* resolvePrompt({ prompt, promptFile }) : void 0;
      const rawPrompt = resolved?.text ?? "";
      const isInlinePrompt = resolved?.source === "inline";
      const resolvedEnv = yield* resolveEnv(hostRepoDir);
      const env = mergeProviderEnv({
        resolvedEnv,
        agentProviderEnv: provider.env,
        sandboxProviderEnv: resolvedSandbox.env
      });
      const effectiveEnv = { ...env, ...opts.env ?? {} };
      let substitutedPrompt = rawPrompt;
      if (hasPromptSource && !isInlinePrompt) {
        const userArgs = opts.promptArgs ?? {};
        yield* validateNoBuiltInArgOverride(userArgs);
        const effectiveArgs = {
          SOURCE_BRANCH: worktreeInfo.branch,
          TARGET_BRANCH: worktreeInfo.branch,
          ...userArgs
        };
        const builtInArgKeysSet = new Set(BUILT_IN_PROMPT_ARG_KEYS);
        substitutedPrompt = yield* substitutePromptArgs(
          rawPrompt,
          effectiveArgs,
          builtInArgKeysSet
        );
      } else if (isInlinePrompt) {
        yield* validateNoArgsWithInlinePrompt(opts.promptArgs ?? {});
      }
      yield* d.intro(opts.name ?? "sandcastle interactive");
      yield* d.summary("Interactive Session", {
        Agent: opts.name ?? provider.name,
        Sandbox: resolvedSandbox.name,
        Branch: worktreeInfo.branch
      });
      let handle;
      if (resolvedSandbox.tag === "none") {
        handle = yield* Effect_exports.promise(
          () => resolvedSandbox.create({
            worktreePath: worktreeInfo.path,
            env: effectiveEnv
          })
        );
      } else if (resolvedSandbox.tag === "isolated") {
        const startResult = yield* d.taskLog(
          "Starting sandbox",
          () => startSandbox({
            provider: resolvedSandbox,
            hostRepoDir: worktreeInfo.path,
            env: effectiveEnv
          })
        );
        handle = startResult.handle;
      } else {
        const gitPath = join(hostRepoDir, ".git");
        const rawGitMounts = yield* resolveGitMounts(gitPath);
        const gitMounts = yield* patchGitMountsForWindows(
          rawGitMounts,
          worktreeInfo.path,
          SANDBOX_REPO_DIR
        );
        const startResult = yield* d.taskLog(
          "Starting sandbox",
          () => startSandbox({
            provider: resolvedSandbox,
            hostRepoDir,
            env: effectiveEnv,
            worktreeOrRepoPath: worktreeInfo.path,
            gitMounts,
            repoDir: SANDBOX_REPO_DIR
          })
        );
        handle = startResult.handle;
      }
      return yield* Effect_exports.gen(function* () {
        if (!handle.interactiveExec) {
          throw new Error(
            `Sandbox provider does not support interactiveExec. The provider must implement the optional interactiveExec method to use interactive().`
          );
        }
        const interactiveExecFn = handle.interactiveExec.bind(handle);
        const sandbox = makeSandboxFromHandle(handle);
        const worktreePath = handle.worktreePath;
        const applyToHost = resolvedSandbox.tag === "isolated" ? () => syncOut(worktreeInfo.path, handle) : () => Effect_exports.void;
        const lifecycleEffect = withSandboxLifecycle(
          {
            hostRepoDir,
            sandboxRepoDir: worktreePath,
            hooks,
            // merge-to-head: pass `undefined` so the lifecycle records the
            // host's current branch and merges the worktree's commits back into
            // it. branch strategy: pin to the worktree's branch.
            branch: isMergeToHead ? void 0 : worktreeInfo.branch,
            hostWorktreePath: worktreeInfo.path,
            applyToHost,
            timeouts: options.timeouts,
            keepSourceBranch: isMergeToHead
          },
          sandbox,
          (ctx) => Effect_exports.gen(function* () {
            const fullPrompt = !hasPromptSource || isInlinePrompt ? substitutedPrompt : yield* preprocessPrompt(
              substitutedPrompt,
              ctx.sandbox,
              ctx.sandboxRepoDir
            );
            const interactiveArgs = provider.buildInteractiveArgs({
              prompt: fullPrompt,
              dangerouslySkipPermissions: resolvedSandbox.tag !== "none"
            });
            const result = yield* raceAbortSignal(
              Effect_exports.promise(
                () => interactiveExecFn(interactiveArgs, {
                  stdin: process.stdin,
                  stdout: process.stdout,
                  stderr: process.stderr,
                  cwd: worktreePath
                })
              ),
              opts.signal
            );
            return result.exitCode;
          })
        );
        const lifecycleResult = yield* lifecycleEffect;
        const exitCode = lifecycleResult.result;
        yield* d.summary("Session Complete", {
          Commits: String(lifecycleResult.commits.length),
          Branch: lifecycleResult.branch,
          "Exit code": String(exitCode)
        });
        return {
          commits: lifecycleResult.commits,
          branch: lifecycleResult.branch,
          preservedWorktreePath: void 0,
          exitCode
        };
      }).pipe(
        // Always close sandbox handle
        Effect_exports.ensuring(Effect_exports.promise(() => handle.close().catch(() => {
        })))
      );
    });
    try {
      return await Effect_exports.runPromise(
        inner.pipe(
          Effect_exports.provide(ClackDisplay.layer),
          Effect_exports.provide(NodeContext_exports.layer),
          Effect_exports.provide(NodeFileSystem_exports.layer)
        )
      );
    } catch (error) {
      opts.signal?.throwIfAborted();
      throw error;
    }
  };
  const worktreeRun = async (opts) => {
    opts.signal?.throwIfAborted();
    const { prompt, promptFile, hooks, agent: provider } = opts;
    const sandboxProvider = opts.sandbox;
    const maxIterations = opts.maxIterations ?? 1;
    if (opts.resumeSession && maxIterations > 1) {
      throw new Error(
        "resumeSession cannot be combined with maxIterations > 1. Resume applies to iteration 1 only; multi-iteration resume semantics are not supported."
      );
    }
    if (opts.resumeSession) {
      await assertResumeSessionExists({
        provider,
        sandboxTag: sandboxProvider.tag,
        hostRepoDir,
        resumeSession: opts.resumeSession
      });
    }
    const inner = Effect_exports.gen(function* () {
      const resolved = yield* resolvePrompt({ prompt, promptFile });
      const rawPrompt = resolved.text;
      const isInlinePrompt = resolved.source === "inline";
      const resolvedEnv = yield* resolveEnv(hostRepoDir);
      const env = mergeProviderEnv({
        resolvedEnv,
        agentProviderEnv: provider.env,
        sandboxProviderEnv: sandboxProvider.env
      });
      const effectiveEnv = { ...env, ...opts.env ?? {} };
      const userArgs = opts.promptArgs ?? {};
      let resolvedPrompt;
      if (isInlinePrompt) {
        yield* validateNoArgsWithInlinePrompt(userArgs);
        resolvedPrompt = rawPrompt;
      } else {
        yield* validateNoBuiltInArgOverride(userArgs);
        const effectiveArgs = {
          SOURCE_BRANCH: worktreeInfo.branch,
          TARGET_BRANCH: worktreeInfo.branch,
          ...userArgs
        };
        const builtInArgKeysSet = new Set(BUILT_IN_PROMPT_ARG_KEYS);
        resolvedPrompt = yield* substitutePromptArgs(
          rawPrompt,
          effectiveArgs,
          builtInArgKeysSet
        );
      }
      let handle;
      let sandboxRepoDir;
      if (sandboxProvider.tag === "isolated") {
        const startResult = yield* startSandbox({
          provider: sandboxProvider,
          hostRepoDir: worktreeInfo.path,
          env: effectiveEnv
        });
        handle = startResult.handle;
        sandboxRepoDir = startResult.worktreePath;
      } else if (sandboxProvider.tag === "none") {
        const startResult = yield* startSandbox({
          provider: sandboxProvider,
          hostRepoDir,
          env: effectiveEnv,
          worktreeOrRepoPath: worktreeInfo.path
        });
        handle = startResult.handle;
        sandboxRepoDir = startResult.worktreePath;
      } else {
        const gitPath = join(hostRepoDir, ".git");
        const rawGitMounts = yield* resolveGitMounts(gitPath);
        const gitMounts = yield* patchGitMountsForWindows(
          rawGitMounts,
          worktreeInfo.path,
          SANDBOX_REPO_DIR
        );
        const startResult = yield* startSandbox({
          provider: sandboxProvider,
          hostRepoDir,
          env: effectiveEnv,
          worktreeOrRepoPath: worktreeInfo.path,
          gitMounts,
          repoDir: SANDBOX_REPO_DIR
        });
        handle = startResult.handle;
        sandboxRepoDir = startResult.worktreePath;
      }
      const sandbox = makeSandboxFromHandle(handle);
      const applyToHost = sandboxProvider.tag === "isolated" ? () => syncOut(worktreeInfo.path, handle) : () => Effect_exports.void;
      const resolvedLogging = opts.logging ?? {
        type: "file",
        path: join(
          hostRepoDir,
          ".sandcastle",
          "logs",
          buildLogFilename(worktreeInfo.branch, void 0, opts.name)
        )
      };
      const runDisplayLayer = resolvedLogging.type === "file" ? (() => {
        printFileDisplayStartup({
          logPath: resolvedLogging.path,
          agentName: opts.name,
          branch: worktreeInfo.branch
        });
        return Layer_exports.provide(
          FileDisplay.layer(resolvedLogging.path),
          NodeFileSystem_exports.layer
        );
      })() : ClackDisplay.layer;
      const bindMountHandle = sandboxProvider.tag === "bind-mount" ? handle : void 0;
      const reuseFactoryLayer = Layer_exports.succeed(SandboxFactory, {
        withSandbox: (makeEffect) => makeEffect(
          {
            hostWorktreePath: worktreeInfo.path,
            sandboxRepoPath: sandboxRepoDir,
            applyToHost,
            bindMountHandle
          },
          sandbox
        ).pipe(
          Effect_exports.map((value) => ({
            value,
            preservedWorktreePath: void 0
          }))
        )
      });
      const streamEmitterLayer = agentStreamEmitterLayer(
        buildAgentStreamHandler(resolvedLogging)
      );
      const runLayer = Layer_exports.mergeAll(
        reuseFactoryLayer,
        runDisplayLayer,
        streamEmitterLayer
      );
      const result = yield* Effect_exports.gen(function* () {
        const display = yield* Display;
        yield* display.intro(opts.name ?? "sandcastle");
        const orchestrateResult = yield* orchestrate({
          hostRepoDir,
          iterations: maxIterations,
          hooks,
          prompt: resolvedPrompt,
          // merge-to-head: pass `undefined` so the lifecycle records the host's
          // current branch and routes through the merge step. branch strategy:
          // pin to the worktree's branch so commits stay there.
          branch: isMergeToHead ? void 0 : worktreeInfo.branch,
          provider,
          completionSignal: opts.completionSignal,
          idleTimeoutSeconds: opts.idleTimeoutSeconds,
          completionTimeoutSeconds: opts.completionTimeoutSeconds,
          name: opts.name,
          resumeSession: opts.resumeSession,
          signal: opts.signal,
          skipPromptExpansion: isInlinePrompt,
          timeouts: options.timeouts,
          keepSourceBranch: isMergeToHead
        });
        const completion = buildCompletionMessage(
          orchestrateResult.completionSignal,
          orchestrateResult.iterations.length
        );
        yield* display.status(completion.message, completion.severity);
        for (const line of buildContextWindowLines(
          orchestrateResult.iterations
        )) {
          yield* display.text(line);
        }
        return orchestrateResult;
      }).pipe(
        Effect_exports.provide(runLayer),
        // Always close sandbox handle
        Effect_exports.ensuring(Effect_exports.promise(() => handle.close().catch(() => {
        })))
      );
      return {
        iterations: result.iterations,
        completionSignal: result.completionSignal,
        stdout: result.stdout,
        commits: result.commits,
        branch: result.branch,
        logFilePath: resolvedLogging.type === "file" ? resolvedLogging.path : void 0
      };
    });
    try {
      return await Effect_exports.runPromise(
        inner.pipe(
          Effect_exports.provide(ClackDisplay.layer),
          Effect_exports.provide(NodeContext_exports.layer),
          Effect_exports.provide(NodeFileSystem_exports.layer)
        )
      );
    } catch (error) {
      opts.signal?.throwIfAborted();
      throw error;
    }
  };
  const worktreeCreateSandbox = async (opts) => {
    return createSandboxFromWorktree({
      branch: worktreeInfo.branch,
      worktreePath: worktreeInfo.path,
      hostRepoDir,
      sandbox: opts.sandbox,
      hooks: opts.hooks,
      copyToWorktree: opts.copyToWorktree,
      timeouts: opts.timeouts,
      branchStrategy: options.branchStrategy,
      _test: opts._test
    });
  };
  return {
    branch: worktreeInfo.branch,
    worktreePath: worktreeInfo.path,
    run: worktreeRun,
    interactive: worktreeInteractive,
    createSandbox: worktreeCreateSandbox,
    close,
    async [Symbol.asyncDispose]() {
      await close();
    }
  };
};
var pathExists = async (path2) => {
  try {
    await access(path2);
    return true;
  } catch {
    return false;
  }
};
var encodeProjectPath = (cwd) => {
  const isRoot = cwd === "/" || /^[A-Za-z]:[\\/]?$/.test(cwd);
  const normalized = isRoot ? cwd : cwd.replace(/[\\/]+$/, "");
  return normalized.replace(/^([A-Za-z]):/, "$1").replace(/[\\/]/g, "-");
};
var claudeHostSessionPath = (cwd, id, projectsDir) => {
  const base = projectsDir ?? join(process.env.HOME ?? "~", ".claude", "projects");
  return join(base, encodeProjectPath(cwd), `${id}.jsonl`);
};
var claudeSandboxSessionPath = (cwd, id, projectsDir) => posix.join(projectsDir, encodeProjectPath(cwd), `${id}.jsonl`);
var claudeSubagentsDirInSandbox = (cwd, id, projectsDir) => posix.join(projectsDir, encodeProjectPath(cwd), id, "subagents");
var claudeSubagentsDirOnHost = (cwd, id, projectsDir) => {
  const base = projectsDir ?? join(process.env.HOME ?? "~", ".claude", "projects");
  return join(base, encodeProjectPath(cwd), id, "subagents");
};
var listClaudeSubagentSessionsInSandbox = async (cwd, id, handle, sandboxProjectsDir) => {
  const dir = claudeSubagentsDirInSandbox(cwd, id, sandboxProjectsDir);
  const result = await handle.exec(
    `find ${JSON.stringify(dir)} -type f -name ${JSON.stringify("agent-*.jsonl")} 2>/dev/null`
  );
  if (result.exitCode !== 0) return [];
  const stdout = result.stdout.trim();
  if (stdout === "") return [];
  return stdout.split("\n").filter((line) => line !== "");
};
var findClaudeSessionOnHost = async (id, projectsDir) => {
  const root = projectsDir ?? join(process.env.HOME ?? "~", ".claude", "projects");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { path: void 0, searchedRoot: root };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, `${id}.jsonl`);
    if (await pathExists(candidate)) {
      return { path: candidate, searchedRoot: root };
    }
  }
  return { path: void 0, searchedRoot: root };
};
var rewriteSessionCwd = (content, fromCwd, toCwd) => {
  if (content === "") return "";
  return content.split("\n").map((line) => {
    if (line === "") return line;
    try {
      const entry = JSON.parse(line);
      if (typeof entry.cwd === "string" && entry.cwd === fromCwd) {
        entry.cwd = toCwd;
      }
      if (entry.type === "session_meta" && typeof entry.payload === "object" && entry.payload !== null && typeof entry.payload.cwd === "string" && entry.payload.cwd === fromCwd) {
        entry.payload.cwd = toCwd;
      }
      return JSON.stringify(entry);
    } catch {
      return line;
    }
  }).join("\n");
};
var transferClaudeSession = (jsonl, fromCwd, toCwd) => rewriteSessionCwd(jsonl, fromCwd, toCwd);
var isCodexSessionFilename = (filename, id) => filename.startsWith("rollout-") && filename.endsWith(`-${id}.jsonl`);
var findCodexSessionPath = async (rootDir, id) => {
  const visit = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return void 0;
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isFile() && isCodexSessionFilename(entry.name, id)) {
        return child;
      }
      if (entry.isDirectory()) {
        const found = await visit(child);
        if (found) return found;
      }
    }
    return void 0;
  };
  return visit(rootDir);
};
var findCodexSessionOnHost = async (id, sessionsDir) => {
  const root = sessionsDir ?? join(process.env.HOME ?? "~", ".codex", "sessions");
  const path2 = await findCodexSessionPath(root, id);
  return { path: path2, searchedRoot: root };
};
var locateCodexHostSession = async (id, sessionsDir) => {
  const root = sessionsDir ?? join(process.env.HOME ?? "~", ".codex", "sessions");
  const path2 = await findCodexSessionPath(root, id);
  if (!path2) throw new Error(`session ${id} not found in ${root}`);
  return { path: path2, relativePath: relative(root, path2) };
};
var locateCodexSandboxSession = async (id, handle, sessionsDir) => {
  const result = await handle.exec(
    `find ${JSON.stringify(sessionsDir)} -type f -name ${JSON.stringify(`rollout-*-${id}.jsonl`)} -print -quit`
  );
  const path2 = result.stdout.trim().split("\n")[0];
  if (result.exitCode !== 0 || !path2) {
    throw new Error(`session ${id} not found in ${sessionsDir}`);
  }
  return { path: path2, relativePath: posix.relative(sessionsDir, path2) };
};
var transferCodexSession = (jsonl, fromCwd, toCwd) => rewriteSessionCwd(jsonl, fromCwd, toCwd);
var encodePiSessionDir = (cwd) => {
  const stripped = cwd.replace(/^[/\\]/, "");
  const replaced = stripped.replace(/[/\\:]/g, "-");
  return `--${replaced}--`;
};
var piSessionDirPath = (cwd, sessionsDir) => {
  const base = sessionsDir ?? join(process.env.HOME ?? "~", ".pi", "agent", "sessions");
  return join(base, encodePiSessionDir(cwd));
};
var isPiSessionFilename = (filename, id) => filename.endsWith(`_${id}.jsonl`);
var findPiSessionPath = async (rootDir, id) => {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return void 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirAbs = join(rootDir, entry.name);
    let files;
    try {
      files = await readdir(dirAbs);
    } catch {
      continue;
    }
    const match = files.find((name) => isPiSessionFilename(name, id));
    if (match) {
      return {
        path: join(dirAbs, match),
        relativePath: join(entry.name, match)
      };
    }
  }
  return void 0;
};
var findPiSessionOnHost = async (id, sessionsDir) => {
  const root = sessionsDir ?? join(process.env.HOME ?? "~", ".pi", "agent", "sessions");
  const found = await findPiSessionPath(root, id);
  return { path: found?.path, searchedRoot: root };
};
var locatePiHostSession = async (id, sessionsDir) => {
  const root = sessionsDir ?? join(process.env.HOME ?? "~", ".pi", "agent", "sessions");
  const found = await findPiSessionPath(root, id);
  if (!found) throw new Error(`session ${id} not found in ${root}`);
  return found;
};
var locatePiSandboxSession = async (id, handle, sessionsDir) => {
  const result = await handle.exec(
    `find ${JSON.stringify(sessionsDir)} -type f -name ${JSON.stringify(`*_${id}.jsonl`)} -print -quit`
  );
  const path2 = result.stdout.trim().split("\n")[0];
  if (result.exitCode !== 0 || !path2) {
    throw new Error(`session ${id} not found in ${sessionsDir}`);
  }
  return { path: path2, relativePath: posix.relative(sessionsDir, path2) };
};
var transferPiSession = (jsonl, fromCwd, toCwd) => {
  if (jsonl === "") return "";
  return jsonl.split("\n").map((line) => {
    if (line === "") return line;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "session" && typeof entry.cwd === "string" && entry.cwd === fromCwd) {
        entry.cwd = toCwd;
        return JSON.stringify(entry);
      }
      return line;
    } catch {
      return line;
    }
  }).join("\n");
};

// src/CwdError.ts
var CwdError2 = CwdError;
var fileExists = async (path2) => {
  try {
    await access(path2);
    return true;
  } catch {
    return false;
  }
};
var shellEscape = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
var TOOL_ARG_FIELDS = {
  Bash: "command",
  WebSearch: "query",
  WebFetch: "url",
  Agent: "description"
};
var extractErrorMessage = (obj) => {
  const err = obj.error;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    if (typeof err.message === "string") return err.message;
    if (typeof err.data?.message === "string") return err.data.message;
  }
  if (typeof obj.message === "string") return obj.message;
  return void 0;
};
var parseStreamJsonLine = (line) => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line);
    if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
      const events = [];
      const texts = [];
      for (const block of obj.message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (block.type === "tool_use" && typeof block.name === "string" && block.input !== void 0) {
          const argField = TOOL_ARG_FIELDS[block.name];
          if (argField === void 0) continue;
          const argValue = block.input[argField];
          if (typeof argValue !== "string") continue;
          if (texts.length > 0) {
            events.push({ type: "text", text: texts.join("") });
            texts.length = 0;
          }
          events.push({
            type: "tool_call",
            name: block.name,
            args: argValue
          });
        }
      }
      if (texts.length > 0) {
        events.push({ type: "text", text: texts.join("") });
      }
      return events;
    }
    if (obj.type === "result" && typeof obj.result === "string") {
      return [{ type: "result", result: obj.result }];
    }
    if (obj.type === "system" && obj.subtype === "init" && typeof obj.session_id === "string") {
      return [{ type: "session_id", sessionId: obj.session_id }];
    }
  } catch {
  }
  return [];
};
var CURSOR_PRINT_PROMPT_MAX_BYTES = 120 * 1024;
function assertCursorPrintPromptFitsArgv(prompt) {
  const n = Buffer.byteLength(prompt, "utf8");
  if (n > CURSOR_PRINT_PROMPT_MAX_BYTES) {
    throw new Error(
      `Cursor print-mode prompt is ${n} bytes (max ${CURSOR_PRINT_PROMPT_MAX_BYTES} bytes). The Cursor CLI accepts the prompt only as a command-line argument; shorten the prompt or split the work. Other Sandcastle providers use stdin for large prompts.`
    );
  }
}
var parseCursorToolCallStarted = (obj) => {
  if (obj.type !== "tool_call" || obj.subtype !== "started") return [];
  const toolCall = obj.tool_call;
  if (!toolCall || typeof toolCall !== "object") return [];
  const tc = toolCall;
  const readToolCall = tc.readToolCall;
  if (readToolCall?.args && typeof readToolCall.args.path === "string") {
    return [{ type: "tool_call", name: "Read", args: readToolCall.args.path }];
  }
  const writeToolCall = tc.writeToolCall;
  if (writeToolCall?.args && typeof writeToolCall.args.path === "string") {
    return [
      { type: "tool_call", name: "Write", args: writeToolCall.args.path }
    ];
  }
  const fn = tc.function;
  if (fn && typeof fn.name === "string") {
    const rawArgs = typeof fn.arguments === "string" ? fn.arguments : "";
    if (rawArgs) {
      try {
        const parsedArgs = JSON.parse(rawArgs);
        if (typeof parsedArgs.command === "string") {
          return [
            { type: "tool_call", name: "Bash", args: parsedArgs.command }
          ];
        }
      } catch {
      }
      return [{ type: "tool_call", name: fn.name, args: rawArgs }];
    }
    return [{ type: "tool_call", name: fn.name, args: "" }];
  }
  return [];
};
var parseCursorStreamLine = (line) => {
  if (!line.startsWith("{")) return [];
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  if (obj.type === "tool_call") {
    return parseCursorToolCallStarted(obj);
  }
  return parseStreamJsonLine(line);
};
var readSandboxFile = async (handle, sandboxPath, tag) => {
  const tmpPath = join(
    tmpdir(),
    `sandcastle-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`
  );
  await handle.copyFileOut(sandboxPath, tmpPath);
  try {
    return await readFile(tmpPath, "utf-8");
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {
    });
  }
};
var writeSandboxFile = async (handle, sandboxPath, content, tag) => {
  const tmpPath = join(
    tmpdir(),
    `sandcastle-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`
  );
  await writeFile(tmpPath, content);
  try {
    await handle.exec(`mkdir -p ${JSON.stringify(posix.dirname(sandboxPath))}`);
    await handle.copyFileIn(tmpPath, sandboxPath);
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {
    });
  }
};
var copyClaudeSessionFile = async ({
  handle,
  sourcePath,
  fromCwd,
  toCwd,
  destPath,
  tag
}) => {
  const jsonl = await readSandboxFile(handle, sourcePath, tag);
  const rewritten = transferClaudeSession(jsonl, fromCwd, toCwd);
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, rewritten);
};
var makeClaudeSessionStorage = (options) => {
  const hostProjectsDir = options?.sessionStorage?.hostProjectsDir;
  const sandboxProjectsDir = options?.sessionStorage?.sandboxProjectsDir ?? "/home/agent/.claude/projects";
  return {
    hostSessionFilePath: (cwd, id) => claudeHostSessionPath(cwd, id, hostProjectsDir),
    existsOnHost: (cwd, id) => fileExists(claudeHostSessionPath(cwd, id, hostProjectsDir)),
    readHostSession: async (cwd, id) => {
      const path2 = claudeHostSessionPath(cwd, id, hostProjectsDir);
      if (!await fileExists(path2)) return void 0;
      return readFile(path2, "utf-8");
    },
    captureToHost: async ({ hostCwd, sandboxCwd, sessionId, handle }) => {
      await copyClaudeSessionFile({
        handle,
        sourcePath: claudeSandboxSessionPath(
          sandboxCwd,
          sessionId,
          sandboxProjectsDir
        ),
        fromCwd: sandboxCwd,
        toCwd: hostCwd,
        destPath: claudeHostSessionPath(hostCwd, sessionId, hostProjectsDir),
        tag: "claude-cap"
      });
      const subagentSandboxPaths = await listClaudeSubagentSessionsInSandbox(
        sandboxCwd,
        sessionId,
        handle,
        sandboxProjectsDir
      );
      const hostSubagentsDir = claudeSubagentsDirOnHost(
        hostCwd,
        sessionId,
        hostProjectsDir
      );
      for (const sandboxSubagentPath of subagentSandboxPaths) {
        try {
          await copyClaudeSessionFile({
            handle,
            sourcePath: sandboxSubagentPath,
            fromCwd: sandboxCwd,
            toCwd: hostCwd,
            destPath: join(
              hostSubagentsDir,
              posix.basename(sandboxSubagentPath)
            ),
            tag: "claude-sub"
          });
        } catch (err) {
          console.error(
            `sandcastle: failed to capture Claude subagent transcript ${sandboxSubagentPath}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    },
    resumeIntoSandbox: async ({ hostCwd, sandboxCwd, sessionId, handle }) => {
      const hostPath = claudeHostSessionPath(
        hostCwd,
        sessionId,
        hostProjectsDir
      );
      const jsonl = await readFile(hostPath, "utf-8");
      const rewritten = transferClaudeSession(jsonl, hostCwd, sandboxCwd);
      const sandboxPath = claudeSandboxSessionPath(
        sandboxCwd,
        sessionId,
        sandboxProjectsDir
      );
      await writeSandboxFile(handle, sandboxPath, rewritten, "claude-res");
    },
    findByIdOnHost: (id) => findClaudeSessionOnHost(id, hostProjectsDir)
  };
};
var makeCodexSessionStorage = (options) => {
  const hostSessionsDir = options?.sessionStorage?.hostSessionsDir;
  const sandboxSessionsDir = options?.sessionStorage?.sandboxSessionsDir ?? posix.join("/home/agent", ".codex", "sessions");
  const capturedPaths = /* @__PURE__ */ new Map();
  return {
    hostSessionFilePath: (_cwd, id) => capturedPaths.get(id),
    existsOnHost: async (_cwd, id) => {
      const found = await findCodexSessionOnHost(id, hostSessionsDir);
      return found.path !== void 0;
    },
    readHostSession: async (_cwd, id) => {
      const found = await findCodexSessionOnHost(id, hostSessionsDir);
      if (!found.path) return void 0;
      return readFile(found.path, "utf-8");
    },
    captureToHost: async ({ hostCwd, sandboxCwd, sessionId, handle }) => {
      const located = await locateCodexSandboxSession(
        sessionId,
        handle,
        sandboxSessionsDir
      );
      const jsonl = await readSandboxFile(handle, located.path, "codex-cap");
      const rewritten = transferCodexSession(jsonl, sandboxCwd, hostCwd);
      const root = hostSessionsDir ?? join(process.env.HOME ?? "~", ".codex", "sessions");
      const target = join(root, located.relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, rewritten);
      capturedPaths.set(sessionId, target);
    },
    resumeIntoSandbox: async ({ hostCwd, sandboxCwd, sessionId, handle }) => {
      const located = await locateCodexHostSession(sessionId, hostSessionsDir);
      const jsonl = await readFile(located.path, "utf-8");
      const rewritten = transferCodexSession(jsonl, hostCwd, sandboxCwd);
      const target = posix.join(sandboxSessionsDir, located.relativePath);
      await writeSandboxFile(handle, target, rewritten, "codex-res");
    },
    findByIdOnHost: (id) => findCodexSessionOnHost(id, hostSessionsDir)
  };
};
var makePiSessionStorage = (options) => {
  const hostSessionsDir = options?.sessionStorage?.hostSessionsDir;
  const sandboxSessionsDir = options?.sessionStorage?.sandboxSessionsDir ?? posix.join("/home/agent", ".pi", "agent", "sessions");
  return {
    hostSessionFilePath: (cwd, _id) => piSessionDirPath(cwd, hostSessionsDir),
    existsOnHost: async (_cwd, id) => {
      const found = await findPiSessionOnHost(id, hostSessionsDir);
      return found.path !== void 0;
    },
    readHostSession: async (_cwd, id) => {
      const found = await findPiSessionOnHost(id, hostSessionsDir);
      if (!found.path) return void 0;
      return readFile(found.path, "utf-8");
    },
    captureToHost: async ({ hostCwd, sandboxCwd, sessionId, handle }) => {
      const located = await locatePiSandboxSession(
        sessionId,
        handle,
        sandboxSessionsDir
      );
      const jsonl = await readSandboxFile(handle, located.path, "pi-cap");
      const rewritten = transferPiSession(jsonl, sandboxCwd, hostCwd);
      const filename = posix.basename(located.path);
      const target = join(piSessionDirPath(hostCwd, hostSessionsDir), filename);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, rewritten);
    },
    resumeIntoSandbox: async ({ hostCwd, sandboxCwd, sessionId, handle }) => {
      const located = await locatePiHostSession(sessionId, hostSessionsDir);
      const jsonl = await readFile(located.path, "utf-8");
      const rewritten = transferPiSession(jsonl, hostCwd, sandboxCwd);
      const filename = located.relativePath.split(/[\\/]/).pop();
      const target = posix.join(
        sandboxSessionsDir,
        encodePiSessionDir(sandboxCwd),
        filename
      );
      await writeSandboxFile(handle, target, rewritten, "pi-res");
    },
    findByIdOnHost: (id) => findPiSessionOnHost(id, hostSessionsDir)
  };
};
var parsePiStreamLine = (line) => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line);
    if (obj.type === "session" && typeof obj.id === "string") {
      return [{ type: "session_id", sessionId: obj.id }];
    }
    if (obj.type === "message_update" && obj.assistantMessageEvent) {
      const evt = obj.assistantMessageEvent;
      if (evt.type === "text_delta" && typeof evt.delta === "string") {
        return [{ type: "text", text: evt.delta }];
      }
      return [];
    }
    if (obj.type === "tool_execution_start") {
      const toolName = obj.toolName;
      if (typeof toolName !== "string") return [];
      const argField = TOOL_ARG_FIELDS[toolName];
      if (argField === void 0) return [];
      const args = obj.args;
      if (!args) return [];
      const argValue = args[argField];
      if (typeof argValue !== "string") return [];
      return [{ type: "tool_call", name: toolName, args: argValue }];
    }
    if (obj.type === "agent_error" || obj.type === "error") {
      const msg = extractErrorMessage(obj);
      return msg ? [{ type: "result", result: msg }] : [];
    }
    if (obj.type === "agent_end" && Array.isArray(obj.messages)) {
      const messages = obj.messages;
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg?.role === "assistant") {
          const texts = [];
          for (const block of msg.content) {
            if (block.type === "text" && typeof block.text === "string") {
              texts.push(block.text);
            }
          }
          if (texts.length > 0) {
            return [{ type: "result", result: texts.join("") }];
          }
          break;
        }
      }
      return [];
    }
  } catch {
  }
  return [];
};
var pi = (model, options) => ({
  name: "pi",
  env: options?.env ?? {},
  captureSessions: options?.captureSessions ?? true,
  sessionStorage: makePiSessionStorage(options),
  buildPrintCommand({
    prompt,
    resumeSession
  }) {
    const thinkingFlag = options?.thinking ? ` --thinking ${options.thinking}` : "";
    const sessionFlag = resumeSession ? ` --session ${shellEscape(resumeSession)}` : "";
    return {
      command: `pi -p --mode json --model ${shellEscape(model)}${thinkingFlag}${sessionFlag}`,
      stdin: prompt
    };
  },
  buildInteractiveArgs({ prompt }) {
    const args = ["pi", "--model", model];
    if (prompt) args.push(prompt);
    return args;
  },
  parseStreamLine(line) {
    return parsePiStreamLine(line);
  }
});
var parseCodexUsage = (usage) => {
  if (typeof usage !== "object" || usage === null) return void 0;
  const u = usage;
  if (typeof u.input_tokens !== "number" || typeof u.cached_input_tokens !== "number" || typeof u.output_tokens !== "number") {
    return void 0;
  }
  return {
    inputTokens: u.input_tokens - u.cached_input_tokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: u.cached_input_tokens,
    outputTokens: u.output_tokens
  };
};
var parseCodexStreamLine = (line) => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line);
    if (obj.type === "thread.started" && typeof obj.thread_id === "string") {
      return [{ type: "session_id", sessionId: obj.thread_id }];
    }
    if (obj.type === "item.completed" && obj.item?.type === "agent_message" && typeof obj.item.text === "string") {
      const text2 = obj.item.text;
      return [
        { type: "text", text: text2 },
        { type: "result", result: text2 }
      ];
    }
    if (obj.type === "item.started" && obj.item?.type === "command_execution" && typeof obj.item.command === "string") {
      return [{ type: "tool_call", name: "Bash", args: obj.item.command }];
    }
    if (obj.type === "error") {
      const msg = extractErrorMessage(obj);
      return msg ? [{ type: "result", result: msg }] : [];
    }
    if (obj.type === "turn.completed") {
      const usage = parseCodexUsage(obj.usage);
      return usage ? [{ type: "usage", usage }] : [];
    }
  } catch {
  }
  return [];
};
var codex = (model, options) => ({
  name: "codex",
  env: options?.env ?? {},
  captureSessions: options?.captureSessions ?? true,
  sessionStorage: makeCodexSessionStorage(options),
  buildPrintCommand({
    prompt,
    resumeSession,
    forkSession
  }) {
    const effortFlag = options?.effort ? ` -c ${shellEscape(`model_reasoning_effort="${options.effort}"`)}` : "";
    const approvalsFlags = options?.approvalsReviewer === "auto_review" ? ` -a on-request -s danger-full-access -c ${shellEscape(`approvals_reviewer="auto_review"`)}` : " --dangerously-bypass-approvals-and-sandbox";
    let base;
    if (resumeSession && forkSession) {
      base = `codex exec fork ${shellEscape(resumeSession)}`;
    } else if (resumeSession) {
      base = `codex exec resume ${shellEscape(resumeSession)}`;
    } else {
      base = "codex exec";
    }
    const stdinArg = resumeSession ? " -" : "";
    return {
      command: `${base} --json${approvalsFlags} -m ${shellEscape(model)}${effortFlag}${stdinArg}`,
      stdin: prompt
    };
  },
  buildInteractiveArgs({ prompt }) {
    const args = ["codex", "--model", model];
    if (prompt) args.push(prompt);
    return args;
  },
  parseStreamLine(line) {
    return parseCodexStreamLine(line);
  }
});
var cursor = (model, options) => ({
  name: "cursor",
  env: options?.env ?? {},
  captureSessions: false,
  // Cursor has no filesystem-backed session storage (captureSessions: false, no
  // sessionStorage), so it is non-resumable per ADR 0012/0016. resumeSession is
  // ignored here — like pi and opencode — rather than wired to --resume.
  buildPrintCommand({
    prompt,
    dangerouslySkipPermissions
  }) {
    assertCursorPrintPromptFitsArgv(prompt);
    const forceFlag = dangerouslySkipPermissions ? " --force" : "";
    return {
      command: `agent --print --output-format stream-json --model ${shellEscape(model)} ${forceFlag} ${shellEscape(prompt)}`
    };
  },
  buildInteractiveArgs({
    prompt,
    dangerouslySkipPermissions
  }) {
    const args = ["agent", "--model", model];
    if (dangerouslySkipPermissions) args.push("--force");
    if (prompt) args.push(prompt);
    return args;
  },
  parseStreamLine(line) {
    return parseCursorStreamLine(line);
  }
});
var OPENCODE_TOOL_ARG_FIELDS = {
  bash: "command",
  webfetch: "url",
  task: "description"
};
var parseOpenCodeStreamLine = (line) => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line);
    const part = obj.part;
    if (obj.type === "step_start" && typeof obj.sessionID === "string") {
      return [{ type: "session_id", sessionId: obj.sessionID }];
    }
    if (obj.type === "text" && part?.type === "text" && typeof part.text === "string") {
      return [
        { type: "text", text: part.text },
        { type: "result", result: part.text }
      ];
    }
    if (obj.type === "tool_use" && part?.type === "tool") {
      if (typeof part.tool !== "string") return [];
      const state = part.state;
      if (state?.status !== "completed") return [];
      const input = state.input;
      if (!input) return [];
      const argField = OPENCODE_TOOL_ARG_FIELDS[part.tool];
      const argValue = argField !== void 0 ? input[argField] : void 0;
      const args = typeof argValue === "string" ? argValue : JSON.stringify(input);
      return [{ type: "tool_call", name: part.tool, args }];
    }
    if (obj.type === "error") {
      const msg = extractErrorMessage(obj);
      return msg ? [{ type: "result", result: msg }] : [];
    }
  } catch {
  }
  return [];
};
var opencode = (model, options) => ({
  name: "opencode",
  env: options?.env ?? {},
  captureSessions: false,
  buildPrintCommand({
    prompt,
    dangerouslySkipPermissions
  }) {
    const variantFlag = options?.variant ? ` --variant ${shellEscape(options.variant)}` : "";
    const agentFlag = options?.agent ? ` --agent ${shellEscape(options.agent)}` : "";
    const permissionsFlag = dangerouslySkipPermissions ? " --dangerously-skip-permissions" : "";
    return {
      command: `opencode run --format json --model ${shellEscape(model)}${variantFlag}${agentFlag}${permissionsFlag} ${shellEscape(prompt)}`
    };
  },
  buildInteractiveArgs({ prompt }) {
    const args = ["opencode", "--model", model];
    if (options?.agent) args.push("--agent", options.agent);
    if (prompt) args.push("--prompt", prompt);
    return args;
  },
  parseStreamLine(line) {
    return parseOpenCodeStreamLine(line);
  }
});
var COPILOT_PRINT_PROMPT_MAX_BYTES = 120 * 1024;
function assertCopilotPrintPromptFitsArgv(prompt) {
  const n = Buffer.byteLength(prompt, "utf8");
  if (n > COPILOT_PRINT_PROMPT_MAX_BYTES) {
    throw new Error(
      `Copilot print-mode prompt is ${n} bytes (max ${COPILOT_PRINT_PROMPT_MAX_BYTES} bytes). This provider passes the prompt as a command-line argument; shorten the prompt or split the work. Other Sandcastle providers use stdin for large prompts.`
    );
  }
}
var parseCopilotStreamLine = (line) => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line);
    if (obj.type === "assistant.message_delta" && typeof obj.data?.deltaContent === "string") {
      return [{ type: "text", text: obj.data.deltaContent }];
    }
    if (obj.type === "tool.execution_start") {
      const rawName = obj.data?.toolName;
      if (typeof rawName !== "string") return [];
      const toolName = rawName === "bash" ? "Bash" : rawName;
      const argField = TOOL_ARG_FIELDS[toolName];
      if (argField === void 0) return [];
      const args = obj.data?.arguments;
      if (!args) return [];
      const argValue = args[argField];
      if (typeof argValue !== "string") return [];
      return [{ type: "tool_call", name: toolName, args: argValue }];
    }
    if (obj.type === "assistant.message" && typeof obj.data?.content === "string" && obj.data.content.length > 0) {
      return [{ type: "result", result: obj.data.content }];
    }
    if (obj.type === "result" && typeof obj.sessionId === "string") {
      return [{ type: "session_id", sessionId: obj.sessionId }];
    }
    if (obj.type === "error" || obj.type === "agent_error") {
      const msg = extractErrorMessage(obj);
      return msg ? [{ type: "result", result: msg }] : [];
    }
  } catch {
  }
  return [];
};
var copilot = (model, options) => ({
  name: "copilot",
  env: options?.env ?? {},
  captureSessions: false,
  // Copilot CLI does expose `--resume <id>`, but its session state is indexed by
  // a SQLite database alongside the JSONL files in ~/.copilot/session-state/, so
  // transferring a single session file between host and sandbox is not enough to
  // make resume work (see ADR 0016). Until the round-trip is verified end-to-end,
  // copilot is non-resumable: captureSessions is false, there is no sessionStorage,
  // and resumeSession is ignored here — like cursor, pi, and opencode.
  buildPrintCommand({
    prompt,
    dangerouslySkipPermissions
  }) {
    assertCopilotPrintPromptFitsArgv(prompt);
    const allowAll = dangerouslySkipPermissions ? " --allow-all-tools" : "";
    const effortFlag = options?.effort ? ` --effort ${options.effort}` : "";
    return {
      command: `copilot -p ${shellEscape(prompt)} --output-format json --model ${shellEscape(model)}${allowAll}${effortFlag}`
    };
  },
  buildInteractiveArgs({ prompt }) {
    const args = ["copilot", "--model", model];
    if (prompt) args.push("-i", prompt);
    return args;
  },
  parseStreamLine(line) {
    return parseCopilotStreamLine(line);
  }
});
var claudeCode = (model, options) => ({
  name: "claude-code",
  env: options?.env ?? {},
  captureSessions: options?.captureSessions ?? true,
  sessionStorage: makeClaudeSessionStorage(options),
  buildPrintCommand({
    prompt,
    dangerouslySkipPermissions,
    resumeSession,
    forkSession
  }) {
    const permissionFlag = options?.permissionMode ? ` --permission-mode ${options.permissionMode}` : dangerouslySkipPermissions ? " --dangerously-skip-permissions" : "";
    const effortFlag = options?.effort ? ` --effort ${options.effort}` : "";
    const resumeFlag = resumeSession ? ` --resume ${shellEscape(resumeSession)}` : "";
    const forkFlag = resumeSession && forkSession ? " --fork-session" : "";
    const extraArgsFlag = options?.extraArgs?.length ? ` ${options.extraArgs.map((arg) => shellEscape(arg)).join(" ")}` : "";
    return {
      command: `claude --print --verbose${permissionFlag} --output-format stream-json --model ${shellEscape(model)}${effortFlag}${resumeFlag}${forkFlag}${extraArgsFlag} -p -`,
      stdin: prompt
    };
  },
  buildInteractiveArgs({
    prompt,
    dangerouslySkipPermissions
  }) {
    const args = ["claude"];
    if (options?.permissionMode) {
      args.push("--permission-mode", options.permissionMode);
    } else if (dangerouslySkipPermissions) {
      args.push("--dangerously-skip-permissions");
    }
    args.push("--model", model);
    if (options?.effort) args.push("--effort", options.effort);
    if (options?.extraArgs) args.push(...options.extraArgs);
    if (prompt) args.push(prompt);
    return args;
  },
  parseStreamLine(line) {
    return parseStreamJsonLine(line);
  },
  parseSessionUsage(content) {
    const lines = content.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.startsWith("{")) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === "assistant" && obj.message?.usage) {
          const u = obj.message.usage;
          if (typeof u.input_tokens === "number" && typeof u.cache_creation_input_tokens === "number" && typeof u.cache_read_input_tokens === "number" && typeof u.output_tokens === "number") {
            return {
              inputTokens: u.input_tokens,
              cacheCreationInputTokens: u.cache_creation_input_tokens,
              cacheReadInputTokens: u.cache_read_input_tokens,
              outputTokens: u.output_tokens
            };
          }
        }
      } catch {
      }
    }
    return void 0;
  }
});

export { CwdError2 as CwdError, Output, StructuredOutputError, claudeCode, claudeHostSessionPath, claudeSandboxSessionPath, codex, copilot, createSandbox, createWorktree, cursor, encodeProjectPath, findClaudeSessionOnHost, findCodexSessionOnHost, interactive, opencode, pi, run, transferClaudeSession, transferCodexSession };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map