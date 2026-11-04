# v1 detach: the deadline, the finish report and its secret

Status: accepted for the v1 pre-release line.

## Context

A remote orchestrator (a serverless function, say) can't stay connected to an hour-long agent run: it must start the run, let go, and be told when it's done. Sandcastle v1 runs every session under the session supervisor inside the sandbox ([ADR 0027](0027-v1-session-supervisor-channel.md)), so letting go means handing the running work to it. Sandcastle sets the sandbox's time limit at create, so it knows the kill time; a run that overruns should be reported before the vendor kills the sandbox, not lost with it.

## Decision

- **`detach()` exists only on a `DetachableSandbox`.** It resolves with a `DetachReceipt { sandboxId, detachId, deadline, carriedOn, reportsTo }` once the supervisor has confirmed it holds the work. Only sessions already spawned carry on; the supervisor refuses new ones after a detach. It rejects with `DetachError`: `nothing-running` (no spawned session is running, checked on the host and again by the supervisor), `awaited-call-pending` (an `exec`, `session`, `spawnSession` or file call on the handle hasn't settled; checked on the host, because the host is the one awaiting it), or `supervisor-unreachable`. After it, every call on the handle, and `wait()`/`kill()` on the carried sessions, rejects with `SandboxDetachedError`, and `close()` does nothing, so `await using` around a detach is safe.
- **The deadline.** The default is the kill time minus a margin of 5 minutes, or a quarter of the time limit when that is shorter, so a seconds-long sandbox (the testing fake's) still gets a deadline before its end. `deadlineMinutes` sets an earlier one, from now, clamped to the default. The host sends the supervisor a duration, not a timestamp, so host and sandbox clocks needn't agree. At the deadline the supervisor kills what is still running; those sessions end with `time-limit`, and the report fails with that reason.
- **The finish report.** When the last carried-on session ends, the supervisor builds one report (`type: "sandcastle.detached.finished"`, `version: 1`, which `verifyFinishReport` checks), writes it to `reports/<detachId>.json` in its directory, then, given a destination, POSTs it as a Standard Webhook: `webhook-id` (the detach id), `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256(key, "id.timestamp.body")>`, signed afresh per attempt. Any answer but 2xx is retried, after the receiver's `Retry-After` when it gives one, else with exponential backoff from 1 second up to 60; 410 Gone stops it; it gives up when the next attempt would land past the kill time. Then the supervisor exits. Its log records the outcome (`written`, `delivered`, `gone`, `gave-up`), never the secret.
- **The secret is sealed.** At start the supervisor makes an RSA key pair in memory and returns the public half in its `hello` reply, which the host reads at `createSandbox`, before any session can run, and keeps. At detach the host seals the secret to it (a fresh AES-256-GCM key encrypts the secret; RSA-OAEP wraps that key) and sends only the sealed value in the request file. Only the supervisor's memory can open it. It never reaches a session's env, a file, argv or a log. This refines ADR 0027's plan, which published the public half as a file: a session running as the same user could have replaced that file.
- **`verifyFinishReport({ body, headers, secret, outputs?, toleranceSeconds? })`** checks the signature (constant-time, any of several `v1,` signatures), then the timestamp (default tolerance 300 seconds, either way), then the body's shape and that its detach id is the `webhook-id`. Given `outputs`, the same `Output` definitions by session name, it validates each named session's output on a succeeded report and types it. Failures are `FinishReportVerificationError` with a `reason`. It uses `node:crypto`, so it runs in Node receivers.

## Considered options

- **A fixed 5-minute margin.** Rejected: with the fake's seconds-long limits, the deadline would be in the past.
- **Sending the deadline as a timestamp.** Rejected: a remote sandbox's clock may disagree with the host's.
- **Test-only backoff settings.** Rejected (no test-only options in the public API): honouring `Retry-After` is standard HTTP, and lets a test receiver ask for an immediate retry.
- **Routing `exec` through the supervisor to detect pending calls there.** Not needed: the host is the one awaiting, so it knows.

## Consequences

- If the vendor kills the sandbox before the report is delivered, nothing is sent: the orchestrator's own wait timeout is the "never heard back" path. The report file is still read by a later `status()`.
- A finish report has `processes: []` until the handle can spawn processes.
- `verifyFinishReport` needs `node:crypto`; edge runtimes would need a Web Crypto variant.
