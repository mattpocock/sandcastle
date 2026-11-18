# host() on Windows runs without sh

Status: accepted for the v1 pre-release line. Decided by the maintainer on 2026-11-18: no dependency on Git for Windows' `sh.exe`; bundled tasks on Windows are out of scope; `fakeSandbox()` stays POSIX only ([ADR 0025](0025-v1-testing-entry-point.md)).

## Context

Windows is a supported orchestrator, and the coming `host()` provider runs its sandboxes as folders on the host itself, so on Windows the session supervisor runs on Windows too. Everything core sent through a provider assumed POSIX: the supervisor's agents were `sh -c` in a process group and died by `process.kill(-pid)`, its control channel was a Unix socket file, and the home probe, the supervisor start and the skills install were shell strings with `$HOME`, `&&` and redirects.

Windows has no `sh`. Git for Windows ships one, but not every Windows machine has Git for Windows, and depending on it would make a POSIX shell a hidden requirement of a provider whose point is to run with nothing but Node.

0.x `noSandbox()` already ran Sandcastle's commands on Windows without `sh` (issue #940). Sandcastle builds every command as a POSIX string (agent print commands quote with `shellEscape`), and handing one to `cmd.exe` delivers `'claude-opus-4-8'` with its quotes. So it split a command back into the argv it stands for and launched that directly.

## Decision

Those rules move into v1 core (`src/v1/posixSimpleCommand.ts`, `src/v1/windowsCommand.ts`), behind one host command runner (`src/v1/hostCommand.ts`) that the supervisor uses for its agents and `host()` uses for its commands. On Linux and macOS a command is `sh -c` in a process group of its own, as before. On Windows:

- **A simple command is spawned from its argv.** Simple means optional leading `export K=v;` statements, then words: bare, `'single'`-quoted, `"double"`-quoted with POSIX escapes, and the `\'` `shellEscape` emits. The exports join the command's env. The program is found on `PATH` with `PATHEXT`, the way Windows finds it.
- **An `.exe` gets no shell at all**: Node's own argv quoting carries spaces, quotes, `%`, `^`, `&`, `|` and newlines.
- **A `.cmd` or `.bat`**, such as the `claude` npm installs, can only run under `cmd.exe`. Its command line is escaped with the rules for a batch file that forwards `%*` (as cross-spawn does). `cmd.exe` can't carry a newline in an argument or a line over 8191 characters, so such a command is refused with an error naming the limit rather than cut short. Prompts never meet the limit: the supervisor writes a session's prompt to the agent's stdin.
- **Anything else goes to `cmd.exe` as written.** Pipes, `&&` and `$VAR` mostly fail there, and that is the caller's to avoid.
- **A kill takes the whole tree**, with `taskkill /T /F`. Windows has no process groups and no `kill(-pid)`.

Every command core sends a provider is a simple command, so it runs unchanged on both:

- the home probe is `node -p 'require("node:os").homedir()'`, which also fails, as the old `command -v node` did, when the sandbox has no `node`;
- the supervisor starts as `node supervisor.mjs daemon`, in its directory, and opens `supervisor.log` there itself;
- each request is `node supervisor.mjs call '<file>'`;
- the skills install finds the home with the same `node -p`.

The supervisor joins paths in the flavour of the sandbox's own: a Windows path when its home or working directory is one. Its control channel on Windows is a named pipe ([ADR 0027](0027-v1-session-supervisor-channel.md)).

## Considered options

- **Git for Windows' `sh.exe`.** Rejected: a hidden requirement, missing on machines without Git for Windows, and a second POSIX layer to reason about under every command.
- **Re-quoting each command for `cmd.exe`.** Rejected: `cmd.exe`'s rules differ for builtins, `.exe`s and batch files, and quoting for one breaks another. Spawning the argv sidesteps them for everything but batch files.
- **A Windows-native `fakeSandbox()`.** Not now: the Windows proof runs through a test-only provider on the same runner, and `host()` after it.

## Consequences

- The bundled tasks' commands (`rm -rf`, `{ …; }` git identity) stay POSIX, so bundled tasks need a POSIX provider. A caller's own commands are POSIX strings: on Windows, only simple ones work unchanged.
- An agent's children that outlive their parent leave its tree, and `taskkill /T` can't find them.
- The Windows CI job proves it: a session with structured output, a continued session, a `.cmd` agent and an abort that kills the agent's tree, all on a host with no `sh` on `PATH`.
